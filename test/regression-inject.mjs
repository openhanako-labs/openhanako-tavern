// test/regression-inject.mjs — 世界书锚点分流回归
//
// 这段逻辑原本藏在 routes 闭包里，测不到——而"条目最终落在哪个位置"
// 恰恰是单测测不到、真实运行才暴露的那类问题。
// 提取成 lib/lore/inject.js 后补上覆盖。

import assert from "node:assert/strict";
import { injectByAnchor, renderAnchoredLore, PROMPT_ANCHORS } from "../lib/lore/inject.js";

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
const ent = (id, content, extra = {}) => ({ id, name: id, content, ...extra });

console.log("\n锚点分流 · 系统提示侧\n" + "─".repeat(50));

test("before_char / after_char 进提示", () => {
  const byAnchor = {
    before_char: [ent("a", "内容A")],
    after_char: [ent("b", "内容B")]
  };
  const text = renderAnchoredLore(byAnchor);
  assert.ok(text.includes("内容A"));
  assert.ok(text.includes("内容B"));
});

test("at_depth 不进提示", () => {
  const byAnchor = { at_depth: [ent("d", "深度内容")] };
  const text = renderAnchoredLore(byAnchor);
  assert.equal(text, "", "at_depth 不该出现在系统提示里");
});

test("outlet 不自动注入", () => {
  const byAnchor = { outlet: [ent("o", "出口内容")] };
  assert.equal(renderAnchoredLore(byAnchor), "");
});

test("unspecified 兜底不丢", () => {
  const byAnchor = { unspecified: [ent("u", "未映射内容")] };
  assert.ok(renderAnchoredLore(byAnchor).includes("未映射内容"));
});

test("空分组返回空串", () => {
  assert.equal(renderAnchoredLore(null), "");
  assert.equal(renderAnchoredLore({}), "");
  assert.equal(renderAnchoredLore({ before_char: [] }), "");
});

test("PROMPT_ANCHORS 不含 at_depth / outlet", () => {
  assert.ok(!PROMPT_ANCHORS.includes("at_depth"));
  assert.ok(!PROMPT_ANCHORS.includes("outlet"));
});

console.log("\n锚点分流 · 历史插入侧\n" + "─".repeat(50));

test("无 at_depth → 消息原样返回", () => {
  const msgs = [msg("user", "A"), msg("assistant", "B")];
  const r = injectByAnchor(msgs, { before_char: [ent("x", "y")] });
  assert.equal(r.messages, msgs, "应返回同一引用");
  assert.equal(r.injected.length, 0);
});

test("at_depth=1 → 插在最后一条之前（前缀）", () => {
  const msgs = [msg("user", "第一条"), msg("assistant", "第二条")];
  const r = injectByAnchor(msgs, { at_depth: [ent("d", "深度设定")] }, 1);
  assert.equal(r.injected.length, 1);
  assert.equal(r.injected[0].at, 1, "应落在 index 1");
  assert.ok(r.messages[1].content.startsWith("深度设定"));
  assert.ok(r.messages[1].content.includes("第二条"));
});

test("at_depth=4 → 倒数第 4 条（历史不足时落到第 0 条）", () => {
  const msgs = [msg("user", "A"), msg("assistant", "B")];
  const r = injectByAnchor(msgs, { at_depth: [ent("d", "深度")] }, 4);
  assert.equal(r.injected[0].at, 0, "2 条历史 + depth 4 → 落 index 0");
  assert.ok(r.messages[0].content.startsWith("深度"));
});

test("多条 at_depth 按 depth 降序处理，位置不互相推移", () => {
  const msgs = [1, 2, 3, 4, 5, 6].map(i => msg("user", `m${i}`));
  const r = injectByAnchor(msgs, {
    at_depth: [ent("shallow", "浅"), ent("deep", "深", { depth: 1 })]
  }, 4);
  // deep(depth=1) → index 5；shallow(depth=4 默认) → index 2
  const byId = Object.fromEntries(r.injected.map(x => [x.id, x.at]));
  assert.equal(byId.deep, 5);
  assert.equal(byId.shallow, 2);
  assert.ok(r.messages[5].content.startsWith("深"));
  assert.ok(r.messages[2].content.startsWith("浅"));
});

test("不修改原数组（浅拷贝）", () => {
  const msgs = [msg("user", "原文")];
  const before = msgs[0].content;
  injectByAnchor(msgs, { at_depth: [ent("d", "插入")] }, 1);
  assert.equal(msgs[0].content, before, "原消息不该被改");
});

test("空内容条目被跳过", () => {
  const msgs = [msg("user", "A")];
  const r = injectByAnchor(msgs, { at_depth: [ent("d", "")] }, 1);
  assert.equal(r.injected.length, 0);
});

test("历史为空 → 记录 at=-1", () => {
  const r = injectByAnchor([], { at_depth: [ent("d", "内容")] }, 1);
  assert.equal(r.injected[0].at, -1);
  assert.ok(r.injected[0].note);
});

test("depth 从 extensions 保留字段读取", () => {
  const msgs = [1, 2, 3, 4, 5].map(i => msg("user", `m${i}`));
  const r = injectByAnchor(msgs, {
    at_depth: [ent("d", "内容", { extensions: { _preserved_depth: 2 } })]
  }, 4);
  assert.equal(r.injected[0].at, 3, "5-2=3");
});

test("depth 非法值回落到默认", () => {
  const msgs = [1, 2, 3].map(i => msg("user", `m${i}`));
  const r = injectByAnchor(msgs, { at_depth: [ent("d", "内容", { depth: 0 })] }, 2);
  assert.equal(r.injected[0].at, 1, "depth 0 → 用默认 2 → 3-2=1");
});

console.log("\n锚点分流 · 端到端\n" + "─".repeat(50));

test("混合锚点：提示与历史各归其位", () => {
  const msgs = [msg("user", "问"), msg("assistant", "答")];
  const byAnchor = {
    before_char: [ent("b", "角色前设定")],
    at_depth: [ent("d", "深度设定", { depth: 1 })]
  };

  const prompt = renderAnchoredLore(byAnchor);
  const r = injectByAnchor(msgs, byAnchor, 4);

  assert.ok(prompt.includes("角色前设定"));
  assert.ok(!prompt.includes("深度设定"), "深度条目不该进提示");
  assert.ok(r.messages[1].content.includes("深度设定"));
  assert.ok(!r.messages[1].content.includes("角色前设定"));
});

console.log("\n" + "=".repeat(50));
console.log(`通过 ${passed} / 失败 ${failed}`);
console.log("=".repeat(50));
process.exit(failed > 0 ? 1 : 0);
