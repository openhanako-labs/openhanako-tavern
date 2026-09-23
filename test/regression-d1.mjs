// test/regression-d1.mjs — D1 消息级操作回归
//
// 覆盖：编辑 / 删除单条 / 变体切换 / 截断重生

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

import { ConversationRepo } from "../lib/conversations/repo.js";
import { CharacterRepo } from "../lib/characters/repo.js";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e.message}`);
    failed++;
  }
}

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tavern-d1-"));
let seq = 0;
async function freshConv() {
  const dir = path.join(tmpRoot, `c${seq++}`);
  const repo = new ConversationRepo(dir);
  await repo.init();
  const conv = await repo.create("char-1");
  await repo.addMessage(conv.id, "user", "问一句");
  const a = await repo.addMessage(conv.id, "assistant", "答一句");
  return { repo, convId: conv.id, assistantId: a.id };
}

console.log("\nD1 · 消息级操作\n" + "─".repeat(50));

await test("编辑消息：内容更新 + editedAt 落盘", async () => {
  const { repo, convId, assistantId } = await freshConv();
  const msg = await repo.editMessage(convId, assistantId, "改过的回答");
  assert.equal(msg.content, "改过的回答");
  assert.ok(msg.editedAt, "应有 editedAt");

  const reloaded = await repo.get(convId);
  const found = reloaded.messages.find(m => m.id === assistantId);
  assert.equal(found.content, "改过的回答", "必须真的落盘");
});

await test("编辑 assistant：旧内容进 variants（可回溯）", async () => {
  const { repo, convId, assistantId } = await freshConv();
  const msg = await repo.editMessage(convId, assistantId, "第二版");
  assert.ok(Array.isArray(msg.variants), "应建 variants");
  assert.ok(msg.variants.includes("答一句"), "旧内容应被保留");
});

await test("编辑 user 消息不产生 variants", async () => {
  const { repo, convId } = await freshConv();
  const conv = await repo.get(convId);
  const userId = conv.messages.find(m => m.role === "user").id;
  const msg = await repo.editMessage(convId, userId, "改过的问题");
  assert.equal(msg.content, "改过的问题");
  assert.ok(!msg.variants || msg.variants.length === 0, "user 消息不该有 variants");
});

await test("删除单条消息", async () => {
  const { repo, convId, assistantId } = await freshConv();
  const before = (await repo.get(convId)).messages.length;
  const after = await repo.deleteMessage(convId, assistantId);
  assert.equal(after.messages.length, before - 1);
  assert.ok(!after.messages.some(m => m.id === assistantId));
});

await test("删除不存在的消息 → 抛错（不静默）", async () => {
  const { repo, convId } = await freshConv();
  await assert.rejects(
    () => repo.deleteMessage(convId, "no-such-message"),
    /Message not found/
  );
});

await test("变体切换：内容跟着 index 变", async () => {
  const { repo, convId, assistantId } = await freshConv();
  // freshConv 里 assistant 初始内容是“答一句”
  await repo.addVariant(convId, assistantId, "变体A");
  await repo.addVariant(convId, assistantId, "变体B");

  // variants 累积顺序：["答一句", "变体A", "变体B"]
  const m0 = (await repo.get(convId)).messages.find(m => m.id === assistantId);
  assert.deepEqual(m0.variants, ["答一句", "变体A", "变体B"], "variants 应累积");
  assert.equal(m0.variantIndex, 2, "新加的变体应成为当前");

  const msg = await repo.switchVariant(convId, assistantId, 0);
  assert.equal(msg.content, "答一句", "index 0 是最初的内容");
  assert.equal(msg.variantIndex, 0);

  const msg2 = await repo.switchVariant(convId, assistantId, 1);
  assert.equal(msg2.content, "变体A");

  // 切换必须落盘
  const reloaded = (await repo.get(convId)).messages.find(m => m.id === assistantId);
  assert.equal(reloaded.content, "变体A", "切换后应持久化");
});

await test("变体索引越界 → 抛错", async () => {
  const { repo, convId, assistantId } = await freshConv();
  await repo.addVariant(convId, assistantId, "只有一个");
  await assert.rejects(
    () => repo.switchVariant(convId, assistantId, 99),
    /out of range/
  );
});

await test("截断到最后一条 user（重生用）", async () => {
  const { repo, convId } = await freshConv();
  await repo.addMessage(convId, "assistant", "多余的尾巴");

  const { removed, conv } = await repo.truncateAfterLastUser(convId);
  assert.equal(removed, 2, "应移除最后一条 user 之后的全部 assistant");
  assert.equal(conv.messages[conv.messages.length - 1].role, "user");
});

await test("截断后能追加新回复（重生闭环）", async () => {
  const { repo, convId } = await freshConv();
  await repo.truncateAfterLastUser(convId);
  const fresh = await repo.addMessage(convId, "assistant", "重生的回答");
  assert.equal(fresh.content, "重生的回答");

  const reloaded = await repo.get(convId);
  assert.equal(reloaded.messages.length, 2, "user + 新 assistant");
  assert.equal(reloaded.messages[1].content, "重生的回答");
});

await test("编辑后索引的 messageCount 同步", async () => {
  const { repo, convId, assistantId } = await freshConv();
  await repo.deleteMessage(convId, assistantId);
  const list = await repo.list();
  const entry = list.find(c => c.id === convId);
  assert.equal(entry.messageCount, 1, "索引里的条数必须跟着变");
});

console.log("\n" + "=".repeat(50));
console.log(`通过 ${passed} / 失败 ${failed}`);
console.log("=".repeat(50));

await fs.rm(tmpRoot, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
