// test/regression-illustration-failure.mjs — 失败文案：一句人话 + 原话一个字不丢
//
// 夹具直接用**真机原话**（2026-09-27「装甲核心」那一场，用户截图里那条）。
// 写这条测试的原因：那种文案在开发机上永远看不见——你得真跑一次失败才知道
// 屏幕上会是一坨跨四层的调用链。
//
// 三条纪律钉住：
//   ① 原话一个字不丢（判据 4：不许换成一句笼统的「生成失败」）
//   ② 第一眼是**人话**，不是调用链
//   ③ 连原因都没有时，要说「该报一下」，不许写「未知原因」糊过去

import assert from "node:assert/strict";

import { splitFailure, detailIsShort } from "../ui/assets/modules/illustration-failure.js";

let pass = 0;
const failed = [];
function ok(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e.message}`);
    failed.push(name);
  }
}

// 真机原话（逐字抄自截图）
const REAL = "取不到图片字节：getTaskResources → APP_HOST_ERROR Media task output is not complete: "
  + "getTaskFileContents → task 里没有 sessionFiles (status=failed): task 状态 → 任务失败: "
  + "Media task failed. Review the provider configuration and try again.";

console.log("\n场景插图 · 失败文案");

ok("① 真机原话 → 分成「人话」和「原话」两半，原话不丢", () => {
  const r = splitFailure(REAL);
  assert.equal(r.detail, REAL, "原话必须逐字保留");
  assert.ok(r.headline.length > 0, "得有那句人话");
  assert.ok(r.headline.length < 40, `人话别写成一篇（实际 ${r.headline.length} 字）`);
  // 人话里不该出现调用链那些符号
  for (const junk of ["APP_HOST_ERROR", "getTask", "→", "sessionFiles"]) {
    assert.ok(!r.headline.includes(junk), `人话里不该出现 ${junk}`);
  }
});

ok("② 第一眼看得懂：不是「未知原因」那种糊过去的写法", () => {
  const r = splitFailure(REAL);
  assert.ok(!/未知原因/.test(r.headline));
  assert.ok(/出图|图/.test(r.headline), "该说清是出图这一步的事");
});

ok("③ 连原因都没有 → 说「该报一下」，别假装知道", () => {
  for (const empty of [undefined, null, "", "   "]) {
    const r = splitFailure(empty);
    assert.equal(r.detail, "", "没有原话就是空");
    assert.ok(/报/.test(r.headline), `空原因要说“值得报一下”，实际：${r.headline}`);
  }
});

ok("④ 参考图那类失败要说参考图（它是最常见的那一种）", () => {
  const r = splitFailure("出图失败：provider does not support reference image");
  assert.ok(/参考图/.test(r.headline), `该点名参考图，实际：${r.headline}`);
});

ok("⑤ 具体规则优先于笼统规则", () => {
  // 这句同时含「参考图」和「provider configuration」——
  // 先命中的那条（参考图）才是有用的那一句。
  const r = splitFailure("Media task failed. Review the provider configuration. "
    + "provider does not support reference image");
  assert.ok(/参考图/.test(r.headline), `该优先说参考图，实际：${r.headline}`);
});

ok("⑥ 短原话默认展开，长原话收进「详情」", () => {
  assert.equal(detailIsShort("网络超时"), true, "一句以内该展开");
  assert.equal(detailIsShort(REAL), false, "跨了几层调用链的该收起来");
  assert.equal(detailIsShort(""), false, "空的不展开");
  assert.equal(detailIsShort("a\nb"), false, "多行的不展开");
});

ok("⑦ 超时 / 网络 / 文件没了 各有人话", () => {
  assert.ok(/超时/.test(splitFailure("fetch timed out after 120000ms").headline));
  assert.ok(/连不上/.test(splitFailure("fetch failed: ECONNREFUSED").headline));
  assert.ok(/不在了/.test(splitFailure("ENOENT: no such file").headline));
});

console.log("");
if (failed.length) {
  console.error(`❌ 失败文案：${pass} 过 / ${failed.length} 败`);
  process.exit(1);
}
console.log(`✅ 失败文案：${pass} 过 / 0 败`);
