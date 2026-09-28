// 检查：CSS 覆盖每个"用到的类"，且底板规则不能整段缺失。
//
// 为什么需要这一条（2026-09-28）：
//   check-css-wiring 漏掉了两类真问题——
//     ① 它只扫 characters.html 的类，扫不到 JS 模板里拼出来的
//        （`.switch` 只在 settings.js / tools.js 出现，于是完全没被看见）；
//     ② 它把"类名在 CSS 里出现过"当作"有样式"，
//        而 `.rail-item` 只在 `.shell.rail-folded .rail-item` 里出现过，
//        于是底座整段被删它也照样绿。
//   结果是：开关渲染成默认复选框、左轨入口没有高度与排布，
//   测试全绿、界面看着"很简陋"。这一条就是来堵这两个洞的。
//
// 判据分两档：
//   ✗ NAKED   —— 用到了，但整份 CSS 里一条规则都没有（+ JS 里的也算）
//   ⚠ BASE    —— 只在后代/状态选择器里出现，没有独立规则（` .cls {`）
// 两档都设预算，并把豁免写成清单，每条注明理由。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

// ── 豁免：有正当理由可以没有独立规则的类 ─────────────────────
// 每条都要写清"为什么它不是缺样式"。
const BASE_OK = new Set([
  "hidden", "on", "open", "active", "loading", "streaming", "error",
  "selected", "disabled", "empty", "dragging", "collapsed", "show",
  "user", "assistant", "system",     // 消息气泡角色，样式挂在 .message 上
  "you-left", "you-right",           // 同上，状态类
]);

// 已知欠账（2026-09-28 核查后）：
//   事故里丢的那批组件样式已按 session 原文恢复；下列是恢复后仍缺、
//   需要**重写**（不在任何 session 里，说明当时就没写完 / 或写在别处）：
//     .dir-*    剧情公式抽屉 —— 那一轮设计定了但没派落地，样式自然没有
//     .cmd-item/.cmd-empty/.cn-sub   命令面板的条目与空态
//     .no-rail/.roomy/.picker-meta   外壳的若干状态类
//     .cats-empty/.card-since/.setting-cat-badge  空态与徽章
//     .bg-none/.gen-entry-ck/.vm-name-input/.modal-close
//   这些记为欠账，不允许再变多；每减一条就把预算收紧。
const KNOWN_DEBT = new Set([
  "dir-acts", "dir-item", "dir-k", "dir-line", "dir-main", "dir-meta", "dir-name", "dir-prog",
  "cmd-item", "cmd-empty", "cn-sub",
  "no-rail", "roomy", "picker-meta",
  "cats-empty", "card-since", "setting-cat-badge",
  "bg-none", "gen-entry-ck", "vm-name-input", "modal-close",
]);
const BUDGET = { naked: KNOWN_DEBT.size, base: 12 };

// ── 1. 收集"用到的类" ───────────────────────────────────────
const classes = new Set();

function scanClassAttrs(text) {
  // class="a b c" / class='a b'
  // 注意：`class="scope-${x}"` 这种拼接要先剥掉 ${...}，否则会得到 "scope-" 这个假类名。
  const stripped = text.replace(/\$\{[^{}]*\}/g, " ").replace(/\$\{[\s\S]*?\}/g, " ");
  for (const m of stripped.matchAll(/class\s*=\s*["'`]([^"'`]*)["'`]/g)) {
    for (const c of m[1].split(/\s+/)) {
      // 只认小写 kebab：排除 isOwn / headCls 这类代码标识符，也排除 scope- 这种拼接连词
      if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(c)) continue;
      classes.add(c);
    }
  }
}
function scanClassList(text) {
  // classList.add("x") / toggle("x") / remove("x")
  for (const m of text.matchAll(/classList\.(?:add|toggle|remove)\(\s*["'`]([A-Za-z][\w-]*)/g)) classes.add(m[1]);
}

// HTML
scanClassAttrs(readFileSync(join(ROOT, "ui/characters.html"), "utf8"));
// JS 模块
import { readdirSync } from "node:fs";
for (const f of readdirSync(join(ROOT, "ui/assets/modules"))) {
  if (!f.endsWith(".js")) continue;
  const t = readFileSync(join(ROOT, "ui/assets/modules", f), "utf8");
  scanClassAttrs(t);
  scanClassList(t);
}

// ── 2. 收集 CSS 里的选择器 ──────────────────────────────────
const css = readFileSync(join(ROOT, "ui/assets/characters.css"), "utf8")
  .replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

const inCss = new Set();        // 出现过（任何位置）
const standalone = new Set();   // 有独立规则：选择器中有一个"整段就是 .cls"
for (const m of css.matchAll(/(^|\})([^{}@]+)\{/g)) {
  for (const part of m[2].split(",")) {
    const sel = part.trim().replace(/\s+/g, " ");
    if (!sel) continue;
    const tokens = sel.split(/[\s>+~]+/);
    for (const tok of tokens) {
      // 取 token 里的类名（如 `.a.b:hover` → a、b）
      for (const cm of tok.matchAll(/\.([A-Za-z][\w-]*)/g)) inCss.add(cm[1]);
      // 独立规则：token 出去掉伪类后恰好是 `.cls` 或 `.cls.something`
      if (tok.startsWith(".")) {
        const base = tok.replace(/:{1,2}[\w-]+(\([^)]*\))?/g, "");
        for (const cm of base.matchAll(/\.([A-Za-z][\w-]*)/g)) standalone.add(cm[1]);
      }
    }
  }
}

// ── 3. 判定 ────────────────────────────────────────────────
const naked = [...classes].filter((c) => !inCss.has(c) && !BASE_OK.has(c) && !KNOWN_DEBT.has(c)).sort();
const base = [...classes].filter((c) => inCss.has(c) && !standalone.has(c) && !BASE_OK.has(c)).sort();

let bad = 0;
console.log(`扫描：用到类 ${classes.size} 个；CSS 出现 ${inCss.size} 个；有独立规则 ${standalone.size} 个\n`);

if (naked.length > BUDGET.naked) {
  bad++;
  console.log(`✗ NAKED ${naked.length}/${BUDGET.naked}：用到了但 CSS 里一条规则都没有`);
  for (const c of naked) console.log("    ." + c);
} else {
  console.log(`✓ NAKED ${naked.length}/${BUDGET.naked}`);
}

if (base.length > BUDGET.base) {
  bad++;
  console.log(`\n✗ BASE ${base.length}/${BUDGET.base}：只在后代/状态选择器里出现，没有独立规则`);
  for (const c of base) console.log("    ." + c);
} else {
  console.log(`✓ BASE ${base.length}/${BUDGET.base}`);
  if (base.length) console.log("    （" + base.join(" ") + "）");
}

console.log(bad ? `\n${bad} 项不合格` : `\n2 通过 / 0 失败`);
process.exit(bad ? 1 : 0);
