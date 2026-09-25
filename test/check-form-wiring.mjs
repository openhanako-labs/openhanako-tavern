// test/check-form-wiring.mjs
//
// 带 id 的表单控件（input / textarea / select），ui/ 下必须有 JS 读它。
//
// 为什么单独立一条判据：这类漏接是**最安静**的一种——
// 控件长得正常、能聚焦、能打字、样式也在，只是按下去以后值被丢掉，
// 控制台一声不吭。用户会以为是"这个功能不好用"，而不是"它根本没接"。
//
// 真的发生过（2026-09-25）：
//   「新对话」弹窗里的 #conv-user-name / #conv-persona 只在 HTML 里存在，
//   全仓库没有一处 getElementById 碰过它们。用户填了人设、点"创建"，
//   值被丢掉——还顺带把该继承的人设覆盖成空。
//
// 为什么只查表单控件、不查全部 id：
//   大量 id 是 CSS 锚点、<label for> 目标、容器标记，引用它们的地方不是 JS。
//   只查"必须有人读"的那一类，误报才低——绿得没有意义的绿是最坏的绿。
//
// 判据为什么是“id 在 JS 里作为字面量出现过”而不是 getElementById：
//   代码里有两套读元素的写法（$("q") 和 set("bc-id", …) 这种把 id 当字符串
//   传的帮手）。只认 getElementById 会一口气报出 34 个误报——第一版就是这样，
//   差点让我以为半边界面都没接。改宽之后误报归零。
//
// 已知盲区（显式登记）：
//   · 只认字面量；拼出来的 id 抓不到
//   · 反过来，id 只出现在注释/无关字符串里也算"read"——这是故意的：
//     宁可漏报，也不要报一堆假的。
//   · 短 id（如 "q"）会跟无关的 "q" 字面量撞——同上，属漏报方向。
//
// 已知例外写在 ALLOW 里，**每一条都要写理由**，不许默默加。
//
// 用法：
//   node test/check-form-wiring.mjs            # 查仓库
//   node test/check-form-wiring.mjs <目录>      # 查副本（反证：喂坏样本必须红）

import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(here, "..");

// 已登记的**未接线**债（不是“不需要 JS”——是“还不知道该谁读”）。
// 它们只报警告、不算红；但每跑一次都会打印，而且**新增的一个都跑不掉**。
// 登记一批旧的、拦住所有新的——这是这类护栏唯一可持续的活法。
const KNOWN_UNWIRED = new Map([
  // 这三个是误报：id 由模板拼出，字面量扫描看不到。
  ["rf-surface-display", "id 由模板拼出：getElementById(`rf-surface-${s}`)，regex.js:170/221/296"],
  ["rf-surface-prompt", "同 rf-surface-display：模板拼出"],
  ["rf-surface-stored", "同 rf-surface-display：模板拼出"],
  // 以下几个是 2026-09-25 新发现的债：
  // 全仓库 JS（含 dom.js 的集中 id 映射）里一次没出现。
  // 是“改名/重构后遗留的死表单”还是“走了我们没看出来的读法”，
  // 尚未逐条确认——所以记成债，不记成“已修”。
  ["sf-description", "未查明：js/dom 里无引用（设定库编辑器表单）"],
  ["sf-id", "未查明：js/dom 里无引用（设定库编辑器表单）"],
  ["sf-logic", "未查明：js/dom 里无引用（设定库编辑器表单）"],
  ["sf-regex", "未查明：js/dom 里无引用（设定库编辑器表单）"],
  ["sf-type", "未查明：js/dom 里无引用（设定库编辑器表单）"],
  ["vf-editable", "未查明：js/dom 里无引用（变量编辑器表单）"],
  ["vf-id", "未查明：js/dom 里无引用（变量编辑器表单）"],
  ["vf-label", "未查明：js/dom 里无引用（变量编辑器表单）"],
  // 这条已经确认是**真死**：
  ["skip-existing-check", "已确认：无 name 属性、JS 里零引用 → 导入时这个勾选不起作用"],
]);

// id → 理由。空着最好；往里加东西之前先问"它真的不需要 JS 吗"。
// （ALLOW 是“合法地不需要 JS”；KNOWN_UNWIRED 是“还不知道谁读”——两者别混。）
const ALLOW = new Map([]);

const HTML_FILES = ["ui/characters.html", "ui/rail.html"];
const JS_DIRS = ["ui", "ui/assets", "ui/assets/modules"];

const exists = (p) => fs.existsSync(path.join(root, p));
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

// ── 1. 收集带 id 的表单控件 ──
const FORM_RE = /<(input|textarea|select)\b[^>]*\bid="([^"]+)"/gi;
const controls = new Map(); // id → file
let htmlSeen = 0;
for (const f of HTML_FILES) {
  if (!exists(f)) continue;
  const src = read(f);
  htmlSeen++;
  for (const m of src.matchAll(FORM_RE)) {
    controls.set(m[2], { tag: m[1].toLowerCase(), file: f });
  }
}

// ── 2. 收集 JS 里的 getElementById / querySelector("#id") ──
const referenced = new Set();
const jsFiles = [];
let allJs = "";
for (const d of JS_DIRS) {
  if (!exists(d)) continue;
  for (const f of fs.readdirSync(path.join(root, d))) {
    if (!f.endsWith(".js")) continue;
    jsFiles.push(path.join(d, f));
  }
}
for (const f of jsFiles) {
  const src = read(f);
  allJs += "\n" + src;
  for (const m of src.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)) referenced.add(m[1]);
  for (const m of src.matchAll(/querySelector(?:All)?\(\s*["'`]#([A-Za-z0-9_-]+)["'`]/g)) referenced.add(m[1]);
}

// 宽判据：id 作为字面量在 JS 里出现过就算“有人读”。
// （代码里有 $("id") 和 set("id", …) 两套写法，只认 getElementById 会误报。）
const literalInJs = (id) =>
  allJs.includes(`"${id}"`) || allJs.includes(`'${id}'`) || allJs.includes(`#${id}`);

// ── 判据失效就不许判绿 ──
if (htmlSeen === 0) {
  console.log("❌ 一个 HTML 都没读到——判据失效，不能算绿");
  process.exit(1);
}
if (controls.size === 0 || jsFiles.length === 0) {
  console.log(`❌ 扫描结果为空（表单控件 ${controls.size} 个 / JS 文件 ${jsFiles.length} 个）——判据失效`);
  process.exit(1);
}

let bad = 0;
let known = 0;
console.log(`表单接线：${controls.size} 个带 id 的控件，扫了 ${jsFiles.length} 个 JS 文件`);
for (const [id, info] of [...controls].sort()) {
  if (referenced.has(id) || literalInJs(id)) continue;
  if (ALLOW.has(id)) {
    console.log(`  · ${id}  (${info.tag}) —— 已登记例外：${ALLOW.get(id)}`);
    continue;
  }
  if (KNOWN_UNWIRED.has(id)) {
    console.log(`  ⚠ ${id}  (${info.tag}) —— 已登记未接线：${KNOWN_UNWIRED.get(id)}`);
    known++;
    continue;
  }
  console.log(`  ❌ ${id}  (${info.tag}, ${info.file}) —— 没有 JS 读它`);
  bad++;
}

if (known) {
  console.log(`\n⚠ 另有 ${known} 个已登记未接线（债，不阻塞）——见文件头的 KNOWN_UNWIRED 注释。`);
}
if (bad) {
  console.log(`\n❌ ${bad} 个表单控件没有任何 JS 读——能打字、能聚焦，但按下去什么都不发生。`);
  process.exit(1);
}
console.log("\n✓ 表单接线完整（新增漏接一个都不放过）");
