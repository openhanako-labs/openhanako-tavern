// test/regression-c4.mjs — C4 历史预算回归

import assert from "node:assert/strict";
import {
  estimateTokens,
  estimateMessageTokens,
  trimHistory,
  buildSummary,
  attachSummary,
  prepareHistory,
  allocateBudget
} from "../lib/llm/history.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e.message}`);
    failed++;
  }
}

const msg = (role, content) => ({ role, content });

console.log("\nC4 · 估算\n" + "─".repeat(50));

test("estimateTokens：4 字符 ≈ 1 token", () => {
  assert.equal(estimateTokens("1234"), 1);
  assert.equal(estimateTokens("12345"), 2);
  assert.equal(estimateTokens(""), 1, "空文本也算 1（避免除零）");
});

test("estimateMessageTokens 含角色开销", () => {
  assert.ok(estimateMessageTokens(msg("user", "1234")) > estimateTokens("1234"));
});

console.log("\nC4 · 裁剪\n" + "─".repeat(50));

test("空列表", () => {
  const r = trimHistory([]);
  assert.deepEqual(r.messages, []);
  assert.equal(r.dropped, 0);
});

test("预算内不裁剪", () => {
  const messages = [msg("user", "短"), msg("assistant", "也短")];
  const r = trimHistory(messages, { maxTokens: 1000 });
  assert.equal(r.messages.length, 2);
  assert.equal(r.dropped, 0);
  assert.equal(r.summary, null);
});

test("超预算时从最旧的开始丢", () => {
  const messages = [];
  for (let i = 0; i < 20; i++) {
    messages.push(msg(i % 2 ? "assistant" : "user", `消息${i}-` + "x".repeat(100)));
  }
  const r = trimHistory(messages, { maxTokens: 200, keepRecent: 2 });
  assert.ok(r.dropped > 0, "应有消息被丢");
  assert.ok(r.messages.length < 20);

  // 保留的应该是最后几条
  const lastKept = r.messages[r.messages.length - 1].content;
  assert.ok(lastKept.includes("消息19"), `最后一条应保留，实际: ${lastKept.slice(0, 20)}`);
});

test("keepRecent 保护最近几条", () => {
  const messages = [];
  for (let i = 0; i < 10; i++) {
    messages.push(msg("user", "x".repeat(500)));
  }
  const r = trimHistory(messages, { maxTokens: 1, keepRecent: 3 });
  assert.ok(r.messages.length >= 3, `至少保留 3 条，实际 ${r.messages.length}`);
});

test("maxMessages 条数上限", () => {
  const messages = [];
  for (let i = 0; i < 50; i++) messages.push(msg("user", "短"));
  const r = trimHistory(messages, { maxTokens: 999999, maxMessages: 10, keepRecent: 1 });
  assert.ok(r.messages.length <= 10, `条数应受限，实际 ${r.messages.length}`);
});

console.log("\nC4 · 摘要锚点\n" + "─".repeat(50));

test("buildSummary 提取骨架", () => {
  const dropped = [
    msg("user", "我们在银月城的酒馆里"),
    msg("assistant", "酒馆很热闹"),
    msg("user", "我问老板要了杯酒")
  ];
  const s = buildSummary(dropped);
  assert.ok(s.includes("起点"), "应含起点");
  assert.ok(s.includes("银月城"), "应含首条内容");
  assert.ok(s.includes("3 条"), "应说明折叠条数");
});

test("buildSummary 空输入 → null", () => {
  assert.equal(buildSummary([]), null);
  assert.equal(buildSummary(null), null);
});

test("buildSummary 长度受限", () => {
  const dropped = [
    msg("user", "很长的内容".repeat(200)),
    msg("assistant", "也很长".repeat(200))
  ];
  const s = buildSummary(dropped, { maxChars: 100 });
  assert.ok(s.length <= 110, `应受限，实际 ${s.length}`);
});

test("attachSummary 插到最前", () => {
  const out = attachSummary([msg("user", "A")], "摘要内容");
  assert.equal(out.length, 2);
  assert.ok(out[0].content.includes("前情提要"));
  assert.equal(out[1].content, "A");
});

test("attachSummary 无摘要时原样返回", () => {
  const orig = [msg("user", "A")];
  assert.equal(attachSummary(orig, null), orig);
});

console.log("\nC4 · prepareHistory\n" + "─".repeat(50));

test("裁剪 + 摘要一步完成", () => {
  const messages = [];
  for (let i = 0; i < 20; i++) {
    messages.push(msg(i % 2 ? "assistant" : "user", `m${i}-` + "x".repeat(100)));
  }
  const r = prepareHistory(messages, { maxTokens: 200, keepRecent: 2 });
  assert.ok(r.dropped > 0);
  assert.equal(r.summaryAttached, true);
  assert.ok(r.messages[0].content.includes("前情提要"), "摘要应在最前");
});

test("summarize=false 时不生成摘要", () => {
  const messages = [];
  for (let i = 0; i < 20; i++) messages.push(msg("user", "x".repeat(100)));
  const r = prepareHistory(messages, { maxTokens: 200, keepRecent: 2, summarize: false });
  assert.equal(r.summaryAttached, false);
  assert.ok(!r.messages[0].content.includes("前情提要"));
});

console.log("\nC4 · 预算分配\n" + "─".repeat(50));

test("allocateBudget 分配合理", () => {
  const b = allocateBudget(8000, { reserveForOutput: 1000, systemTokens: 500 });
  assert.equal(b.available, 6500);
  assert.equal(b.output, 1000);
  assert.equal(b.history + b.lore, 6500);
});

test("allocateBudget 预算不足时不出现负数", () => {
  const b = allocateBudget(100, { reserveForOutput: 1000, systemTokens: 500 });
  assert.equal(b.available, 0);
  assert.ok(b.history >= 0);
  assert.ok(b.lore >= 0);
});

console.log("\n" + "=".repeat(50));
console.log(`通过 ${passed} / 失败 ${failed}`);
console.log("=".repeat(50));
process.exit(failed > 0 ? 1 : 0);
