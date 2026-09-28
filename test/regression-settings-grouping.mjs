// test/regression-settings-grouping.mjs — 设定库「什么时候生效」分组
//
// 为什么要测这个：
//   界面上的「常驻 · 每轮都在上下文里」不是装饰，是对运行时行为的**断言**。
//   如果分组口径漂了，用户会看到一条设定被标成“常驻”，而它其实一轮都不进。
//   所以这里不测“抄写是否正确”，测的是**界面口径与 lib/lore/matcher.js 是否一致**：
//   同一个条目喂给两边，结论必须相同。
//
// 起因（2026-09-27）：真机 106 条里 37 条是 `type=always` 又带触发词
//   （`交感同操`、`allmind`…），界面把它们按强调色画出了触发词，
//   暗示“说到才进”——而运行时根本不读这些词。

import assert from "node:assert/strict";
import { KeywordMatcher } from "../lib/lore/matcher.js";
import {
  isConstantSetting,
  settingBucket,
  keywordsAreLive,
  SETTING_SECTIONS
} from "../ui/assets/modules/setting-buckets.js";

let pass = 0, fail = 0;
async function ok(name, fn) {
  try { await fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "\n      " + (e?.message ?? e)); }
}

/** 造一条最小可用的设定。 */
const entry = (over = {}) => ({
  id: "e1", name: "n", content: "c", enabled: true,
  keywords: [], priority: 100, order: 1, probability: 100,
  ...over
});

console.log("\n── 分组口径 ──");

await ok("① type=always 且带触发词 → 仍归常驻（ST 的 constant 语义）", () => {
  const s = entry({ trigger: { type: "always" }, keywords: ["交感同操"] });
  assert.equal(isConstantSetting(s), true);
  assert.equal(settingBucket(s), 0);
});

await ok("② type=keyword → 触发", () => {
  const s = entry({ trigger: { type: "keyword" }, keywords: ["哨塔"] });
  assert.equal(isConstantSetting(s), false);
  assert.equal(settingBucket(s), 1);
});

await ok("③ type=regex → 触发", () => {
  const s = entry({ trigger: { type: "regex" }, keywords: ["/哨.{0,2}/"] });
  assert.equal(settingBucket(s), 1);
});

await ok("④ isConstant 旗标优先于 type=keyword（与运行时同序）", () => {
  const s = entry({ trigger: { type: "keyword" }, isConstant: true, keywords: ["哨塔"] });
  assert.equal(settingBucket(s), 0);
});

await ok("⑤ 没有 trigger 的老数据：按有无触发词判", () => {
  assert.equal(settingBucket(entry({ keywords: ["哨塔"] })), 1);
  assert.equal(settingBucket(entry({ keywords: [] })), 0);
});

await ok("⑥ enabled=false → 已停用，且压过常驻/触发的区分", () => {
  assert.equal(settingBucket(entry({ enabled: false, trigger: { type: "always" } })), 2);
  assert.equal(settingBucket(entry({ enabled: false, trigger: { type: "keyword" }, keywords: ["x"] })), 2);
});

await ok("⑦ 触发词是否“算数”：常驻不算，触发算", () => {
  assert.equal(keywordsAreLive(entry({ trigger: { type: "always" }, keywords: ["交感同操"] })), false);
  assert.equal(keywordsAreLive(entry({ trigger: { type: "keyword" }, keywords: ["哨塔"] })), true);
});

await ok("⑧ 每个桶都有抬头，且抬头顺序与桶号一一对应", () => {
  const keys = SETTING_SECTIONS.map(s => s.key);
  assert.deepEqual(keys, [0, 1, 2], "抬头缺失或乱序：加了一个桶就补一个抬头");
  for (const s of SETTING_SECTIONS) {
    assert.ok(s.title && s.hint, `抬头 ${s.key} 缺 title 或 hint`);
  }
});

console.log("\n── 与运行时对账（这才是重点）──");

await ok("⑨ 运行时佐证：type=always 的条目，文本里一个触发词都没有也会被激活", () => {
  const m = new KeywordMatcher();
  m.build([
    entry({ id: "A", trigger: { type: "always" }, keywords: ["交感同操"] }),
    entry({ id: "B", trigger: { type: "keyword" }, keywords: ["交感同操"] })
  ]);
  const hit = m.match("这段话里没有任何触发词。").map(r => String(r.id));
  assert.ok(hit.includes("A"), "常驻条目应当无条件进上下文（否则界面画成常驻就是骗人）");
  assert.ok(!hit.includes("B"), "关键词条目不该被激活");
});

await ok("⑩ 运行时佐证：isConstant 旗标同样不看关键词", () => {
  const m = new KeywordMatcher();
  m.build([entry({ id: "A", trigger: { type: "keyword" }, isConstant: true, keywords: ["交感同操"] })]);
  const hit = m.match("没有触发词。").map(r => String(r.id));
  assert.ok(hit.includes("A"), "isConstant 旗标应等同常驻");
});

await ok("⑪ 对账：同一批条目，界面分到常驻 ⇔ 运行时无词也激活", () => {
  const samples = [
    entry({ id: "S1", trigger: { type: "always" }, keywords: ["qwxa"] }),
    entry({ id: "S2", trigger: { type: "always" }, keywords: [] }),
    entry({ id: "S3", trigger: { type: "keyword" }, keywords: ["qwxz"] }),
    entry({ id: "S4", trigger: { type: "regex" }, keywords: ["/qwxz/"] })
  ];
  const m = new KeywordMatcher();
  m.build(samples);
  // 注意：这段文本必须**字面上不含**上面那几个键，否则测的是子串命中而不是分组
  const hit = new Set(m.match("这段文本刻意不含任何触发词。").map(r => String(r.id)));
  for (const s of samples) {
    const uiSaysConstant = settingBucket(s) === 0;
    const runtimeAlwaysIn = hit.has(s.id);
    assert.equal(
      uiSaysConstant, runtimeAlwaysIn,
      `${s.id}：界面说常驻=${uiSaysConstant}，运行时无词也进=${runtimeAlwaysIn} —— 两边漂了`
    );
  }
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
