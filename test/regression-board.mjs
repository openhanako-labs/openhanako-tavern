// test/regression-board.mjs — 黑板数据层的黄金断言
//
// 黑板一格带三个正交标签：寿命 / 可见 / 激活。六件事必须钉死：
//   1. 新建的格子自带三项，默认值确定
//   2. 寿命决定落哪块盘：world → 全局文件，chat → 对话文件
//   3. 可见性 fail closed：不认识的取值一律不可见（私密格泄漏是最不能犯的错）
//   4. char:<id> 只对那一个角色可见；user 只对用户可见
//   5. 激活两种：常驻总在；关键词只在命中时在；enabled=false 一律不在
//   6. 老对话文件（没有 boardCells 字段）读得出来，不炸
// 少了任何一条，黑板都会慢慢退化成"又一个设定库"。

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { BoardRepo } = await import("../lib/board/repo.js");
const {
  BoardLifespan, BoardActivation, USER_VISIBILITY, charVisibility,
  normalizeBoardCell, isVisibleTo, cellApplies
} = await import("../lib/board/model.js");
const { ConversationRepo } = await import("../lib/conversations/repo.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 黑板数据层 ===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-board-"));
const repo = new BoardRepo(tmp);
await repo.init();

const convRepo = new ConversationRepo(tmp);
await convRepo.init();
const charRepo = await (async () => {
  const { CharacterRepo } = await import("../lib/characters/repo.js");
  const r = new CharacterRepo(tmp); await r.init(); return r;
})();

const card = await charRepo.create({ name: "薇拉", description: "守夜法师", first_mes: "「又是你。」" });
const other = await charRepo.create({ name: "露娜", description: "值班员", first_mes: "「薇拉？」" });
const conv = await convRepo.create(card.id);

// 场景 1：新建自带三项
await okAsync("新建的格子自带 lifespan / visible / activation", async () => {
  const cell = await repo.createCell({ title: "月台尽头", body: "站台的灯忽明忽暗" }, conv.id);
  assert.strictEqual(cell.lifespan, BoardLifespan.CHAT);
  assert.strictEqual(cell.visible, "public");
  assert.strictEqual(cell.activation, BoardActivation.KEYWORD);
  assert.strictEqual(cell.enabled, true);
  assert.ok(cell.id, "必须有 id");
});

// 场景 2：寿命决定落哪块盘
await okAsync("world 级落全局文件，chat 级落对话文件", async () => {
  const w = await repo.createCell({ title: "极北", lifespan: BoardLifespan.WORLD });
  const c = await repo.createCell({ title: "这一场的雾", lifespan: BoardLifespan.CHAT }, conv.id);

  const worldFile = JSON.parse(fs.readFileSync(path.join(tmp, "board-cells.json"), "utf8"));
  assert.ok(worldFile.some(x => x.id === w.id), "world 级应在全局文件里");
  assert.ok(!worldFile.some(x => x.id === c.id), "chat 级不应出现在全局文件里");

  const convFile = JSON.parse(fs.readFileSync(path.join(tmp, "conversations", `${conv.id}.json`), "utf8"));
  assert.ok((convFile.boardCells || []).some(x => x.id === c.id), "chat 级应在对话文件的 boardCells 里");
});

// 场景 3：可见性 fail closed
await okAsync("不认识的可见性 → 一律不可见（fail closed）", async () => {
  const weird = normalizeBoardCell({ title: "怪东西", visible: "director-only" });
  assert.strictEqual(isVisibleTo(weird, {}), false, "用户视角不可见");
  assert.strictEqual(isVisibleTo(weird, { characterId: card.id }), false, "角色视角也不可见");

  // 注意：normalize 不能把不认识的可见性"修正"成 public——那等于把私密变公开
  assert.strictEqual(weird.visible, "director-only", "原样保留，由 isVisibleTo 判死");
});

// 场景 4：char:<id> 与 user
await okAsync("char:<id> 只对那一个角色可见；user 只对用户可见", async () => {
  const hers = normalizeBoardCell({ title: "她的心事", visible: charVisibility(card.id) });
  assert.strictEqual(isVisibleTo(hers, { characterId: card.id }), true, "她自己看得见");
  assert.strictEqual(isVisibleTo(hers, { characterId: other.id }), false, "别人看不见");
  assert.strictEqual(isVisibleTo(hers, {}), false, "用户视角看不见");

  const mine = normalizeBoardCell({ title: "你的事", visible: USER_VISIBILITY });
  assert.strictEqual(isVisibleTo(mine, {}), true, "用户看得见");
  assert.strictEqual(isVisibleTo(mine, { characterId: card.id }), false, "角色看不见");
});

// 场景 5：激活三态
await okAsync("常驻总在；关键词只命中时在；enabled=false 一律不在", async () => {
  const constant = normalizeBoardCell({ title: "底色", activation: BoardActivation.CONSTANT });
  assert.strictEqual(cellApplies(constant, { text: "随便说点什么" }), true);

  const kw = normalizeBoardCell({ title: "列车时刻", activation: BoardActivation.KEYWORD, keywords: ["列车", "月台"] });
  assert.strictEqual(cellApplies(kw, { text: "广播里的列车" }), true, "命中关键词应上场");
  assert.strictEqual(cellApplies(kw, { text: "今天天气不错" }), false, "没命中就不上场");
  assert.strictEqual(cellApplies(kw, { text: "" }), false, "空文本不命中");

  const off = normalizeBoardCell({ title: "关掉的", activation: BoardActivation.CONSTANT, enabled: false });
  assert.strictEqual(cellApplies(off, { text: "列车" }), false, "关掉的格子一律不上场");
});

// 场景 6：老对话文件不炸
await okAsync("老对话文件（没有 boardCells）读得出来，不炸", async () => {
  const legacyConv = await convRepo.create(card.id);
  const file = path.join(tmp, "conversations", `${legacyConv.id}.json`);
  const before = fs.readFileSync(file, "utf8");

  const cells = await repo.listChatCells(legacyConv.id);
  assert.deepStrictEqual(cells, [], "没有 boardCells 时返回空数组");

  const merged = await repo.listCells(legacyConv.id);
  assert.ok(Array.isArray(merged), "合并列表也要能出来");

  assert.strictEqual(fs.readFileSync(file, "utf8"), before, "读取不应改写对话文件");
});

// 场景 7：开关与搬家
await okAsync("toggle 取反；寿命改了会搬家", async () => {
  const cell = await repo.createCell({ title: "临时", lifespan: BoardLifespan.CHAT }, conv.id);
  const off = await repo.toggleCell(cell.id, null, conv.id);
  assert.strictEqual(off.enabled, false, "toggle 应取反");

  const moved = await repo.updateCell(cell.id, { lifespan: BoardLifespan.WORLD }, conv.id);
  assert.strictEqual(moved.lifespan, BoardLifespan.WORLD);

  const worldFile = JSON.parse(fs.readFileSync(path.join(tmp, "board-cells.json"), "utf8"));
  assert.ok(worldFile.some(x => x.id === cell.id), "改寿命后应落在全局文件");
  const convFile = JSON.parse(fs.readFileSync(path.join(tmp, "conversations", `${conv.id}.json`), "utf8"));
  assert.ok(!(convFile.boardCells || []).some(x => x.id === cell.id), "旧盘上不应留着");
});

// 场景 8：局部更新不得动可见性
// （这条要是漏了，改一下标题就能把私密格变成公开）
await okAsync("局部更新不碰可见性：改标题后私密格仍是私密", async () => {
  const hers = await repo.createCell({
    title: "她的心事",
    body: "他碰到我了。别回头。",
    visible: charVisibility(card.id),
    lifespan: BoardLifespan.CHAT
  }, conv.id);

  const renamed = await repo.updateCell(hers.id, { title: "她的心事（改）" }, conv.id);
  assert.strictEqual(renamed.visible, charVisibility(card.id), "可见性不能被顺手改成 public");
  assert.strictEqual(renamed.body, "他碰到我了。别回头。", "其他字段也不能丢");
  assert.strictEqual(renamed.title, "她的心事（改）", "改了的那项要生效");

  const back = await repo.getCell(hers.id, conv.id);
  assert.strictEqual(back.visible, charVisibility(card.id), "从盘上读回来也还是私密");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
