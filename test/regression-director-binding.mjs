// test/regression-director-binding.mjs — 公式绑定与进度的形状归一
//
// 为什么要测这个：
//   2026-09-28 之前一场只绑一条公式，进度是**扁平**的：
//     directorId: "a"            /  __dir: { 张力: 3 }
//   改成多条后两处都换了形状：
//     directorIds: ["a", "b"]    /  __dir: { a: { 张力: 3 } }
//
//   而**老对话文件不会自动改写**——它们读进来还是旧形状。
//   所以每个读点都得同时认两种。这份「怎么认」如果写错，
//   后果是「老对话打开后进度全归零」：不报错，只是角色突然忘了自己推到哪。
//
//   所以这个测试盯三件事：
//     ① 旧形状永远读得出来（兼容是底线）
//     ② 新形状读得准（各归各家，互不串）
//     ③ 升格只发生一次，且旧数据不会变成孤儿

import assert from "node:assert/strict";
import {
  directorIdsOf, normalizeDirectorIds,
  dirStateOf, writeDirState, isLegacyDirState
} from "../lib/director/binding.js";

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "\n      " + (e?.message ?? e)); }
}

console.log("\n── ① 绑定 id 列表：旧字段永远读得到 ──");

ok("只有旧的 directorId → 包成单元素数组", () => {
  assert.deepEqual(directorIdsOf({ directorId: "a" }), ["a"]);
});

ok("只有 directorIds → 直接用", () => {
  assert.deepEqual(directorIdsOf({ directorIds: ["a", "b"] }), ["a", "b"]);
});

ok("两者都有 → directorIds 优先（新形状权威）", () => {
  assert.deepEqual(directorIdsOf({ directorIds: ["a", "b"], directorId: "a" }), ["a", "b"]);
});

ok("directorIds 是空数组 → 退回旧字段", () => {
  // 空数组意味着「刚清空」，但旧字段还留着一条——按新的算（空）
  // 这一条要小心：空数组是有意义的（表示已解绑），不能当「没有」处理
  assert.deepEqual(directorIdsOf({ directorIds: [], directorId: "a" }), ["a"]);
});

ok("什么都没有 → 空数组", () => {
  assert.deepEqual(directorIdsOf({}), []);
  assert.deepEqual(directorIdsOf(null), []);
});

ok("空串 / 空白 / 重复 → 都被清掉", () => {
  assert.deepEqual(directorIdsOf({ directorIds: ["a", "", "  ", "a", "b"] }), ["a", "b"]);
});

console.log("\n── ② 写侧归一：同时维护新旧两个字段 ──");

ok("写 [a,b] → directorIds=[a,b]，directorId=a（第一条）", () => {
  assert.deepEqual(normalizeDirectorIds(["a", "b"]), { directorIds: ["a", "b"], directorId: "a" });
});

ok("写 [] → 两个字段都空（解绑）", () => {
  assert.deepEqual(normalizeDirectorIds([]), { directorIds: [], directorId: "" });
});

ok("写侧也去重去空", () => {
  assert.deepEqual(normalizeDirectorIds(["a", "a", "", "b"]), { directorIds: ["a", "b"], directorId: "a" });
});

console.log("\n── ③ 进度读：旧形状（扁平）──");

ok("旧扁平形状：整份都是这一条的", () => {
  assert.deepEqual(dirStateOf({ 张力: 3, 回合: 5 }, "a"), { 张力: 3, 回合: 5 });
});

ok("旧扁平形状：布尔也算标量", () => {
  assert.deepEqual(dirStateOf({ 已告白: true, 张力: 3 }, "a"), { 已告白: true, 张力: 3 });
});

ok("空对象 → 空", () => {
  assert.deepEqual(dirStateOf({}, "a"), {});
});

ok("null / 非对象 → 空（不抛）", () => {
  assert.deepEqual(dirStateOf(null, "a"), {});
  assert.deepEqual(dirStateOf("x", "a"), {});
  assert.deepEqual(dirStateOf([1, 2], "a"), {});
});

console.log("\n── ④ 进度读：新形状（按公式分家）──");

ok("新形状：取自己那一份", () => {
  const raw = { a: { 张力: 3 }, b: { 好感: 2 } };
  assert.deepEqual(dirStateOf(raw, "a"), { 张力: 3 });
  assert.deepEqual(dirStateOf(raw, "b"), { 好感: 2 });
});

ok("新形状：各归各家，互不串", () => {
  const raw = { a: { 回合: 5 }, b: { 回合: 9 } };
  assert.equal(dirStateOf(raw, "a").回合, 5);
  assert.equal(dirStateOf(raw, "b").回合, 9);
});

ok("新形状但这条还没进度 → 空（不是把别人的给它）", () => {
  const raw = { a: { 张力: 3 } };
  assert.deepEqual(dirStateOf(raw, "c"), {});
});

ok("返回的是副本，改它不影响原对象", () => {
  const raw = { a: { 张力: 3 } };
  const got = dirStateOf(raw, "a");
  got.张力 = 999;
  assert.equal(raw.a.张力, 3, "返回了原对象——调用方一改就污染存储");
});

console.log("\n── ⑤ 进度写：单条不动形状，多条才升格 ──");

ok("旧形状 + 单条 → 维持扁平（老对话不被无谓改写）", () => {
  const next = writeDirState({ 张力: 3 }, "a", { 张力: 4 });
  assert.deepEqual(next, { 张力: 4 });
});

ok("旧形状 + 要求升格 → 旧数据归到 migrateFrom 名下", () => {
  const next = writeDirState({ 张力: 3 }, "b", { 好感: 1 }, { forceNested: true, migrateFrom: "a" });
  assert.deepEqual(next, { a: { 张力: 3 }, b: { 好感: 1 } });
});

ok("升格后旧数据不是孤儿（还能按 a 读到）", () => {
  const next = writeDirState({ 张力: 3 }, "b", { 好感: 1 }, { forceNested: true, migrateFrom: "a" });
  assert.deepEqual(dirStateOf(next, "a"), { 张力: 3 }, "旧进度丢了——升格时没搬过去");
});

ok("新形状 + 写一条 → 只动自己那格，别人不动", () => {
  const next = writeDirState({ a: { 张力: 3 }, b: { 好感: 2 } }, "a", { 张力: 9 });
  assert.deepEqual(next, { a: { 张力: 9 }, b: { 好感: 2 } });
});

ok("写空的 directorId → 原样返回（不造垃圾键）", () => {
  const raw = { a: { 张力: 3 } };
  assert.deepEqual(writeDirState(raw, "", { x: 1 }), raw);
});

ok("写入不污染原对象", () => {
  const raw = { a: { 张力: 3 } };
  writeDirState(raw, "a", { 张力: 9 });
  assert.equal(raw.a.张力, 3);
});

console.log("\n── ⑥ 形状判据 ──");

ok("扁平形状被认出来", () => {
  assert.equal(isLegacyDirState({ 张力: 3 }), true);
  assert.equal(isLegacyDirState({ 已告白: true }), true);
});

ok("新形状不被误认成扁平", () => {
  assert.equal(isLegacyDirState({ a: { 张力: 3 } }), false);
});

ok("空对象不算扁平（没有数据可升格）", () => {
  assert.equal(isLegacyDirState({}), false);
});

console.log("\n" + "=".repeat(50));
console.log(`${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
