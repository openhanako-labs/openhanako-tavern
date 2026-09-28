// test/regression-gallery-query.mjs — 图库「两级范围」的纯规则
//
// 判据来自 docs/plans/2026-09-25-scene-illustration-and-gallery.md 第 3 批
// 3.3/3.4/3.5，以及 ui/assets/modules/gallery-query.js 的文件头。
//
// 盯四件事：
//   ① 本场拼 conversationId，全部不拼——两级的分界是「归属」
//   ② 没开会话时**不拼空串** conversationId=（会恒空，且不像 bug）
//   ③ 本场 + 立绘 的空态必须说「立绘不属于某一场」（这是设计，不是坏）
//   ④ 计数空时返回空串（整行隐藏，不留 "0 张"）
//
// 反证：
//   · 把 `if (scope === "conv" && conv)` 改成只看 scope → ② 直接红
//   · 把 galleryEmptyState 里 conv+portrait 那一支删掉 → ③ 直接红
//   · 把 galleryCountText 的 `if (t <= 0) return ""` 改成返回 `${who} 0 张` → ④ 直接红
//   · 把 scope 默认值从 "all" 改成 "conv" → ① 直接红

import assert from "node:assert/strict";
import {
  buildGalleryQuery,
  galleryEmptyState,
  galleryCountText
} from "../ui/assets/modules/gallery-query.js";

let pass = 0;
const failed = [];
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed.push(name);
    console.error(`  ❌ ${name}\n     ${e?.message || e}`);
  }
}

// ── ① 本场：拼 conversationId ──
ok("① 本场 + 有 id → 只拼 conversationId", () => {
  const q = buildGalleryQuery({ scope: "conv", conversationId: "c_ab12" });
  assert.equal(q, "?conversationId=c_ab12");
});

// ── ② 全部：不拼 conversationId（分界是归属，不是时间）──
ok("② 全部 → 不拼 conversationId", () => {
  // 传了也不拼。全部级是「所有场次 + 所有立绘」，带上 id 就退回本场了。
  const q = buildGalleryQuery({ scope: "all", conversationId: "c_ab12" });
  assert.equal(q, "");
});

// ── ③ 本场但没开会话：不拼空串 ──
ok("③ 本场 + 没开会话 → 空串，不拼 conversationId=", () => {
  for (const id of [null, undefined, "", "   "]) {
    const q = buildGalleryQuery({ scope: "conv", conversationId: id });
    assert.equal(q, "", `conversationId=${JSON.stringify(id)} 时不该拼出参数`);
  }
});

// ── ④ 类型筛选 ──
ok("④ kind 只在有值时拼", () => {
  assert.equal(buildGalleryQuery({ kind: "scene" }), "?kind=scene");
  assert.equal(buildGalleryQuery({ kind: "portrait" }), "?kind=portrait");
  for (const k of ["", null, undefined, "  "]) {
    assert.equal(buildGalleryQuery({ kind: k }), "", `kind=${JSON.stringify(k)} 不该拼出参数`);
  }
});

// ── ⑤ 两个条件一起 ──
ok("⑤ 本场 + 场景 → 两个参数都在", () => {
  const q = buildGalleryQuery({ scope: "conv", kind: "scene", conversationId: "c_9" });
  // 顺序按插入来（conversationId 先、kind 后）——查询串的语义与顺序无关，
  // 这里只断言"两个都在、值对"，不断言顺序：断了顺序就是给实现加枷锁。
  assert.equal(q.includes("conversationId=c_9"), true);
  assert.equal(q.includes("kind=scene"), true);
  assert.equal(q.startsWith("?"), true);
  assert.equal((q.match(/&/g) || []).length, 1, "只该有一个 &");
});

// ── ⑥ 默认值：全部 ──
ok("⑥ 不传 scope → 当全部（默认值）", () => {
  assert.equal(buildGalleryQuery({}), "");
  assert.equal(buildGalleryQuery(), "");
});

// ── ⑦ 本场 + 立绘：恒空，且空态必须说清为什么 ──
ok("⑦ 本场 + 立绘 → 空态说「立绘不属于某一场」", () => {
  const s = galleryEmptyState({ scope: "conv", kind: "portrait", hasConv: true });
  // 标题直接点明这是设计
  assert.match(s.title, /场景插图/);
  // 解释里要说清归属，并给出路（去「全部」）
  assert.match(s.desc, /角色卡/);
  assert.match(s.desc, /全部/);
  assert.ok(s.ico, "空态要有图标");
});

// ── ⑧ 本场 + 没开会话 ──
ok("⑧ 本场 + 没开会话 → 空态说「还没打开一场对话」", () => {
  const s = galleryEmptyState({ scope: "conv", kind: "", hasConv: false });
  assert.match(s.title, /对话/);
  assert.match(s.desc, /全部/);   // 给出路
});

// ── ⑨ 本场 + 开会话了但没图 ──
ok("⑨ 本场 + 有会话 + 没图 → 教用法（[场景] / 手动补一张）", () => {
  const s = galleryEmptyState({ scope: "conv", kind: "", hasConv: true });
  assert.match(s.title, /这一场/);
  assert.match(s.desc, /场景/);
  assert.match(s.desc, /补一张场景图/);
});

// ── ⑩ 全部级的三种空 ──
ok("⑩ 全部 + 三种 kind → 三种不同文案", () => {
  const none = galleryEmptyState({ scope: "all", kind: "" });
  const por = galleryEmptyState({ scope: "all", kind: "portrait" });
  const scn = galleryEmptyState({ scope: "all", kind: "scene" });

  assert.match(none.title, /出过图/);
  assert.match(none.desc, /立绘/);        // 两个来源都要说
  assert.match(none.desc, /场景插图/);

  assert.match(por.title, /立绘/);
  assert.match(por.desc, /生成立绘/);     // 教这个动作在哪

  assert.match(scn.title, /场景插图/);
  assert.match(scn.desc, /场景/);

  // 三者不能是同一句话——同一句就说明分支白写了
  assert.notEqual(none.title, por.title);
  assert.notEqual(none.title, scn.title);
  assert.notEqual(por.title, scn.title);
});

// ── ⑪ 计数行 ──
ok("⑪ 计数：空 → 空串；部分 → x/y；全显示 → n 张", () => {
  assert.equal(galleryCountText({ scope: "conv", total: 0 }), "");
  assert.equal(galleryCountText({ scope: "all", total: 0, shown: 0 }), "");
  assert.equal(galleryCountText({ scope: "conv", shown: 20, total: 47 }), "本场 20 / 47 张");
  assert.equal(galleryCountText({ scope: "all", shown: 47, total: 47 }), "全部 47 张");
  // shown 超过 total（不可能，但如果发生了也不该显示成 47/47 之外的东西）
  assert.equal(galleryCountText({ scope: "all", shown: 99, total: 47 }), "全部 47 张");
});

// ── ⑫ 计数行的「本场 / 全部」要跟 scope 走 ──
ok("⑫ 计数的量词跟着 scope 走", () => {
  assert.match(galleryCountText({ scope: "conv", shown: 1, total: 5 }), /^本场/);
  assert.match(galleryCountText({ scope: "all", shown: 1, total: 5 }), /^全部/);
});

// ── ⑬ 宽容：scope 传了不认识的值 ──
ok("⑬ scope 是不认识的值 → 当全部，不抛", () => {
  // 前端 select 只有 conv/all，但契约被别处调用时不能炸
  assert.equal(buildGalleryQuery({ scope: "world", conversationId: "c_1" }), "");
  assert.match(galleryCountText({ scope: "world", shown: 1, total: 2 }), /^全部/);
});

console.log(`\n${pass} 通过 / ${failed.length} 失败`);
if (failed.length) {
  failed.forEach((f) => console.error("  - " + f));
  process.exit(1);
}
