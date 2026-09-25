// tools/trim-css.mjs —— 删掉 CSS 里确定没人用的规则（默认只报告，--apply 才动手）
//
// 为什么要有它：check-css-wiring 的"死规则"里**混过假阳性**——
// 它曾把 `.user` / `.system` 报成死的，而那正是气泡的角色类
//（chat.js 里 `class="message ${m.role}"`，插值处静态扫不到）。
// 无脑清理会删掉在用的样式，而且删完检查器还是绿的：不报错，界面悄悄坏。
//
// 所以这个脚本的**第一步不是删，是再核一遍名单**：
//   对每个"死"类名，在整个 ui/ 下再独立搜一次（HTML + JS + CSS 都搜）。
//   搜索时把类名当**词**匹配，并且**排除 CSS 自己**——否则每条 CSS 规则
//   都会"证明"它自己还活着。
//   核不过的（搜到了落点）就从删除名单里去掉，并打印出来。
//
// 用法：
//   node tools/trim-css.mjs            # 只报告（默认）
//   node tools/trim-css.mjs --apply    # 真删

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI = path.join(ROOT, "ui");
const CSS = path.join(UI, "assets", "characters.css");
const APPLY = process.argv.includes("--apply");

// ── ① 从检查器拿死规则名单 ────────────────────────────
let listed;
try {
  listed = execFileSync("node", [path.join(ROOT, "test", "check-css-wiring.mjs"), "--list"], {
    encoding: "utf8", cwd: ROOT
  });
} catch (e) {
  listed = String(e.stdout || "");
}
const deadLine = (listed.split(/\r?\n/).find((l) => /^  \S/.test(l) && l.includes(",")) || "");
const dead = deadLine.split(",").map((s) => s.trim()).filter((s) => /^[a-z][\w-]*$/i.test(s));
if (dead.length === 0) {
  console.log("  没拿到死规则名单——不猜，先停。");
  process.exit(1);
}
console.log(`  检查器报的死规则：${dead.length} 条`);

// ── ② 再核一遍：整个 ui/ 里独立搜，排除 CSS 自己 ────────
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const files = walk(UI).filter((f) => /\.(html|js|mjs|css)$/.test(f));
const otherSrc = files
  .filter((f) => path.resolve(f) !== path.resolve(CSS))
  .map((f) => ({ f, src: fs.readFileSync(f, "utf8") }));

const rescued = [];
const confirmed = [];
for (const c of dead) {
  const re = new RegExp(`(^|[^\\w-])${c.replace(/[-]/g, "\\-")}([^\\w-]|$)`);
  const hit = otherSrc.find(({ src }) => re.test(src));
  if (hit) rescued.push({ c, where: path.relative(ROOT, hit.f) });
  else confirmed.push(c);
}
console.log(`  复核后：确认可删 ${confirmed.length} 条 · 复核撤回 ${rescued.length} 条`);
for (const r of rescued) console.log(`    （撤回）${r.c} —— 在 ${r.where} 里有落点`);
// 逐条列出“确认可删”的。
// 一份说“12 条可删”却说不出是哪 12 条的报告，**等于没法验**——
// 拿不到 shell 的复核者就卡在这个上（她只能手工重建名单，然后跟我对不上）。
for (const c of confirmed) console.log(`    （可删）${c}`);

// ── ③ 扫 CSS：注释感知地把规则切成块 ────────────────────
const src = fs.readFileSync(CSS, "utf8");
const blocks = [];            // { start, end, selector, body, commentStart }
let i = 0;
while (i < src.length) {
  const brace = src.indexOf("{", i);
  if (brace < 0) break;
  // 选择器从上一个块结束（或文件头）算起；中间可能夹着注释
  let raw = src.slice(i, brace);
  const close = src.indexOf("}", brace);
  if (close < 0) break;
  blocks.push({ start: i, end: close + 1, raw, selector: raw.replace(/\/\*[\s\S]*?\*\//g, "").trim() });
  i = close + 1;
}

const isDeadSelector = (sel) => {
  if (sel.startsWith("@")) return false;                 // at-rule 整段跳过
  const classes = [...sel.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]);
  if (classes.length === 0) return false;                // 没有类名（纯标签）不动
  return classes.every((c) => confirmed.includes(c));
};

let removedBlocks = 0, trimmedSelectors = 0;
const drop = [];
for (const b of blocks) {
  const parts = b.selector.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) continue;
  const kept = parts.filter((s) => !isDeadSelector(s));
  if (kept.length === parts.length) continue;
  if (kept.length === 0) { removedBlocks++; drop.push(b); }
  else { trimmedSelectors++; drop.push({ ...b, trimmed: kept.join(", ") }); }
}
console.log(`  可删：整块 ${removedBlocks} 个 · 组选择器里去掉部分 ${trimmedSelectors} 个`);
for (const b of drop.slice(0, 60)) {
  console.log(`    ${b.trimmed ? `（改）${b.trimmed}` : "（删）" + b.selector.replace(/\s+/g, " ").slice(0, 70)}`);
}

if (!APPLY) {
  console.log("\n  这是报告模式。真删请加 --apply。");
  process.exit(0);
}

// ── ④ 动手：从后往前替换，避免位移 ──────────────────────
let out = src;
for (const b of [...drop].sort((x, y) => y.start - x.start)) {
  let from = b.start;
  // 顺手带走紧邻其上的**独立注释块**（只在它跟规则之间没有别的规则时）
  const before = out.slice(0, from);
  const m = /(\n[ \t]*\/\*[\s\S]*?\*\/[ \t]*)\s*$/.exec(before);
  if (m) from = before.length - m[1].length;
  const repl = b.trimmed ? `${b.raw}${b.trimmed} ` : "";
  out = out.slice(0, from) + repl + out.slice(b.end);
}
fs.writeFileSync(CSS, out);
console.log(`\n  已写入。${"".padEnd(1)}`);
