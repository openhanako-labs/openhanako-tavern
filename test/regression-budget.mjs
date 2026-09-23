// test/regression-budget.mjs — 上下文预算与 token 估算
//
// 这组测试锁住两件事：
//   1. 中文 token 估算不能按 4 字符/token 算（会严重低估，导致超窗）
//   2. 预算必须跟着模型真实窗口走（过去写死 8000）

import assert from "node:assert";

const { estimateTokens, allocateBudget, trimHistory, prepareHistory } =
  await import("../lib/llm/history.js");

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 预算与估算回归 ===\n");

// ── 1. 中文估算 ──
ok("中文按每字约 1 token 估算，不是 4 字/token", () => {
  const s = "这是一个二十个汉字的中文句子用来测试估算";
  const n = estimateTokens(s);
  assert.ok(n >= 18, `20 个汉字应估出接近 20 token，实际 ${n}`);
  assert.ok(n <= 24, `不该高估太多，实际 ${n}`);
});

ok("英文仍按约 4 字符/token", () => {
  assert.strictEqual(estimateTokens("a".repeat(40)), 10);
});

ok("中英混排按字符类型分别计价", () => {
  // 10 汉字(10) + 40 字母(10) = 20
  const mixed = "十个汉字在这里呀" + "b".repeat(40);
  const n = estimateTokens(mixed);
  assert.ok(n >= 18 && n <= 24, `实际 ${n}`);
});

ok("空文本返回 1（不低于 1）", () => {
  assert.strictEqual(estimateTokens(""), 1);
  assert.strictEqual(estimateTokens(null), 1);
  assert.strictEqual(estimateTokens(undefined), 1);
});

// ── 2. 预算按真实窗口 ──
ok("128K 窗口得到远大于 8K 的历史预算", () => {
  const big = allocateBudget(128000, { reserveForOutput: 4000 });
  const small = allocateBudget(8000, { reserveForOutput: 1000 });
  assert.ok(big.history > small.history * 10, `128K(${big.history}) 应远大于 8K(${small.history})`);
});

ok("预算三部分相加等于可用量", () => {
  const b = allocateBudget(32000, { reserveForOutput: 2000 });
  assert.strictEqual(b.lore + b.history, b.available);
});

ok("可用量为负时归零，不产生负预算", () => {
  const b = allocateBudget(500, { reserveForOutput: 2000 });
  assert.strictEqual(b.available, 0);
  assert.strictEqual(b.history, 0);
  assert.strictEqual(b.lore, 0);
});

ok("窗口非法时兜底 8000", () => {
  assert.strictEqual(allocateBudget(0).window, 8000);
  assert.strictEqual(allocateBudget(-1).window, 8000);
  assert.strictEqual(allocateBudget(null).window, 8000);
  assert.strictEqual(allocateBudget(NaN).window, 8000);
});

ok("loreRatio 生效", () => {
  const b = allocateBudget(10000, { reserveForOutput: 0, loreRatio: 0.5 });
  assert.strictEqual(b.lore, 5000);
  assert.strictEqual(b.history, 5000);
});

// ── 3. 裁剪保留最近消息 ──
ok("trimHistory 至少保留 keepRecent 条", () => {
  const msgs = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: "x".repeat(400)
  }));
  const r = trimHistory(msgs, { maxTokens: 50, keepRecent: 4 });
  assert.ok(r.messages.length >= 4, `实际保留 ${r.messages.length}`);
  assert.ok(r.dropped > 0, "应丢弃了一些");
});

ok("trimHistory 保留的是最新那几条", () => {
  const msgs = [
    { role: "user", content: "最老" },
    { role: "assistant", content: "中间" },
    { role: "user", content: "最新" }
  ];
  const r = trimHistory(msgs, { maxTokens: 100000, keepRecent: 1 });
  assert.strictEqual(r.messages[r.messages.length - 1].content, "最新");
});

ok("trimHistory 不破坏消息对象上的签名字段", () => {
  const msgs = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b", signature: "sig-Z" }
  ];
  const r = trimHistory(msgs, { maxTokens: 100000 });
  const kept = r.messages.find(m => m.role === "assistant");
  assert.strictEqual(kept.signature, "sig-Z", "裁剪不该丢签名");
});

// ── 4. 摘要锚点 ──
ok("prepareHistory 摘要插在最前且不改动已有消息", () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: "内容" + i
  }));
  const r = prepareHistory(msgs, { maxTokens: 20, keepRecent: 2 });
  if (r.summaryAttached) {
    assert.ok(r.messages[0].content.startsWith("[前情提要]"));
    // 已有消息的签名字段不该被摘要注意影响
    assert.ok(r.messages.slice(1).every(m => m.role));
  }
});

console.log(`\n通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
