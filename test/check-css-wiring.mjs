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
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UI = join(ROOT, "ui");
const CSS = join(UI, "assets", "characters.css");

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
  const patterns = [
    /class(?:Name)?\s*=\s*[`"']([^`"']+)[`"']/g,
    /classList\.(?:add|remove|toggle)\(([^)]*)\)/g,
    /\bclass="([^"]*)"/g
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

// ── 收集：CSS 里的类选择器 ──────────────────────────────
const cssSrc = readFileSync(CSS, "utf8");
// 去掉注释再扫，免得注释里提到的类名被当成真规则
const cssNoComment = cssSrc.replace(/\/\*[\s\S]*?\*\//g, "");
const cssClasses = new Set();
for (const m of cssNoComment.matchAll(/\.([a-zA-Z][\w-]*)/g)) cssClasses.add(m[1]);

// ── ① 死规则：CSS 有、源码里没人用 ─────────────────────
// 白名单：宿主注入的、第三方给的、以及明确按状态写的
const STATE_OK = new Set([
  "hidden", "on", "open", "active", "loading", "streaming", "error", "danger",
  "dragging", "selected", "disabled", "empty", "collapsed", "toast", "info"
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
const BUDGET = { dead: 50, naked: 13 };

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
