// test/check-u1-wiring.mjs — U1 接线一致性静态检查
//
// 查的是「HTML 里的 id / class 与 JS 里的引用是否对得上」。
// 这类错（某个按钮忘了 id、某个模块 import 了不存在的导出）不会让语法报错，
// 但用户一点就静默失效——正是 RED-017 说的"没有入口的能力"。
//
// 为什么不用 UI 自动化逐点验证：webview 卡片 runtimeStatus 为 not_mounted 时
// click 事件不进 JS，describe_dom 一次返回 300+ 节点，烧上下文且不可靠。
// 静态接线检查 + 静态语法 + 用户目视，是更划算的组合。

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "ui/characters.html"), "utf8");
const modDir = path.join(root, "ui/assets/modules");

let errors = 0;
const fail = (msg) => { console.log(`  ❌ ${msg}`); errors++; };
const ok = (msg) => console.log(`  ✅ ${msg}`);

// ── 1. HTML 里的 id 收集 ──
const htmlIds = new Set();
for (const m of html.matchAll(/id="([^"]+)"/g)) htmlIds.add(m[1]);

// ── 2. 各模块 getElementById 的引用 ──
const files = fs.readdirSync(modDir).filter(f => f.endsWith(".js"));
const referenced = new Map();   // id → [file]
for (const f of files) {
  const src = fs.readFileSync(path.join(modDir, f), "utf8");
  for (const m of src.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)) {
    if (!referenced.has(m[1])) referenced.set(m[1], []);
    referenced.get(m[1]).push(f);
  }
}

console.log("\n=== U1 · HTML id 与 JS 引用一致性 ===\n");

const missing = [];
for (const [id, where] of referenced) {
  if (!htmlIds.has(id)) missing.push(`${id}  ←  ${where.join(", ")}`);
}
if (missing.length === 0) ok(`JS 引用的 ${referenced.size} 个 id 全部存在于 HTML`);
else for (const m of missing) fail(`HTML 里找不到 id: ${m}`);

// ── 3. dom.js 里的引用（改用 document.querySelector 的也要查） ──
const domSrc = fs.readFileSync(path.join(modDir, "dom.js"), "utf8");
const domRefs = [...domSrc.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1]);
const domClassRefs = [...domSrc.matchAll(/querySelector(?:All)?\(\s*["']\.([\w-]+)["']\s*\)/g)].map(m => "." + m[1]);
const domMissing = [...domRefs.filter(id => !htmlIds.has(id)), ...domClassRefs.filter(c => !html.includes(`class="`) || !html.includes(c.slice(1)))];
if (domMissing.length === 0) ok(`dom.js 的 ${domRefs.length + domClassRefs.length} 个引用全部有对应`);
else for (const m of domMissing) fail(`dom.js 引用了不存在的东西: ${m}`);

// ── 4. 抽屉 id 与 shell.js 的 DRAWERS 键 ──
// （2026-09-24 加上 board：黑板从数据层接到界面，成为第七个面板）
const shellSrc = fs.readFileSync(path.join(modDir, "shell.js"), "utf8");
for (const name of ["character", "settings", "board", "variables", "presets", "tools", "migration"]) {
  if (!htmlIds.has(`drawer-${name}`)) fail(`缺抽屉 #drawer-${name}`);
}
ok("七个抽屉容器 id 齐全");
if (!shellSrc.includes('data-drawer')) fail("topbar 菜单没绑 data-drawer");
else ok("顶栏菜单 → 抽屉的事件源存在");

// ── 4b. 右栏标签条：七个面板的常驻入口，必须一一对上 ──
// （2026-09-23 v3 结构落地：面板从 ⋯ 菜单里搬出来，变成看得见的标签）
// （2026-09-24 世界加入：设定库是静态资料，黑板是会变的状态，
//   两者同属「模型看到的世界」那一层，所以放在相邻位置）
//
// 列数也要一并断言：栅格列数要装得下「标签 + 收起键」。少一列，
// 多出来的标签会被挤进 26px 的收起列——布局静默崩掉，不报错。
const cssSrc = fs.readFileSync(path.join(root, "ui/assets/characters.css"), "utf8");
const tabStrip = html.match(/<nav class="ctx-tabs"[\s\S]*?<\/nav>/);
if (!tabStrip) fail("缺右栏标签条 .ctx-tabs");
else {
  const tabs = [...tabStrip[0].matchAll(/data-drawer="([^"]+)"/g)].map(m => m[1]);
  for (const name of ["character", "settings", "board", "variables", "presets", "tools", "migration"]) {
    if (!tabs.includes(name)) fail(`标签条缺面板入口: ${name}`);
  }
  if (tabs.length !== 7) fail(`标签条应有 7 个入口，实为 ${tabs.length}`);
  if (!tabStrip[0].includes('class="drawer-close ctx-close"')) fail("标签条缺收起键（.ctx-close）");

  const items = tabs.length + 1;   // 标签 + 收起键
  const cols = Number((cssSrc.match(/\.ctx-tabs \{[\s\S]*?grid-template-columns:\s*repeat\((\d+)/) || [])[1] || 0);
  if (!cols) fail("读不出 .ctx-tabs 的栅格列数");
  else {
    const rows = Math.ceil(items / cols);
    if (rows > 2) fail(`标签条 ${items} 个元素按 ${cols} 列要排 ${rows} 行，超出两行`);
    else if (cols * rows - items >= cols) fail(`标签条按 ${cols} 列会空出整行`);
    else if (errors === 0) ok(`右栏标签条 ${tabs.length} 个入口 + 收起键齐全（${cols} 列 × ${rows} 行）`);
  }
}

// ── 5. 一屏结构的关键类 ──
const mustHave = [
  ["shell 外壳", 'class="shell"'],
  // 页内侧栏已按产品决定删除（2026-09-23：列表归宿主 rail 独家），
  // sidebar / collapse / expand / characters-list / conversations-list
  // 五项随设计移除——测试断言的是结构，结构变了断言跟着变。
  ["右栏标签条", 'id="ctx-tabs"'],
  ["顶栏 ⋯", 'id="app-more-btn"'],
  ["多存档选择器", 'id="conv-picker-modal"'],
  ["预设编辑器", 'id="preset-editor-modal"']
];
for (const [label, needle] of mustHave) {
  if (!html.includes(needle)) fail(`缺 ${label}（找不到 ${needle}）`);
}

// ── 6. 不该再存在的东西（旧六 Tab） ──
const gone = [
  ['class="tabs"', "旧 Tab 栏"],
  ['data-tab=', "旧 Tab 数据集"],
  ['id="view-characters"', "旧角色卡视图容器"],
  ['id="view-settings"', "旧设定库视图容器"],
  ['id="view-variables"', "旧变量视图容器"],
  ['id="view-tools"', "旧工具视图容器"],
  ['id="view-migration"', "旧迁移视图容器"],
  ['class="chat-layout"', "旧双栏布局容器"]
];
for (const [needle, label] of gone) {
  if (html.includes(needle)) fail(`${label} 还在 HTML 里（${needle}）`);
}
if (errors === 0) ok("旧六 Tab 结构已清干净");

// ── 7. CSS 里新布局的锚点 ──
const css = fs.readFileSync(path.join(root, "ui/assets/characters.css"), "utf8");
for (const needle of [".shell {", ".ctx-tabs {", ".char-list .card", ".drawer {", ".sb-foot", ".pe-blocks", ".picker-item"]) {
  if (!css.includes(needle)) fail(`CSS 缺 ${needle}`);
}
if (errors === 0) ok("CSS 新布局锚点齐全");

// ── 8. main.js 不再有 Tab 切换逻辑 ──
const mainSrc = fs.readFileSync(path.join(modDir, "main.js"), "utf8");
if (mainSrc.includes('data-tab')) fail("main.js 还在处理 Tab 切换");
else ok("main.js 已无 Tab 切换逻辑");

console.log("\n" + "=".repeat(50));
console.log(errors === 0 ? "U1 接线一致性全部通过" : `失败 ${errors} 项`);
console.log("=".repeat(50));
process.exit(errors > 0 ? 1 : 0);
