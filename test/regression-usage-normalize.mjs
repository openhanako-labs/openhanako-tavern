// test/regression-usage-normalize.mjs — usage 归一化（上下文/缓存读数的分母分子）
//
// 背景（2026-10-02 真机）：宿主契约的 usage 里 input = 未命中缓存的输入，
// cacheRead = 命中部分。直接拿 input 当分母、cacheRead 当分子，
// 读数条出现「缓存 36913%」——数学上不可能的假读数。
//
// 真实样本（deepseek-flash，会话 201ca7dd）：
//   { input: 232, output: 361, cacheRead: 36224, totalTokens: 36817 }
// 正确读数：上下文 36456（=232+36224），缓存命中 99%。

import assert from "node:assert";

const { normalizeUsage } = await import("../ui/assets/modules/display.js");

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== usage 归一化 ===\n");

ok("① 宿主形状：上下文 = input + cacheRead，命中率分母正确", () => {
  const r = normalizeUsage({ input: 232, output: 361, cacheRead: 36224, cacheWrite: 0, totalTokens: 36817 });
  assert.strictEqual(r.prompt, 36456, `实为 ${r.prompt}`);
  assert.strictEqual(r.cached, 36224);
  const pct = Math.round((r.cached / r.prompt) * 100);
  assert.ok(pct <= 100, `命中率 ${pct}% 超过 100%`);
  assert.strictEqual(pct, 99);
});

ok("② 宿主形状：首条消息无缓存 → cacheRead 为 0，上下文 = input", () => {
  const r = normalizeUsage({ input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1500 });
  assert.strictEqual(r.prompt, 1200);
  assert.strictEqual(r.cached, 0);
});

ok("③ OpenAI 旧字段名照常识别（兜底不丢）", () => {
  const r = normalizeUsage({ prompt_tokens: 5000, prompt_tokens_details: { cached_tokens: 4000 } });
  assert.strictEqual(r.prompt, 5000);
  assert.strictEqual(r.cached, 4000);
});

ok("④ 空值安全：null / 空 对象不抛错", () => {
  assert.strictEqual(normalizeUsage(null).prompt, null);
  assert.strictEqual(normalizeUsage({}).prompt, null);
  assert.strictEqual(normalizeUsage({}).cached, 0);
});

console.log(`\n${fail === 0 ? "✅" : "❌"} usage 归一化：${pass} 过 / ${fail} 败\n`);
process.exit(fail === 0 ? 0 : 1);
