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

// ── 4. 面板入口 → 容器：**每个入口都要落到一个真容器上** ──
//
// 2026-09-24：世界从抽屉改成"常驻在聊天左边的可折叠栏"（#board-col，卡里的形状）。
// 所以这一节改成两半：
//   · 七个真抽屉：id 必须存在
//   · 「世界」：不再是抽屉，但**它必须仍然是个活入口**——
//     shell.openDrawer 里那个特例（name === "board" → 开列）被删掉的话，
//     `DRAWERS["board"]` 是 undefined，openDrawer 会**静默 return**：
//     按钮还在、点了没反应。这种“静默死入口”正是这一节真正要拦的东西。
const shellSrc = fs.readFileSync(path.join(modDir, "shell.js"), "utf8");
const REAL_DRAWERS = ["character", "settings", "variables", "presets", "regex", "tools", "migration"];
for (const name of REAL_DRAWERS) {
  if (!htmlIds.has(`drawer-${name}`)) fail(`缺抽屉 #drawer-${name}`);
}
ok(`${REAL_DRAWERS.length} 个抽屉容器 id 齐全`);

if (!htmlIds.has("board-col")) fail("缺黑板列 #board-col（世界已经不是抽屉了，它该在这儿）");
else if (htmlIds.has("drawer-board")) fail("#drawer-board 又回来了？世界现在是 #board-col，两套会让入口分不清打哪个");
else {
  // 只看 openDrawer 这个函数体——上一版写成“源码里提过 board 就算”，
  // 而懒加载链里还有一句 `else if (name === "board")`，
  // 于是把特例删掉它照样是绿的（**没有牙的断言**，反证当场揭穿了）。
  const start = shellSrc.indexOf("export async function openDrawer");
  const nextExport = shellSrc.indexOf("\nexport ", start + 1);
  const body = start < 0 ? "" : shellSrc.slice(start, nextExport > start ? nextExport : undefined);
  const guard = /if \(name === "board"\)\s*\{[^}]*toggleBoardColumn\(\)\s*;[^}]*return\s*;/.test(body);
  if (!guard) fail('openDrawer 开头没有 "board" 的提前返回：入口会静默失效（按钮在、点了没反应）');
  else if (!/export function toggleBoardColumn/.test(shellSrc)) fail("shell.js 没有 toggleBoardColumn：入口无处可去");
  else ok("世界的入口是活的（→ #board-col，经 openDrawer 提前返回）");
}

if (!shellSrc.includes('data-drawer')) fail("topbar 菜单没绑 data-drawer");
else ok("顶栏菜单 → 抽屉的事件源存在");

// ── 4b. 导航分层：一级四个标签 + 二级全量入口 ──
//
// （2026-09-23 v3 结构落地：面板从 ⋯ 菜单里搬出来，变成看得见的标签）
// （2026-09-24 面板涨到八个后的定案）
//
// 八个标签挤在 344px 的横带上排不下也看不清，而且横带每多一行就少一行
// 聊天。所以定案：**一级只放「这一场里你会看一眼或改一下的」四个**
// （角色 / 设定库 / 世界 / 变量），其余全落 ⋯ 菜单。
//
// 于是这里断言的不是「标签条有几个」，而是两件真事：
//   ① 一级恰好四个，且必须是那四个（多了就回到挤不下的老路）
//   ② **每个抽屉都能从 ⋯ 菜单走到**——有面板没门，用户永远找不到它
//
// 列数也一并断言：栅格列数要装得下「标签 + 收起键」。少一列，
// 多出来的标签会被挤进 26px 的收起列——布局静默崩掉，不报错。
const cssSrc = fs.readFileSync(path.join(root, "ui/assets/characters.css"), "utf8");
const tabStrip = html.match(/<nav class="ctx-tabs"[\s\S]*?<\/nav>/);
if (!tabStrip) fail("缺右栏标签条 .ctx-tabs");
else {
  const PRIMARY = ["character", "settings", "board", "variables"];
  const tabs = [...tabStrip[0].matchAll(/data-drawer="([^"]+)"/g)].map(m => m[1]);

  for (const name of PRIMARY) {
    if (!tabs.includes(name)) fail(`一级标签条缺面板入口: ${name}`);
  }
  if (tabs.length !== PRIMARY.length) {
    fail(`一级标签条应恰好 ${PRIMARY.length} 个入口，实为 ${tabs.length}（多出来的该往 ⋯ 菜单放）`);
  }
  if (!tabStrip[0].includes('class="drawer-close ctx-close"')) fail("标签条缺收起键（.ctx-close）");

  const items = tabs.length + 1;   // 标签 + 收起键
  // 列数要把**尾部固定轨道**一起算上：`repeat(4, minmax(0,1fr)) 26px`
  // 是 5 列，不是 4 列（最后那个 26px 是给收起键的）。
  // 只取 repeat() 的数字会多数出一行——护栏报告的行数不对，
  // 就说明它量错了地方，那种护栏比没有更糟。
  const grid = (cssSrc.match(/\.ctx-tabs \{[\s\S]*?grid-template-columns:\s*([^;]+);/) || [])[1] || "";
  const rep = grid.match(/repeat\((\d+),\s*minmax\(0,\s*1fr\)\)/);
  const fixedTracks = [...grid.matchAll(/\d+px/g)].length;
  const cols = rep ? Number(rep[1]) + fixedTracks : 0;
  if (!cols) fail(`读不出 .ctx-tabs 的栅格列数（读到：${grid || "空"}）`);
  else {
    const rows = Math.ceil(items / cols);
    if (rows > 2) fail(`标签条 ${items} 个元素按 ${cols} 列要排 ${rows} 行，超出两行`);
    else if (cols * rows - items >= cols) fail(`标签条按 ${cols} 列会空出整行`);
    else if (errors === 0) ok(`一级标签条 ${tabs.length} 个入口 + 收起键（${cols} 列 × ${rows} 行）`);
  }

  // ── 二级：⋯ 菜单必须装下全部抽屉 ──
  // 切到下一个 .more-wrap 为止——菜单里有嵌套的 <div class="sep">，
  // 用 `<\/div>` 收口会在第一个分隔符那里就截断。
  const mStart = html.indexOf('id="app-more-menu"');
  const mEnd = html.indexOf('id="chat-more-btn"');
  const menu = mStart >= 0 && mEnd > mStart ? html.slice(mStart, mEnd) : null;
  if (!menu) fail("找不到 ⋯ 菜单 #app-more-menu");
  else {
    const entries = [...menu.matchAll(/data-drawer="([^"]+)"/g)].map(m => m[1]);
    // ⋯ 菜单要装下**全部**面板入口：七个真抽屉 + 「世界」（它现在是列，但入口不变）
    const ALL_ENTRIES = [...REAL_DRAWERS, "board"];
    const missing = ALL_ENTRIES.filter(n => !entries.includes(n));
    if (missing.length) fail(`⋯ 菜单缺面板入口: ${missing.join(", ")}（有面板没门）`);
    else ok(`⋯ 菜单装下全部 ${ALL_ENTRIES.length} 个面板入口`);
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

// ── 9. HTML 标签配平与 id 唯一性 ──
//
// 这一条是拿真伤换来的：一次性插入脚本里写了
// `indexOf("    </div>\n")`，而它命中了缩进更深的 `      </div>\n` 的
// **尾部子串**（子串匹配不认行首），块尾切错，留下半截块 + 一对不配平的 div。
// 浏览器不会报错，它会「尽力而为」地猜出另一棵树——所以必须静态自查。
//
// id 重复是同一类伤：重复时 getElementById 只返回第一个，
// 第二个就成了「看得见但永远点不动」的鬼。
{
  const divOpen = (html.match(/<div\b/g) || []).length;
  const divClose = (html.match(/<\/div>/g) || []).length;
  if (divOpen !== divClose) fail(`<div> 不配平：${divOpen} 开 / ${divClose} 闭`);
  else ok(`<div> 配平（${divOpen} 对）`);

  for (const tag of ["form", "nav", "main", "section", "body", "html"]) {
    const o = (html.match(new RegExp(`<${tag}\\b`, "g")) || []).length;
    const c = (html.match(new RegExp(`</${tag}>`, "g")) || []).length;
    if (o !== c) fail(`<${tag}> 不配平：${o} 开 / ${c} 闭`);
  }

  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  const dup = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
  if (dup.length) fail(`HTML 里重复的 id：${dup.join(", ")}`);
  else ok(`${ids.length} 个 id 无重复`);
}

// ── 8. main.js 不再有 Tab 切换逻辑 ──
const mainSrc = fs.readFileSync(path.join(modDir, "main.js"), "utf8");
if (mainSrc.includes('data-tab')) fail("main.js 还在处理 Tab 切换");
else ok("main.js 已无 Tab 切换逻辑");

// ── 9. form 里的 button 必须显式写 type ──
//
// `<button>` 在 `<form>` 里**不写 type 就是 submit**：点一下等于提交表单，
// 浏览器就导航——整页重载。在宿主里 iframe 一切换，URL 上的
// appSurfaceSession 就没了，之后每个请求都报「requires appSurfaceSession」。
//
// 这是真发生过的：正则表单里的「跑一遍」（#rf-test-btn）就没写，
// 点它出来的是刷新，不是结果。
{
  const uiDir = path.resolve(modDir, "../..");
  const pages = fs.readdirSync(uiDir).filter(f => f.endsWith(".html"));
  const bad = [];
  let forms = 0;
  for (const page of pages) {
    const src = fs.readFileSync(path.join(uiDir, page), "utf8");
    for (const f of src.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)) {
      forms++;
      for (const b of f[1].matchAll(/<button\b[^>]*>/g)) {
        if (!/\btype=/.test(b[0])) bad.push(`${page}: ${b[0].replace(/\s+/g, " ").slice(0, 90)}`);
      }
    }
  }
  if (bad.length) {
    fail(`form 里有 ${bad.length} 个 button 没写 type（默认是 submit，点一下会提交表单→整页重载）：\n     ${bad.join("\n     ")}`);
  } else {
    ok(`${pages.length} 个页面、${forms} 个 form 里的 button 都显式写了 type`);
  }
}

console.log("\n" + "=".repeat(50));
console.log(errors === 0 ? "U1 接线一致性全部通过" : `失败 ${errors} 项`);
console.log("=".repeat(50));
process.exit(errors > 0 ? 1 : 0);
