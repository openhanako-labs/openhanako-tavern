// test/regression-greeting.mjs — 开场白播种
//
// 这组测试锁住「角色卡的开场白不该白写」：
// 过去建完对话是空的，要用户先开口。现在 first_mes 自动成为第一条消息，
// 多个开场白时随机选一条、其余存为变体（swipe 可切）。

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { ConversationRepo } = await import("../lib/conversations/repo.js");
const { CharacterRepo } = await import("../lib/characters/repo.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 开场白播种回归 ===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-greet-"));
const charRepo = new CharacterRepo(tmp);
await charRepo.init();
const convRepo = new ConversationRepo(tmp);
await convRepo.init();

/**
 * 复刻 routes 里的播种逻辑。
 * 这里不去起 HTTP 服务——逻辑本身是可测的，测行为即可。
 */
async function seedGreeting(convId, characterId) {
  const card = await charRepo.get(characterId);
  if (!card) return null;
  const primary = String(card.first_mes || "").trim();
  const alternates = (Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [])
    .map(s => String(s || "").trim()).filter(Boolean);
  if (!primary && alternates.length === 0) return null;

  const all = [];
  if (primary) all.push(primary);
  for (const a of alternates) if (!all.includes(a)) all.push(a);
  if (all.length === 0) return null;

  const pick = Math.floor(Math.random() * all.length);
  const msg = await convRepo.addMessage(convId, "assistant", all[pick]);
  if (all.length > 1) await convRepo.setVariants(convId, msg.id, all, pick);
  return msg;
}

await okAsync("单条开场白 → 成为第一条 assistant 消息", async () => {
  const card = await charRepo.create({ name: "A", description: "d", first_mes: "你好，我是A。" });
  const conv = await convRepo.create(card.id);
  await seedGreeting(conv.id, card.id);

  const fresh = await convRepo.get(conv.id);
  assert.strictEqual(fresh.messages.length, 1);
  assert.strictEqual(fresh.messages[0].role, "assistant");
  assert.strictEqual(fresh.messages[0].content, "你好，我是A。");
});

await okAsync("单条开场白不建变体列表（无需 swipe）", async () => {
  const card = await charRepo.create({ name: "B", description: "d", first_mes: "只有一条" });
  const conv = await convRepo.create(card.id);
  await seedGreeting(conv.id, card.id);

  const fresh = await convRepo.get(conv.id);
  const msg = fresh.messages[0];
  assert.ok(!Array.isArray(msg.variants) || msg.variants.length <= 1);
});

await okAsync("多条开场白 → 全部进变体列表", async () => {
  const card = await charRepo.create({
    name: "C", description: "d",
    first_mes: "开场一",
    alternate_greetings: ["开场二", "开场三"]
  });
  const conv = await convRepo.create(card.id);
  await seedGreeting(conv.id, card.id);

  const fresh = await convRepo.get(conv.id);
  const msg = fresh.messages[0];
  assert.strictEqual(msg.variants.length, 3);
  assert.ok(msg.variants.includes("开场一"));
  assert.ok(msg.variants.includes("开场二"));
  assert.ok(msg.variants.includes("开场三"));
});

await okAsync("variantIndex 与 content 始终一致", async () => {
  const card = await charRepo.create({
    name: "D", description: "d",
    first_mes: "甲", alternate_greetings: ["乙", "丙", "丁"]
  });
  const conv = await convRepo.create(card.id);
  await seedGreeting(conv.id, card.id);

  const fresh = await convRepo.get(conv.id);
  const msg = fresh.messages[0];
  assert.strictEqual(msg.content, msg.variants[msg.variantIndex]);
});

await okAsync("随机选择：多次建对话会命中不同开场白", async () => {
  const card = await charRepo.create({
    name: "E", description: "d",
    first_mes: "一", alternate_greetings: ["二", "三", "四", "五", "六"]
  });
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const conv = await convRepo.create(card.id);
    await seedGreeting(conv.id, card.id);
    const fresh = await convRepo.get(conv.id);
    seen.add(fresh.messages[0].content);
  }
  assert.ok(seen.size > 1, `40 次应至少出现两种开场白，实际 ${seen.size} 种`);
});

await okAsync("开场白内容去重", async () => {
  const card = await charRepo.create({
    name: "F", description: "d",
    first_mes: "重复的",
    alternate_greetings: ["重复的", "不同的"]
  });
  const conv = await convRepo.create(card.id);
  await seedGreeting(conv.id, card.id);

  const fresh = await convRepo.get(conv.id);
  const msg = fresh.messages[0];
  assert.strictEqual(msg.variants.length, 2, "重复项应被去掉");
});

/**
 * 直接写一个角色卡文件，绕开 repo 的校验。
 *
 * 用于模拟「导入的卡没有 first_mes」这种真实情况——
 * 校验是建卡时的门槛，但数据层并不禁止空开场白。
 */
function writeRawCard(card) {
  const dir = path.join(tmp, "characters", card.id);
  fs.mkdirSync(dir, { recursive: true });
  const full = { first_mes: "", alternate_greetings: [], ...card };
  fs.writeFileSync(path.join(dir, "card.json"), JSON.stringify(full), "utf8");
  return full;
}

await okAsync("无开场白 → 保持空对话，不报错", async () => {
  const card = writeRawCard({ id: "raw-g", name: "G", description: "d" });
  const conv = await convRepo.create(card.id);
  const r = await seedGreeting(conv.id, card.id);

  assert.strictEqual(r, null);
  const fresh = await convRepo.get(conv.id);
  assert.strictEqual(fresh.messages.length, 0);
});

await okAsync("开场白里的空白被裁掉", async () => {
  const card = await charRepo.create({ name: "H", description: "d", first_mes: "  有内容  " });
  const conv = await convRepo.create(card.id);
  await seedGreeting(conv.id, card.id);

  const fresh = await convRepo.get(conv.id);
  assert.strictEqual(fresh.messages[0].content, "有内容");
});

await okAsync("只有 alternate 没有 first_mes 时也能开场", async () => {
  const card = writeRawCard({
    id: "raw-i", name: "I", description: "d",
    alternate_greetings: ["备用开场"]
  });
  const conv = await convRepo.create(card.id);
  await seedGreeting(conv.id, card.id);

  const fresh = await convRepo.get(conv.id);
  assert.strictEqual(fresh.messages.length, 1);
  assert.strictEqual(fresh.messages[0].content, "备用开场");
});

// ── setVariants 自身 ──
await okAsync("setVariants 拒绝空列表", async () => {
  const card = await charRepo.create({ name: "J", description: "d", first_mes: "x" });
  const conv = await convRepo.create(card.id);
  const msg = await convRepo.addMessage(conv.id, "assistant", "x");
  let threw = false;
  try { await convRepo.setVariants(conv.id, msg.id, []); } catch { threw = true; }
  assert.ok(threw);
});

await okAsync("setVariants 越界下标被夹到合法范围", async () => {
  const card = await charRepo.create({ name: "K", description: "d", first_mes: "x" });
  const conv = await convRepo.create(card.id);
  const msg = await convRepo.addMessage(conv.id, "assistant", "x");

  const updated = await convRepo.setVariants(conv.id, msg.id, ["a", "b"], 99);
  assert.strictEqual(updated.variantIndex, 1);
  assert.strictEqual(updated.content, "b");
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
