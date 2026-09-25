// test/check-audit-reasons.mjs —— 账的护栏：没进 prompt 的东西必须带理由
//
// 这条规则早就写下了，却一直没人守：
//   **"账只从真实拼装里长出来；omitted 的理由不能省。"**
// 它的对手是"静默丢弃"——某一段因为某个条件没进 prompt，
// 而账里只写了个 kind、理由空着，等于告诉用户"这里少了一块，但不告诉你为什么"。
//
// 三条判据：
//   ① 每个 omit(kind, reason) 都得有两个参数（少一个 = 没有理由）
//   ② 理由得够长、说人话（"不拼" 这种等于没说）
//   ③ 每个 addSection(...) 都得给 note（进了 prompt 的东西也要说明它为什么在）
//
// 反证做过：把任意一条 omit 的理由删成空串，① 或 ② 立刻变红。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PIPELINE = path.join(ROOT, "lib", "conversations", "pipeline.js");

const src = fs.readFileSync(PIPELINE, "utf8");

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ✅ ${m}`); pass++; };
const bad = (m) => { console.log(`  ❌ ${m}`); fail++; };

console.log("\n=== 账的护栏：理由不能省 ===\n");

/** 把一段调用参数按顶层逗号切开（粗切：账里的理由里不含逗号分隔的嵌套调用）。 */
function splitArgs(inner) {
  const out = [];
  let depth = 0, quote = null, cur = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      cur += ch;
      if (ch === quote && inner[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; cur += ch; continue; }
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 抓出所有 omit(...) / addSection(...) 调用（含跨行）。 */
function calls(name) {
  const out = [];
  const re = new RegExp(`\\b${name}\\(`, "g");
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    let depth = 1, i = start, quote = null;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (quote) { if (ch === quote && src[i - 1] !== "\\") quote = null; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) break; }
    }
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ line, args: splitArgs(src.slice(start, i)) });
  }
  return out;
}

// ① + ② omit 必须两个参数、理由说人话
const omits = calls("omit");
if (omits.length === 0) bad("一个 omit 都没找到——护栏自己坏了（它应当至少找到十几处）");
else {
  const noReason = omits.filter(o => o.args.length < 2 || !o.args[1]);
  const tooShort = omits.filter(o => o.args.length >= 2 && /^["'`]\s*["'`]$/.test(o.args[1] || ""));
  if (noReason.length) bad(`有条目不写理由：第 ${noReason.map(o => o.line).join("、")} 行`);
  else ok(`${omits.length} 处 omit 都带了理由`);

  if (tooShort.length) bad(`有理由等于空话：第 ${tooShort.map(o => o.line).join("、")} 行`);
  else ok("没有空话理由（不是空串）");

  // 理由里要能看出"为什么"，不是"就是没有"。太短的多半是套话。
  const thin = omits.filter(o => {
    const r = String(o.args[1] || "");
    return r.length > 0 && r.replace(/["'`]/g, "").trim().length < 6;
  });
  if (thin.length) bad(`理由太短、看不出为什么：第 ${thin.map(o => `${o.line}(${o.args[1]})`).join("、")}`);
  else ok("理由都不至于短到看不出为什么");
}

// ③ addSection 必须给 note
const sections = calls("addSection");
const noNote = sections.filter(s => !s.args.some(a => /^\{[\s\S]*note:/.test(a)));
if (sections.length === 0) bad("一个 addSection 都没找到——护栏自己坏了");
else if (noNote.length) bad(`进 prompt 的段落没说明为什么在：第 ${noNote.map(s => s.line).join("、")} 行`);
else ok(`${sections.length} 处 addSection 都写了 note`);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
