// test/regression-media-tool.mjs — tavern_apply_avatar：把本地图片写回角色卡
//
// 这条链的由来：出图有两条腿。宿主媒体面那条由 App 自己走（已通）；
// "用别的 App 出图"（本机 ComfyUI / media_generate-image）那条，产物是 Agent 手上的
// 本地文件，而 App 的头像只能由 App 自己写——中间缺一道缝。
// 这个工具就是那道缝，所以它的判据重点是"**拒得清不清楚**"：
// 路径、类型、大小、扩展名，每一条不合法都要说清是哪一条。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { CharacterRepo } = await import("../lib/characters/repo.js");
const { CharacterTransfer } = await import("../lib/characters/transfer.js");
const { createMediaTools } = await import("../lib/media/tool.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 出图 · 产物写回卡 ===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-mtool-"));
const charRepo = new CharacterRepo(tmp);
await charRepo.init();
const transfer = new CharacterTransfer(charRepo);
const card = await charRepo.create({
  name: "薇拉·霜语", description: "守夜法师", first_mes: "「又是你。」"
});

const tools = createMediaTools({ characterRepo: charRepo, transfer });
const tool = tools.find((t) => t.name === "tavern_apply_avatar");
const call = (args) => tool.handler(args);
const body = (r) => r.content[0].text;

/** 造一张真图片文件（内容无所谓，这一层不校验图片格式）。 */
function makeFile(name, bytes = 64) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, 7));
  return p;
}

await okAsync("① 工具名与形状", () => {
  assert.ok(tool, "没找到 tavern_apply_avatar");
  assert.deepStrictEqual(tool.inputSchema.required, ["characterId", "path"]);
});

await okAsync("② 缺参数 / 卡不存在 → 各自的错", async () => {
  assert.match(body(await call({ path: makeFile("a.png") })), /characterId is required/);
  assert.match(body(await call({ characterId: card.id })), /path is required/);
  assert.match(body(await call({ characterId: "nope", path: makeFile("b.png") })), /Character not found/);
});

await okAsync("③ 相对路径被拒，且话说清要绝对路径", async () => {
  const out = body(await call({ characterId: card.id, path: "out.png" }));
  assert.match(out, /绝对路径/, out);
  assert.match(out, /out\.png/, "该把收到的东西写出来：" + out);
});

await okAsync("④ 文件不存在 / 不是文件 / 空文件 → 三种话说得不一样", async () => {
  const missing = body(await call({ characterId: card.id, path: path.join(tmp, "nope.png") }));
  assert.match(missing, /读不到这个文件/, missing);

  const dir = body(await call({ characterId: card.id, path: tmp }));
  assert.match(dir, /不是一个文件/, dir);

  const empty = path.join(tmp, "empty.png");
  fs.writeFileSync(empty, Buffer.alloc(0));
  const e = body(await call({ characterId: card.id, path: empty }));
  assert.match(e, /空的/, e);
});

await okAsync("⑤ 太大 → 拒绝，并把大小说出来", async () => {
  const big = path.join(tmp, "big.png");
  fs.writeFileSync(big, Buffer.alloc(13 * 1024 * 1024, 1));
  const out = body(await call({ characterId: card.id, path: big }));
  assert.match(out, /文件太大/, out);
  assert.match(out, /13 MB/, "该报出实际大小：" + out);
});

await okAsync("⑥ 正常路径 → 头像真落盘，返回里能核对", async () => {
  const src = makeFile("portrait.png", 128);
  const r = JSON.parse(body(await call({ characterId: card.id, path: src })));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.characterId, card.id);
  assert.strictEqual(r.name, "薇拉·霜语", "该把卡名带回来，调用方能核对写对了卡");
  assert.strictEqual(r.file, "avatar.png");
  assert.strictEqual(r.bytes, 128);
  assert.strictEqual(r.source, src);

  const read = await transfer.readAvatar(card.id);
  assert.ok(read, "读不到头像");
  assert.strictEqual(read.ext, "png");
  assert.strictEqual(read.buffer.length, 128);
});

await okAsync("⑦ 扩展名以落盘为准；怪扩展名当 png", async () => {
  const webp = makeFile("art.webp", 32);
  const r1 = JSON.parse(body(await call({ characterId: card.id, path: webp })));
  assert.strictEqual(r1.file, "avatar.webp");
  assert.strictEqual(r1.avatarExt, "webp");

  const dir = path.join(charRepo.dir, card.id);
  assert.deepStrictEqual(
    fs.readdirSync(dir).filter((f) => f.startsWith("avatar.")),
    ["avatar.webp"],
    "换扩展名该清掉旧文件"
  );

  const evil = makeFile("shot.png.exe", 16);
  const r2 = JSON.parse(body(await call({ characterId: card.id, path: evil })));
  assert.strictEqual(r2.file, "avatar.png", "怪扩展名该被换成 png");
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith(".exe")), "盘上不该出现 .exe");
});

await okAsync("⑧ 没给仓储/转移层 → 说清缺什么（不是静默成功）", async () => {
  const bare = createMediaTools({})[0];
  const out = bare.handler({ characterId: "x", path: "C:\\a.png" }).then(body);
  assert.match(await out, /未就绪/);
});

console.log(`\n${fail === 0 ? "✅" : "❌"} 产物写回卡：${pass} 过 / ${fail} 败\n`);
process.exit(fail === 0 ? 0 : 1);
