// test/regression-cache.mjs — 缓存链路：原始回合回传 + 有效性判定
//
// 这组测试存在的理由：宿主早就内建了 prompt caching（cacheRead/cacheWrite
// + textSignature），但代码把结果全扔了，命中率恒为 0。
//
// v2 修正（据独立复核）：不再存「单个签名 + join 后的文本」——
// 一个 assistant 回合可能是 [text, reasoning, text] 混合序列，每段各有签名，
// 只存最后一段的签名配整段拼接文本，是钥匙和锁不配对。
// 改为存**原始回合数组**，有效性在读取时校验。

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  extractReasoning, textOfAssistantContent, isRawContentValid,
  assistantContentFor, toStreamMessages
} = await import("../lib/llm/service.js");
const { createMessage } = await import("../lib/conversations/model.js");
const { ConversationRepo } = await import("../lib/conversations/repo.js");

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 缓存链路回归 ===\n");

const MIXED = [
  { type: "reasoning", reasoning: "先想", signature: "rs-1" },
  { type: "text", text: "前半", textSignature: "sig-A" },
  { type: "text", text: "后半", textSignature: "sig-B" }
];

// ── 1. 原始回合的文本抽取 ──
ok("textOfAssistantContent 只取 text 段并拼接", () => {
  assert.strictEqual(textOfAssistantContent(MIXED), "前半后半");
});

ok("textOfAssistantContent 对非数组返回空串", () => {
  assert.strictEqual(textOfAssistantContent(null), "");
  assert.strictEqual(textOfAssistantContent("x"), "");
});

// ── 2. 有效性判定（唯一的判定点）──
ok("content 与原始回合文本一致 → 有效", () => {
  assert.strictEqual(isRawContentValid({ content: "前半后半", rawContent: MIXED }), true);
});

ok("content 被改过 → 失效（宏替换/编辑/切变体都走这条）", () => {
  assert.strictEqual(isRawContentValid({ content: "前半后半（被编辑）", rawContent: MIXED }), false);
});

ok("没有 rawContent → 失效", () => {
  assert.strictEqual(isRawContentValid({ content: "x", rawContent: null }), false);
  assert.strictEqual(isRawContentValid({ content: "x" }), false);
});

ok("rawContent 为空数组 → 失效", () => {
  assert.strictEqual(isRawContentValid({ content: "", rawContent: [] }), false);
});

ok("_prefixBroken 标记 → 失效（裁剪/摘要改变前缀）", () => {
  assert.strictEqual(
    isRawContentValid({ content: "前半后半", rawContent: MIXED, _prefixBroken: true }),
    false
  );
});

// ── 3. 组装回传内容 ──
ok("有效时回传整段原始回合（保留各段签名）", () => {
  const out = assistantContentFor({ content: "前半后半", rawContent: MIXED });
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[1].textSignature, "sig-A");
  assert.strictEqual(out[2].textSignature, "sig-B");
  assert.strictEqual(out[0].type, "reasoning");
});

ok("失效时回退成单段纯文本（不带任何签名）", () => {
  const out = assistantContentFor({ content: "改过了", rawContent: MIXED });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].type, "text");
  assert.strictEqual(out[0].text, "改过了");
  assert.ok(!("textSignature" in out[0]), "不该带签名");
});

ok("换模型时放弃旧签名（模型语义不通）", () => {
  const out = assistantContentFor(
    { content: "前半后半", rawContent: MIXED, model: "old-model" },
    { currentModel: "new-model" }
  );
  assert.strictEqual(out.length, 1);
  assert.ok(!("textSignature" in out[0]));
});

ok("模型相同则保留签名", () => {
  const out = assistantContentFor(
    { content: "前半后半", rawContent: MIXED, model: "same" },
    { currentModel: "same" }
  );
  assert.strictEqual(out.length, 3);
});

ok("回传的是副本，改它不影响原对象", () => {
  const msg = { content: "前半后半", rawContent: MIXED };
  const out = assistantContentFor(msg);
  out[1].text = "被改了";
  assert.strictEqual(msg.rawContent[1].text, "前半");
});

// ── 4. toStreamMessages 整合 ──
ok("toStreamMessages 回传原始回合", () => {
  const { messages } = toStreamMessages([
    { role: "user", content: "嗨" },
    { role: "assistant", content: "前半后半", rawContent: MIXED, model: "m" }
  ], { currentModel: "m" });
  const a = messages.find(m => m.role === "assistant");
  assert.strictEqual(a.content.length, 3);
});

ok("文本被改过的消息回传时不带签名", () => {
  const { messages } = toStreamMessages([
    { role: "assistant", content: "改过了", rawContent: MIXED, model: "m" }
  ], { currentModel: "m" });
  assert.strictEqual(messages[0].content.length, 1);
  assert.ok(!("textSignature" in messages[0].content[0]));
});

ok("system 消息仍走 extraSystem", () => {
  const { messages, extraSystem } = toStreamMessages([
    { role: "system", content: "规则" },
    { role: "user", content: "嗨" }
  ]);
  assert.strictEqual(extraSystem, "规则");
  assert.strictEqual(messages.length, 1);
});

// ── 5. reasoning 提取 ──
ok("extractReasoning 保留 signature 与 redacted", () => {
  const r = extractReasoning({ content: MIXED });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].signature, "rs-1");
  assert.strictEqual(r[0].redacted, false);
});

ok("无推理段时返回 null", () => {
  assert.strictEqual(extractReasoning({ content: [{ type: "text", text: "x" }] }), null);
});

// ── 6. 消息模型 ──
ok("createMessage 带出缓存字段且默认为 null", () => {
  const m = createMessage("assistant", "hi");
  assert.strictEqual(m.usage, null);
  assert.strictEqual(m.rawContent, null);
  assert.strictEqual(m.model, null);
});

// ── 7. usage / 原始回合落盘 ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-cache-"));

await okAsync("setMessageUsage 落盘 usage 与原始回合", async () => {
  const repo = new ConversationRepo(tmp);
  const conv = await repo.create("char-1");
  const msg = await repo.addMessage(conv.id, "assistant", "前半后半");

  const updated = await repo.setMessageUsage(conv.id, msg.id, {
    usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 0 },
    rawContent: MIXED,
    model: "m-1"
  });

  assert.strictEqual(updated.model, "m-1");
  assert.strictEqual(updated.usage.cacheRead, 80);
  assert.strictEqual(updated.rawContent.length, 3);

  const reread = await repo.get(conv.id);
  const stored = reread.messages.find(m => m.id === msg.id);
  assert.strictEqual(stored.rawContent[1].textSignature, "sig-A", "签名应持久化");
});

await okAsync("setMessageUsage 只改传入字段", async () => {
  const repo = new ConversationRepo(tmp);
  const conv = await repo.create("char-2");
  const msg = await repo.addMessage(conv.id, "assistant", "x");

  await repo.setMessageUsage(conv.id, msg.id, { model: "m1" });
  const second = await repo.setMessageUsage(conv.id, msg.id, { usage: { input: 5 } });

  assert.strictEqual(second.model, "m1", "模型标识不该被第二次调用清掉");
  assert.strictEqual(second.usage.input, 5);
});

await okAsync("对不存在的消息抛错", async () => {
  const repo = new ConversationRepo(tmp);
  const conv = await repo.create("char-3");
  let threw = false;
  try { await repo.setMessageUsage(conv.id, "no-such", { usage: {} }); } catch { threw = true; }
  assert.ok(threw);
});

await okAsync("编辑消息后原始回合仍在，但判定为失效", async () => {
  const repo = new ConversationRepo(tmp);
  const conv = await repo.create("char-4");
  const msg = await repo.addMessage(conv.id, "assistant", "前半后半");
  await repo.setMessageUsage(conv.id, msg.id, { rawContent: MIXED, model: "m" });

  await repo.editMessage(conv.id, msg.id, "用户改过的内容");

  const fresh = await repo.get(conv.id);
  const stored = fresh.messages.find(m => m.id === msg.id);
  assert.ok(Array.isArray(stored.rawContent), "原始回合仍在（可逆）");
  assert.strictEqual(isRawContentValid(stored), false, "但内容不一致 → 判定失效");
});

await okAsync("切换变体后判定失效", async () => {
  const repo = new ConversationRepo(tmp);
  const conv = await repo.create("char-5");
  const msg = await repo.addMessage(conv.id, "assistant", "版本一");
  await repo.setMessageUsage(conv.id, msg.id, { rawContent: [{ type: "text", text: "版本一", textSignature: "s" }], model: "m" });

  await repo.addVariant(conv.id, msg.id, "版本二");

  const fresh = await repo.get(conv.id);
  const stored = fresh.messages.find(m => m.id === msg.id);
  assert.strictEqual(isRawContentValid(stored), false);
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
