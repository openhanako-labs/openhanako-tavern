// test/regression-board-prompt.mjs — 端到端：一条设定从「生效」走进聊天
//
// 上游验的是仓储（regression-board）与 HTTP 面（regression-board-routes）；
// 这一份验最后一跳：格子真的进了发给模型的 systemPrompt——**而且落对了位置**。
//
// 这里的核心不是「能不能进去」，是「进在哪一层」。黑板在提示里被拆成两段：
//
//   常驻 + 公开  → 静态前缀的尾巴（同角色逐字节常量 → prefix cache 命中）
//   关键词 / 私密 → 动态尾部（逐轮不同 / 按说话者不同 → 不许污染前缀）
//
// 分错的后果**不报错**，只会安静地每轮砸掉缓存——钱和延迟慢慢漏掉，
// 而所有功能看起来都正常。所以这一条必须钉死。
//
// 顺带钉住的还有三件容易顺手改坏的事：
//   · 「只有你」的格子永远不进 prompt（它不是给模型的）
//   · 关掉的格子不进 prompt
//   · 同一个世界的两次装配，静态前缀逐字节相等（确定性 = 命中的前提）

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { ConversationRepo } = await import("../lib/conversations/repo.js");
const { CharacterRepo } = await import("../lib/characters/repo.js");
const { SettingRepo } = await import("../lib/settings/repo.js");
const { BoardRepo } = await import("../lib/board/repo.js");
const { charVisibility, USER_VISIBILITY } = await import("../lib/board/model.js");
const { buildGenerationInput } = await import("../lib/conversations/pipeline.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 端到端 · 一条设定走进聊天 ===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-board-prompt-"));
const charRepo = new CharacterRepo(tmp); await charRepo.init();
const convRepo = new ConversationRepo(tmp); await convRepo.init();
const settingRepo = new SettingRepo(tmp); await settingRepo.init();
const boardRepo = new BoardRepo(tmp); await boardRepo.init();

const repos = {
  conversationRepo: convRepo,
  characterRepo: charRepo,
  settingRepo,
  regexRepo: null,
  boardRepo
};

const PREFIX_MARK = "## 世界 · 常驻";
const TAIL_MARK = "## 世界 · 本轮";
const LORE_MARK = "## 世界设定";

const card = await charRepo.create({ name: "薇拉", description: "守夜法师", first_mes: "「又是你。」" });
const other = await charRepo.create({ name: "露娜", description: "值班员", first_mes: "「在。」" });
const conv = await convRepo.create(card.id);

/**
 * 静态前缀 = 第一个动态标记之前的所有字节。
 *
 * 要剥掉末尾的分隔符：尾部自带它前面的那个 `\n\n`（见 pipeline.js 的注释）。
 * 不剥的话，量到的是「前缀 + 分隔符」，而分隔符是随尾巴出现的——
 * 会把「前缀稳不稳」这条断言变成假的。
 */
function staticPrefixOf(sp) {
  const marks = [LORE_MARK, TAIL_MARK].map(m => sp.indexOf(m)).filter(i => i >= 0);
  if (!marks.length) return sp;
  return sp.slice(0, Math.min(...marks)).replace(/\n\n$/, "");
}

async function build(input, character = card, convId = conv.id) {
  await convRepo.addMessage(convId, "user", input);
  const fresh = await convRepo.get(convId);
  return buildGenerationInput(repos, fresh, character, input, {});
}

// ── 1. 常驻公开格：进静态前缀 ──
await okAsync("常驻公开格进静态前缀（不掺进动态尾部）", async () => {
  await boardRepo.createCell({
    title: "月台尽头", body: "站台的灯忽明忽暗，风里有铁锈味。",
    lifespan: "chat", visible: "public", activation: "constant", order: 10
  }, conv.id);

  const { systemPrompt, meta } = await build("我到了。");
  assert.ok(systemPrompt.includes("站台的灯忽明忽暗"), "内容没进提示");
  assert.ok(systemPrompt.includes(PREFIX_MARK), "没有常驻段标题");
  assert.ok(systemPrompt.indexOf(PREFIX_MARK) < staticPrefixOf(systemPrompt).length + 1, "常驻段应在静态前缀里");
  assert.strictEqual(systemPrompt.includes(TAIL_MARK), false, "常驻格不该出现在动态尾部");
  assert.strictEqual(meta.boardPrefixCount, 1);
  assert.strictEqual(meta.boardTailCount, 0);
});

// ── 2. 关键词格：不命中不在，命中进动态尾部 ──
await okAsync("关键词格：不命中不在提示里，命中进动态尾部", async () => {
  await boardRepo.createCell({
    title: "末班车", body: "末班车 23:40 发车。",
    lifespan: "chat", visible: "public", activation: "keyword", keywords: ["末班车"], order: 20
  }, conv.id);

  const cold = await build("今天天气不错。");
  assert.ok(!cold.systemPrompt.includes("23:40"), "没命中关键词却进了提示");
  assert.strictEqual(cold.meta.boardTailCount, 0);

  const hot = await build("广播说末班车要开了。");
  assert.ok(hot.systemPrompt.includes("23:40"), "命中关键词却没进提示");
  assert.ok(hot.systemPrompt.includes(TAIL_MARK), "命中的关键词格应在动态尾部");
  assert.strictEqual(hot.meta.boardTailCount, 1, "应记进尾部计数");
});

// ── 3. 命不命中，静态前缀不许动 ──
await okAsync("关键词命中/不命中 → 静态前缀逐字节不变", async () => {
  // 用一条**干净的历史**。扫描窗口是「最近 8 条消息 + 当前输入」，
  // 上一场测试里出现过的关键词会一直躺在窗口里继续命中——
  // 那不是 bug，是世界书的老规矩；但会让这条断言假绿。
  const conv2 = await convRepo.create(card.id);

  await boardRepo.createCell({
    title: "哨塔", body: "北境哨塔共七座，薇拉守的是第七塔。",
    lifespan: "chat", visible: "public", activation: "constant", order: 10
  }, conv2.id);
  await boardRepo.createCell({
    title: "霜语血脉", body: "霜语一族生来能看见结界的裂痕。",
    lifespan: "chat", visible: "public", activation: "keyword", keywords: ["霜花"], order: 20
  }, conv2.id);

  const cold = await build("今晚没什么事。", card, conv2.id);
  assert.ok(!cold.systemPrompt.includes("结界的裂痕"), "没命中关键词却上场了");

  const hot = await build("她指尖的霜花碎了。", card, conv2.id);
  assert.ok(hot.systemPrompt.includes("结界的裂痕"), "命中关键词却没上场");
  assert.notStrictEqual(cold.systemPrompt, hot.systemPrompt, "两次装配应该有差别");

  // 最锋利的那一条：无尾巴那次的整串，应当是有尾巴那次的**字面前缀**。
  // 这才是缓存真正依赖的性质——provider 比的是最长公共前缀。
  assert.ok(
    hot.systemPrompt.startsWith(cold.systemPrompt),
    "有尾巴时，无尾巴那次的内容不是它的字节前缀——前缀跟着尾巴动了"
  );

  assert.strictEqual(
    staticPrefixOf(cold.systemPrompt),
    staticPrefixOf(hot.systemPrompt),
    "关键词格咬进了静态前缀——前缀一断，缓存全废"
  );
});

// ── 4. 私密格：进动态尾部，且只对那个角色 ──
await okAsync("私密格进动态尾部；换个角色就看不见", async () => {
  await boardRepo.createCell({
    title: "她的心事", body: "他碰到我了。别回头。",
    lifespan: "chat", visible: charVisibility(card.id), activation: "constant", order: 30
  }, conv.id);

  const hers = await build("在想什么？");
  assert.ok(hers.systemPrompt.includes("别回头"), "她自己看不见自己的私密格");
  assert.ok(hers.systemPrompt.includes(TAIL_MARK), "私密格应在动态尾部");
  assert.ok(!staticPrefixOf(hers.systemPrompt).includes("别回头"), "私密格漏进了静态前缀——那是所有角色共享的那一段");

  const others = await build("在想什么？", other);
  assert.ok(!others.systemPrompt.includes("别回头"), "私密格泄漏给了别的角色");
});

// ── 5. 「只有你」的格子永不进 prompt ──
await okAsync("「只有你」的格子不进 prompt（它不是给模型的）", async () => {
  await boardRepo.createCell({
    title: "我要做的事", body: "今晚试探她的底线。",
    lifespan: "chat", visible: USER_VISIBILITY, activation: "constant", order: 40
  }, conv.id);

  const { systemPrompt } = await build("继续。");
  assert.ok(!systemPrompt.includes("试探她的底线"), "「只有你」的格子被发给了模型");
});

// ── 6. 关掉的格子不进 prompt ──
await okAsync("关掉的格子不进 prompt，开回来又进", async () => {
  const cell = await boardRepo.createCell({
    title: "临时封条", body: "此门已封。",
    lifespan: "chat", visible: "public", activation: "constant", order: 50
  }, conv.id);

  assert.ok((await build("门呢？")).systemPrompt.includes("此门已封"), "刚建的格子应当在场");

  await boardRepo.toggleCell(cell.id, false, conv.id);
  assert.ok(!(await build("门呢？")).systemPrompt.includes("此门已封"), "关掉了还在场");

  await boardRepo.toggleCell(cell.id, true, conv.id);
  assert.ok((await build("门呢？")).systemPrompt.includes("此门已封"), "开回来不在场");
});

// ── 7. 确定性：同世界的两次装配，前缀逐字节相等 ──
await okAsync("同一批格子两次装配 → 静态前缀逐字节相等", async () => {
  const a = await build("第一句。");
  const b = await build("第二句。");
  assert.strictEqual(staticPrefixOf(a.systemPrompt), staticPrefixOf(b.systemPrompt));
});

// ── 8. 改公共格 → 前缀变（唯一允许失效的时点） ──
await okAsync("改掉公共格 → 前缀跟着变（改一次只失效一次）", async () => {
  const before = (await build("看一眼。")).systemPrompt;
  const cells = await boardRepo.listChatCells(conv.id);
  const target = cells.find(c => c.title === "月台尽头");
  assert.ok(target, "没找到要改的格子");

  await boardRepo.updateCell(target.id, { body: "站台的灯亮着，铁锈味还在。" }, conv.id);

  const after = (await build("再看一眼。")).systemPrompt;
  assert.notStrictEqual(staticPrefixOf(before), staticPrefixOf(after), "改了公共格前缀却没变——那说明它根本没进前缀");
  assert.ok(after.includes("铁锈味还在"), "改后的内容没生效");
});

// ── 9. 顺序稳定：order 决定位置，且两次一致 ──
await okAsync("同 order 下顺序稳定（标题字典序兜底）", async () => {
  const { systemPrompt } = await build("排一下。");
  const a = systemPrompt.indexOf("月台尽头");
  const b = systemPrompt.indexOf("临时封条");
  assert.ok(a >= 0 && b >= 0, "两格都该在");
  assert.ok(a < b, `order 10 应在 order 50 之前（实际 ${a} vs ${b}）`);

  const again = (await build("再排一下。")).systemPrompt;
  assert.strictEqual(staticPrefixOf(systemPrompt), staticPrefixOf(again), "两次顺序不一致");
});

// ── 10. 没有黑板仓储时不该炸（老调用方兼容） ──
await okAsync("repos 里没有 boardRepo 时照常工作（不炸、无黑板段）", async () => {
  const fresh = await convRepo.get(conv.id);
  const r = await buildGenerationInput(
    { conversationRepo: convRepo, characterRepo: charRepo, settingRepo, regexRepo: null },
    fresh, card, "没有黑板。", {}
  );
  assert.ok(typeof r.systemPrompt === "string" && r.systemPrompt.length > 0);
  assert.ok(!r.systemPrompt.includes(PREFIX_MARK), "没给仓储却出现了黑板段");
  assert.strictEqual(r.meta.boardCount, 0);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
