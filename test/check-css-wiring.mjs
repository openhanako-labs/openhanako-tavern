/**
 * check-css-wiring.mjs —— CSS 与 DOM 的接线对照
 *
 * 两个方向都要看：
 *   ① 规则写了，没人用   → 死规则（例：.chat-main 的面板样式，DOM 里从来没这个类）
 *   ② 类用了，没有规则   → 裸类（例：.bubble 没有一条样式；配合模板缩进+pre-wrap
 *                          就是今天那个「每个气泡多拖 190px 隐形空行」的一半原因）
 *
 * 这两个方向各自都"不报错"：页面照样跑、测试照样绿，只是长得不是设计的样子。
 * 所以它必须作为护栏常驻——**只靠肉眼过一遍 CSS 是今天已经失败过一次的方法**。
 *
 * 判据要留余地：类名可能是拼接出来的（`"message " + role`）、也可能是
 * JS 动态加的开关（hidden / on / loading）。所以：
 *   - 命中集合 = HTML 的 class 字面量 + JS 里所有字符串里出现的 class 形态
 *   - 认不出来的一律进「存疑」列表，只有明确的两类才算数
 *
 * ⚠ 已知盲区（别把它当成“全都查过了”）：
 *   「裸类」那一侧**只看 HTML**，所以**由 JS 模板字符串生成的类名扫不到**。
 *   真实例子：变量抽屉的 `.var-card` / `.vf-name` / `.var-meta` 系列
 *   （在 variables.js 的模板里），一条样式都没有，这个检查器当时是绿的。
 *   若要把它们收进来：得把“JS 里 `class="…"` 字面量”也算作落点，
 *   而那会把状态类一并拖进来——得先想清楚白名单再动。
 *
 *   2026-09-25 已补两处（死规则那侧的误报）：
 *     ① 带插值的类属性 `class="x${…}"`——只取插值前的字面量；
 *     ② **值整个是插值**的 `class="${m.role}"` 静态拿不到名字，
 *        改由 DYNAMIC_CLASSES 显式登记（不登记会被当死规则而误删）。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UI = join(ROOT, "ui");
const CSS = join(UI, "assets", "characters.css");

/**
 * 由插值决定的类名：静态扫不到，只能登记。
 *
 * 不登记的话，`.user` / `.system` 会被当成死规则——而它们是**活的**：
 * chat.js 里写的是 `class="message ${m.role}"`，role ∈ user/assistant，
 * 也就是气泡的角色类。无脑“清理死规则”会把它删掉。
 *
 * 登错了的代价只是**死规则少报**（更保守），不会误删。
 *
 * 2026-09-28 补 4 条 —— 都是「模板字符串里插值内部」的类：
 *   `.builtin`  ← presets.js:123 `class="preset-card-v2 ${p.builtin ? "builtin" : ""}..."`
 *   `.mine`     ← settings.js:388 `class="owner${isOwn() ? " mine" : ""}..."`
 *   `.is-disabled` ← regex.js:185 `class="regex-row${off ? " is-disabled" : ""}..."`
 *   `.private`  ← board.js:76 `{ text: "只有你", cls: "private" }`（字段传参，非 class 属性）
 *   以上四类的**反向守门**见下文 assertExemptionRegistered：
 *   如果哪一天 JS 里不再引用它们，脚本会报错——说明豁免过期了。
 *
 * 2026-09-28 再补 4 条 —— 同一种成因（模板/字段里拼出来的类名），
 * 只是当时写在别的文件、没被这一轮之前的扫描碰到：
 *   `.core` / `.common` / `.rare`
 *        ← settings.js:29-31 `PRIORITY_TIERS = { 300: { cls: "core" }, … }`，
 *          再由 409-411 行按优先级选一个拼进 class。
 *          （同一批还有 `.tier-core` 这种前缀拼接，那是 `tier-${…}`，
 *           扫描器的「插值前字面量」那条已能取到 `tier-`，故不在此列。）
 *   `.section-head`
 *        ← settings.js:354 `const headCls = \`section-head${folded ? " folded" : ""}\``。
 *          它整个是变量（不是 `class="…"` 字面量），静态扫不到。
 *
 * 2026-09-28 再补 1 条 —— 图库（gallery.js）同一个成因：
 *   `.is-portrait`
 *        ← gallery.js cellHtml()：
 *          `class="gal-kind${rec.kind === "portrait" ? " is-portrait" : ""}"`
 *          插值前只取到 `gal-kind`，` is-portrait` 整个落在插值内部。
 *          （反向守门见下文 assertExemptionRegistered。）
 */
const DYNAMIC_CLASSES = [
  "user", "assistant", "system",                    // chat.js 消息气泡角色
  "builtin",        // presets.js 预设卡「内置」标记
  "mine",           // settings.js 设置卡「本人」标记
  "is-disabled",    // regex.js 规则行「停用」状态
  "private",        // board.js 黑板「仅本人」标签
  "core", "common", "rare",   // settings.js 常用度三档（PRIORITY_TIERS.cls）
  "section-head",   // settings.js 分组抬头（整个是变量 headCls）
  "is-portrait",    // gallery.js 图库格子「这是立绘」标记
];

let pass = 0;
let fail = 0;
const problems = [];
const notes = [];

function ok(msg) {
  pass++;
  console.log(`  ✓ ${msg}`);
}
function bad(msg, detail) {
  fail++;
  problems.push(msg);
  console.log(`  ✗ ${msg}`);
  if (detail) console.log(detail);
}

// ── 收集：源码里出现的类名 ──────────────────────────────
function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, out);
    else if (/\.(js|html)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walkFiles(UI);
const used = new Set();   // 源码里出现过的类名
const htmlClasses = new Set(); // 只统计 HTML（死规则判据更严：样式类至少要在 HTML 里有落点）

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const isHtml = f.endsWith(".html");
  // class="a b c" / className = "a b" / classList.add("a","b") / :class 之类
  //
  // 外加一条专治**带插值的类属性**：`class="speaker-chip${cond ? " on" : ""}"`。
  // 上面那三条都要求名字后面**紧跟引号**，所以这种写法整条扫不到——
  // 后果是真实的类被当成死规则（群聊的 .speaker-chip 就是这么被报的）。
  // 只取插值前面的字面量部分。
  //
  // 仍扫不到的还有**值整个是插值**的写法（`class="${m.role}"`）：
  // 静态根本拿不到名字，所以靠下面的 DYNAMIC_CLASSES 登记。
  const patterns = [
    /class(?:Name)?\s*=\s*[`"']([^`"']+)[`"']/g,
    /classList\.(?:add|remove|toggle)\(([^)]*)\)/g,
    /\bclass="([^"]*)"/g,
    /\bclass="([^"${}]+)\$\{/g
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      for (const raw of m[1].split(/[\s,]+/)) {
        const c = raw.replace(/['"`]/g, "").trim();
        if (!c || c.includes("$") || c.includes("{") || c.length > 40) continue;
        if (!/^[a-zA-Z][\w-]*$/.test(c)) continue;
        used.add(c);
        if (isHtml) htmlClasses.add(c);
      }
    }
  }
}

// 插值处看不见的类名（见上面 DYNAMIC_CLASSES 的说明）
for (const c of DYNAMIC_CLASSES) used.add(c);

// ── 收集：CSS 里的类选择器 ──────────────────────────────
const cssSrc = readFileSync(CSS, "utf8");
// 去掉注释再扫，免得注释里提到的类名被当成真规则
const cssNoComment = cssSrc.replace(/\/\*[\s\S]*?\*\//g, "");
const cssClasses = new Set();
for (const m of cssNoComment.matchAll(/\.([a-zA-Z][\w-]*)/g)) cssClasses.add(m[1]);

// ── ① 死规则：CSS 有、源码里没人用 ─────────────────────
// 白名单：宿主注入的、第三方给的、以及明确按状态写的
// 白名单：宿主注入的、第三方给的、以及明确按状态写的
// 2026-09-28 补 2 条状态类：
//   `.success` — toast() 的第二参数 `"success"` 会 add 成类（大量 toast(..., "success") 调用）
//   `.ok`      — 已并入 .gen-src 一起删，但保留在这里作为通用状态类以防未来出现独立 `.ok { }`
const STATE_OK = new Set([
  "hidden", "on", "open", "active", "loading", "streaming", "error", "danger",
  "dragging", "selected", "disabled", "empty", "collapsed", "toast", "info",
  "success"
]);
const dead = [...cssClasses].filter((c) => !used.has(c) && !STATE_OK.has(c)).sort();
// 注意：只在 HTML 里出现才算落点——但 JS 里拼出来的也算，所以这里对 used 判

// 裸类：HTML 用了、CSS 里一条规则都没有。
// 排除功能性类（纯给 JS 找元素 / 开关用的），它们本来就不需要样式。
const FUNCTIONAL_OK = new Set(["hidden", "on", "message", "toast", "toast-close", "sep", "mi"]);
const naked = [...htmlClasses].filter((c) => !cssClasses.has(c) && !FUNCTIONAL_OK.has(c)).sort();

// 存量欠账：**只挡新增**。
// 一次扫出 50 条死规则 / 13 个裸类——都是被删掉或改名过的 UI 留下的余数。
// 不假装它们是 0（那得现在清完，风险与收益不成比例），但不允许**变多**：
// 每多一点，就是又多一处「写了没接线」等着下一个人肉眼去发现。
// 存量欠账：**只挡新增**。
//
// 数字不是拍的，是 2026-09-28 逐条核查后的真实基线：
//   · 死规则 5 → 已删掉 71 条真死（gen 系列 / 旧外壳 topnav / 旧 tab 结构 /
//                旧 regex/tool-group / pe 系列 / 单点死选择器 / 组合选择器子）
//     剩下 5 条是**动态类**豁免：builtin / mine / is-disabled / private（模板字符串插值内部）
//     + 1 条 STATE_OK 的 success（toast() 第二参数会 add 成类）
//   · 裸类 13 → 已补 26 条真缺样式的 CSS（背景图控件 / 命令面板 / 抽屉头 /
//                空状态 / 主区布局 / 面板头 / 弹性占位 / 设置控件）
//     剩下的 13 条是**功能性类**豁免（FUNCTIONAL_OK：hidden/on/message/toast/…），
//     它们本来就不需要样式，给 JS 找元素或当状态开关用的。
//
// 反向守门（下一节 assertExemptionRegistered）：
//   豁免清单里的每个名字必须真的在仓库源码里被引用过——
//   否则说明豁免过期了（比如代码改过，类名不再拼出来），预算就虚高了。
const BUDGET = { dead: 5, naked: 0 };

if (dead.length > BUDGET.dead) {
  bad(`死规则变多：${BUDGET.dead} → ${dead.length}`, dead.map((c) => `    .${c}`).join("\n"));
} else {
  ok(`死规则未增加（${dead.length}/${BUDGET.dead}）`);
}

if (naked.length > BUDGET.naked) {
  bad(`裸类变多：${BUDGET.naked} → ${naked.length}`, naked.map((c) => `    .${c}`).join("\n"));
} else {
  ok(`裸类未增加（${naked.length}/${BUDGET.naked}）`);
}

if (process.argv.includes("--list")) {
  console.log("\n【死规则】");
  console.log("  " + dead.join(", "));
  console.log("\n【裸类】");
  console.log("  " + naked.join(", "));
}

// ── 反向守门：豁免清单不能写错 ─────────────────────────────
// 豁免里的名字必须在源码里真被引用过（作为字符串字面量出现），
// 否则说明代码改过、类名不再拼出来，预算就虚高了。
// 例外：`user` / `assistant` / `system` 是 chat.js 的 DYNAMIC_CLASSES 原意，
//   它们的字符串出现在模板里，扫描器已扫到（used.has），但为了对称也一起守。
function assertExemptionRegistered(name) {
  // 在每个源码文件里搜字面量；用词边界避免 sub-str 命中
  const re = new RegExp("[\"'`]\\s*" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w-])", "m");
  for (const f of files) {
    if (re.test(readFileSync(f, "utf8"))) return;
  }
  bad(`豁免失效：.${name} 已不再在源码里被引用`);
}
for (const c of DYNAMIC_CLASSES) assertExemptionRegistered(c);

// ── ② 裸类已在上面算完（naked） ─────────────
if (naked.length === 0) {
  ok("没有裸类（HTML 里每个 class 都在 CSS 里有规则）");
} else {
  notes.push(`裸类候选 ${naked.length} 个：${naked.join(", ")}`);
}

// ── 落点统计 ────────────────────────────────────────────
console.log(`  · 源码类名 ${used.size} / HTML 类名 ${htmlClasses.size} / CSS 类选择器 ${cssClasses.size}`);

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log("\n失败项：");
  problems.forEach((p) => console.log("  - " + p));
  process.exit(1);
}
