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

/*
 * 动态 id 白名单。
 *
 * 背景（2026-09-27）：这一节原先把所有 getElementById 都当成「静态接线」检查，
 * 于是运行时才创建的元素（模板字符串拼出来的 DOM）被误判为「HTML 里找不到」。
 * 上一版为了过关，把 settings-cats.js 里那三处 getElementById 改成了 querySelector
 * 来「绕开」扫描——那是躲测试，不是修问题。检查器该承认：有些 id 就是运行时才有的。
 *
 * 加白名单的判据是**保守**的：
 *   · 每个 id 都能在 ui/assets/modules/*.js 的模板字符串里找到 `id="..."` 的来源
 *   · 每个 id 都是**动态创建**的（innerHTML 或 el.querySelector 相对查），HTML 里不会有
 *   · 每个 id 都在下面注明了「哪个文件、什么时机」，防止白名单越用越滥
 *
 * 不加进来的是「模板字符串里也是字面量 id」（如 speaker-auto、dir-name 等）——
 * 那些虽然也用模板字符串生成，但值是固定的，HTML 里就有对应元素，不该豁免。
 */
const DYNAMIC_IDS = new Map([
  // 批量操作条：由 settings.js 的 renderBatchBar() 在选中 ≥1 条时拼出。
  // 无选择时 .settings-batch-bar 是 hidden 且 innerHTML=""，选择后才有 #batch-cat-select。
  ["batch-cat-select", "ui/assets/modules/settings.js:557（renderBatchBar，勾选后动态生成）"],
  ["batch-prio-select", "ui/assets/modules/settings.js:557（renderBatchBar，勾选后动态生成）"],
  // 羻绊推进按钮：renderHeaderMeta（chat.js）在 mode=bond 的对话里动态插入。
  // 只在捵绊场出现，普通对话的 HTML 里没有它。
  ["bond-advance-btn", "ui/assets/modules/chat.js（renderHeaderMeta，mode=bond 时动态生成）"],
  // 类目管理弹层：由 settings-cats.js 的 renderCatsModal() 弹层首次打开时拼出。
  // 平时 .cats-modal 根本不在 DOM 里，弹层打开才有 #cats-add-input。
  ["cats-add-input", "ui/assets/modules/settings-cats.js:85（renderCatsModal，弹层打开时动态生成）"],
  // 同场角色：由 characters.js 的 loadCastCandidates() 异步拉候选名单后拼出。
  // 平时只有骨架，数据到了（或 books 非空）才有下面这三块。
  // ctx-cast-count 只在正常态存在；ctx-cast-goto-settings 只在空态存在；
  // ctx-cast-save 只在正常态存在。
  ["ctx-cast-count", "ui/assets/modules/characters.js:loadCastCandidates（正常态拼接时动态生成）"],
  ["ctx-cast-save", "ui/assets/modules/characters.js:loadCastCandidates（正常态拼接时动态生成）"],
  ["ctx-cast-goto-settings", "ui/assets/modules/characters.js:loadCastCandidates（空态拼接时动态生成）"]
]);

const missing = [];
for (const [id, where] of referenced) {
  if (DYNAMIC_IDS.has(id)) continue; // 白名单：动态创建的 id 不查
  if (!htmlIds.has(id)) missing.push(`${id}  ←  ${where.join(", ")}`);
}
if (missing.length === 0) ok(`JS 引用的 ${referenced.size} 个 id 全部存在于 HTML（含 ${DYNAMIC_IDS.size} 个动态白名单）`);
else for (const m of missing) fail(`HTML 里找不到 id: ${m}`);

// 白名单自身的一致性：列出的每个 id 都必须在 modules 里被实际引用过。
// 加白名单时忘了写调用方，这条会亮——白名单不能凭空长。
for (const id of DYNAMIC_IDS.keys()) {
  if (!referenced.has(id)) fail(`白名单里的 id「${id}」没有任何 JS 在用（白名单不该凭空长）`);
}

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
//   · 八个真抽屉：id 必须存在
//   · 「世界」：不再是抽屉，但**它必须仍然是个活入口**——
//     shell.openDrawer 里那个特例（name === "board" → 开列）被删掉的话，
//     `DRAWERS["board"]` 是 undefined，openDrawer 会**静默 return**：
//     按钮还在、点了没反应。这种“静默死入口”正是这一节真正要拦的东西。
const shellSrc = fs.readFileSync(path.join(modDir, "shell.js"), "utf8");
const REAL_DRAWERS = ["character", "settings", "director", "variables", "presets", "regex", "tools", "migration"];
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

// ── 4b. 导航分层（2026-09-27 重设计 · 方向 A 之后重写）──
//
// 改之前：九个平铺文字入口在 #topnav，而 #ctx-tabs 又摆了同样四个
//（角色 / 设定库 / 世界 / 变量）——两套导航指着同一批内容。
//
// 改之后：**左轨是唯一的导航**（#apprail，图标 + 字，按这一场/配置分两组）。
// 于是断言的是四件真事：
//   ① #apprail 在，且**每个抽屉都能从左轨走到**（有面板没门 = 永远找不到）
//   ② 每个入口都有图标**也有文字**——只给图标、靠 hover 才知道是什么，
//      是把“不顺手”换个地方，所以这条也当成硬要求
//   ③ #panel-head 不许回来——它曾与抽屉自带 drawer-head 是同一句标题说两遍，
//      2026-09-30 整条移除；收起键的职责归每个抽屉自己的 drawer-head ✕（在下面验）
//   ④ **#ctx-tabs 不许回来**——它就是那次要消掉的那套重复
const cssSrc = fs.readFileSync(path.join(root, "ui/assets/characters.css"), "utf8");

const apprail = html.match(/<nav class="apprail"[\s\S]*?<\/nav>/);
if (!apprail) fail("缺左轨 .apprail");
else {
  const ALL = ["character", "settings", "director", "board", "variables", "presets", "regex", "tools", "migration"];
  const entries = [...apprail[0].matchAll(/data-drawer="([^"]+)"/g)].map(m => m[1]);

  /*
   * 2026-09-27 归并：presets / regex / tools / migration 这四个低频入口
   * 从左轨收进「设置」浮层。断言跟着改，但**原意一句没动**——
   * 还是要保证「没有孤儿抽屉，每个面板都有门」。
   *
   * 只是「门」不再都在同一层：左轨的直接入口，加上左轨弹出来的浮层里的
   * 入口，合起来必须覆盖全部。（顶栏 ⋯ 菜单另有一条断言在下面守着。）
   */
  const menuEl = html.match(/<div id="cfg-menu"[\s\S]*?<\/div>/);
  const merged = menuEl ? [...menuEl[0].matchAll(/data-cfg-go="([^"]+)"/g)].map(m => m[1]) : [];
  if (!menuEl) fail("缺「设置」浮层 #cfg-menu——那四个低频入口就没门了");
  const reachable = new Set([...entries, ...merged]);
  for (const name of ALL) {
    if (!reachable.has(name)) fail(`左轨走不到面板: ${name}`);
  }
  // 归并之后左轨上剩下的直接入口应该变少——没变说明归并没有生效
  if (entries.length >= ALL.length) {
    fail(`左轨仍有 ${entries.length} 个直接入口——归并没有生效`);
  }

  const btns = apprail[0].match(/<button[^>]*class="rail-item"[\s\S]*?<\/button>/g) || [];
  if (btns.length < 7) fail(`左轨按钮只读到 ${btns.length} 个`);
  const naked = btns.filter(b => !/<svg class="ri"/.test(b) || !/<span>/.test(b));
  if (naked.length) fail(`${naked.length} 个左轨入口缺图标或文字（两者必须都有）`);
  else if (errors === 0) ok(`左轨 ${entries.length} 个抽屉入口 + 对话 + 背景，图标与文字齐备`);
}

if (html.includes('id="ctx-tabs"')) {
  fail("#ctx-tabs 又回来了——它和左轨重复，正是这一轮要消掉的那套导航");
} else ok("#ctx-tabs 未复活（重复导航的回归护栏）");

if (/id="panel-head"/.test(html)) {
  fail("#panel-head 又回来了——抬头条与抽屉自带 drawer-head 重复，已于 2026-09-30 移除");
} else if (/id="panel-title"/.test(html)) {
  fail("#panel-title 残迹——抬头条已整条移除，别留零件");
} else ok("#panel-head 未复活（重复标题的回归护栏）");

// 抬头条没了，收起职责归抽屉自己的头：每个抽屉容器都必须带 drawer-close。
{
  const drawers = html.match(/class="drawer[\s"]/g) || [];
  const closers = html.match(/class="[^"]*drawer-close/g) || [];
  if (closers.length < drawers.length) {
    fail(`抽屉收起键不够：${drawers.length} 个抽屉只有 ${closers.length} 个 drawer-close`);
  } else ok(`收起键齐备：${drawers.length} 个抽屉 / ${closers.length} 个 drawer-close`);
}

// 左轨宽度必须有单一来源（.shell 的 --rail-w）。读不出说明骨架规则被改动过。
const railW = (cssSrc.match(/--rail-w,\s*(\d+)px/) || [])[1];
if (!railW) fail("读不出左轨宽度（.shell 的 --rail-w）");
else ok(`左轨宽度单一来源：${railW}px`);

// ── 二级：⋯ 菜单必须装下全部抽屉 ──
  // 切到下一个 .more-wrap 为止——菜单里有嵌套的 <div class="sep">，
  // 用 `<\/div>` 收口会在第一个分隔符那里就截断。
  const mStart = html.indexOf('id="app-more-menu"');
  const mEnd = html.indexOf('id="chat-more-btn"');
  const menu = mStart >= 0 && mEnd > mStart ? html.slice(mStart, mEnd) : null;
  if (!menu) fail("找不到 ⋯ 菜单 #app-more-menu");
  else {
    const entries = [...menu.matchAll(/data-drawer="([^"]+)"/g)].map(m => m[1]);
    // ⋯ 菜单要装下**全部**面板入口：八个真抽屉 + 「世界」（它现在是列，但入口不变）
    const ALL_ENTRIES = [...REAL_DRAWERS, "board"];
    const missing = ALL_ENTRIES.filter(n => !entries.includes(n));
    if (missing.length) fail(`⋯ 菜单缺面板入口: ${missing.join(", ")}（有面板没门）`);
    else ok(`⋯ 菜单装下全部 ${ALL_ENTRIES.length} 个面板入口`);
  }

// ── 5. 一屏结构的关键类 ──
const mustHave = [
  ["shell 外壳", 'class="shell"'],
  // 页内侧栏已按产品决定删除（2026-09-23：列表归宿主 rail 独家），
  // sidebar / collapse / expand / characters-list / conversations-list
  // 五项随设计移除——测试断言的是结构，结构变了断言跟着变。
  ["左轨（唯一导航）", 'id="apprail"'],
  // 「面板抬头」已从 mustHave 移除并翻转为反向护栏（见上方 #panel-head 检查）
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
//
// 2026-09-25：去掉 ".sb-foot"——它是侧栏（sb-*）留下的过期待已。
// 侧栏已按产品决定删除（列表归宿主 rail），那批规则跟着成了死规则，
// 一次 CSS 清理把它们删了，于是“期望存在”的锚点过期。
// 2026-09-28：去掉 ".ctx-tabs {" ".char-list .card"——
//   .ctx-tabs 是旧右栏标签条，已随左轨重构删除；
//   .char-list 是旧角色卡列表，已随新角色选择器删除。
//   两者都在 check-css-wiring 的核查里确认为死规则，已删。
// **结构变了断言跟着变**，但不把断言删空：剩下的仍是真锚点。
const css = fs.readFileSync(path.join(root, "ui/assets/characters.css"), "utf8");
for (const needle of [".shell {", ".drawer {", ".pe-blocks", ".picker-item"]) {
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
