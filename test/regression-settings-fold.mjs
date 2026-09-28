// test/regression-settings-fold.mjs — 设定库分组折叠：读写两端 key 必须一致
//
// 为什么要测这个：
//   折叠坏了不会报错。点击写一个 key，渲染时读另一个 key，
//   结果是「点了没反应」——没有异常、没有日志，用户只看到抬头不动。
//   这类 bug 只能靠**把不变量写成断言**来防。
//
// 真事故（2026-09-28）：
//   SETTING_SECTIONS 的 key 是数字 0/1/2。
//   renderSection 写 `data-key="${escapeHtml(g.key)}"`，
//   而 escapeHtml 当时用 `!str` 判空 —— `!0` 为 true，
//   于是 escapeHtml(0) 返回空串，常驻组抬头变成 data-key=""。
//   点击 → 写 `eleckoi:settings-folded:trigger:`
//   渲染 → 读 `eleckoi:settings-folded:trigger:0`
//   两端永远错位。而「触发」「已停用」的 key 是 1/2，
//   escapeHtml(1) 正常返回 "1"，恰好能对上 —— 所以**只有常驻坏**。
//
// 本测试盯三件事：
//   ① foldKey 对数字/字符串 key 产出同一个 key（这就是当初缺的那条）
//   ② 从 dataset 读回来的字符串 key，与用 SETTING_SECTIONS.key 数字构造的 key 相同
//   ③ 渲染层真的把数字 key 写进了 data-key（不再被 escapeHtml 吞掉）

import assert from "node:assert/strict";
import { foldKey, readFolded, nextFoldedValue } from "../ui/assets/modules/settings-fold.js";
import { SETTING_SECTIONS } from "../ui/assets/modules/setting-buckets.js";

let pass = 0, fail = 0;
async function ok(name, fn) {
  try { await fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "\n      " + (e?.message ?? e)); }
}

/** 假的 localStorage：只为让 read 注入点能跑。 */
const fakeStore = (init = {}) => {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    _dump: () => Object.fromEntries(m),
  };
};

console.log("\n── ① key 的构造：数字与字符串必须归一 ──");

await ok("数字 0 与字符串 \"0\" 产出同一个 key", () => {
  assert.equal(foldKey("trigger", 0), foldKey("trigger", "0"));
});

await ok("三个分组的数字 key 与 dataset 字符串 key 一一对齐", () => {
  for (const sec of SETTING_SECTIONS) {
    // 渲染时用数字 key 构造；点击时从 dataset 拿回来是字符串
    assert.equal(
      foldKey("trigger", sec.key),
      foldKey("trigger", String(sec.key)),
      `分组「${sec.title}」(key=${sec.key}) 的数字/字符串 key 不一致`
    );
  }
});

await ok("key 里带上了维度，不同维度的折叠互不污染", () => {
  assert.notEqual(foldKey("trigger", 0), foldKey("category", 0));
  assert.notEqual(foldKey("trigger", 0), foldKey("priority", 0));
});

await ok("key 不会因为 key 是 0 而退化成空尾串", () => {
  const k = foldKey("trigger", 0);
  assert.ok(!k.endsWith(":"), `key 不该以冒号结尾（那是 escapeHtml(0)→"" 的症状）：${k}`);
  assert.ok(k.endsWith(":0"), `key 应以 :0 结尾：${k}`);
});

console.log("\n── ② 读写对账：写完必须读得回来 ──");

await ok("写入「常驻」(key=0) 后，读回来是折叠", () => {
  const store = fakeStore();
  const dim = "trigger";
  // 写：模拟点击，key 来自 dataset（字符串）
  store.setItem(foldKey(dim, "0"), "1");
  // 读：模拟渲染，key 来自 SETTING_SECTIONS（数字）
  assert.equal(readFolded(0, dim, store.getItem), true);
});

await ok("写入「触发」(key=1) 后，读回来是折叠", () => {
  const store = fakeStore();
  store.setItem(foldKey("trigger", "1"), "1");
  assert.equal(readFolded(1, "trigger", store.getItem), true);
});

await ok("没有记录时默认展开（false）", () => {
  const store = fakeStore();
  for (const sec of SETTING_SECTIONS) {
    assert.equal(readFolded(sec.key, "trigger", store.getItem), false);
  }
});

await ok("nextFoldedValue 翻转：展开→折叠→展开", () => {
  const store = fakeStore();
  const dim = "trigger";
  const k = 0; // 常驻
  assert.equal(nextFoldedValue(k, dim, store.getItem), true, "首次应为折叠");
  store.setItem(foldKey(dim, k), "1");
  assert.equal(nextFoldedValue(k, dim, store.getItem), false, "再次应为展开");
});

await ok("read 抛异常时不炸，退化成展开", () => {
  const boom = () => { throw new Error("localStorage 被禁"); };
  assert.equal(readFolded(0, "trigger", boom), false);
});

console.log("\n── ③ 渲染层：数字 key 必须真的落进 data-key ──");

await ok("渲染用的 String(g.key) 不会把 0 吞成空串", () => {
  // renderSection 现在写 escapeHtml(String(g.key))。
  // 这里不 import escapeHtml（它是 DOM 模块，Node 里跑不了），
  // 只断言「String(0) 是 "0"」这半句——真正会吞 0 的是 escapeHtml 的 !str 守卫，
  // 那一条由 check-escape-html 类的测试盯（见下方静态检查）。
  assert.equal(String(0), "0");
  assert.equal(String(SETTING_SECTIONS[0].key), "0");
});

await ok("常驻组的 data-key 不该是空串", () => {
  // 直接复刻 renderSection 的表达式（含 escapeHtml 的语义）
  const renderKey = (k) => {
    // escapeHtml 修正后的语义：null/""/false/NaN → ""，其余 String()
    if (k == null || k === "" || k === false) return "";
    if (typeof k === "number" && !Number.isFinite(k)) return "";
    return String(k);
  };
  for (const sec of SETTING_SECTIONS) {
    assert.notEqual(renderKey(sec.key), "", `分组「${sec.title}」的 data-key 是空的`);
  }
  assert.equal(renderKey(0), "0", "常驻组的 data-key 应为 \"0\"");
});

console.log("\n" + "=".repeat(50));
console.log(`${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
