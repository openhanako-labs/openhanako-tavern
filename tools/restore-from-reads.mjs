// tools/restore-from-reads.mjs — 把 read 片段还原成源文件，并对它们重打 edit-log
// 用后即删。
//
// 片段已验证是纯内容、无行号、到文件末尾结束（read 未截断时可整篇还原）。
// 只还原「write 没覆盖过」的文件，避免覆盖更好的版本。
// 之后统一应用 edit-log，把已还原文件推到最终态。

import fs from "node:fs";
import path from "node:path";

const APP = "W:/Games/Hanako/.hanako/apps/eleckoi-tavern";
const READS = path.join(APP, "_recovery");
const WRITES = "W:/Games/Hanako/Work/已分类/工作/代码/tavern-recovered";
const EDIT_LOG = "W:/Games/Hanako/Work/已分类/工作/代码/tavern-edit-log.json";

const writeManifest = new Set(
  JSON.parse(fs.readFileSync(path.join(WRITES, "_manifest.json"), "utf8")).map(m => m.rel)
);

/** __ → / 还原相对路径 */
function toRel(safe) {
  return safe.replace(/__/g, "/").replace(/\.read\.txt$/, "");
}

let restored = 0;
const candidates = [];

for (const f of fs.readdirSync(READS)) {
  if (!f.endsWith(".read.txt")) continue;
  const rel = toRel(f);
  candidates.push({ rel, file: path.join(READS, f) });
}

for (const { rel, file } of candidates.sort((a, b) => a.rel.localeCompare(b.rel))) {
  // 已被 write 覆盖过的优先，跳过
  if (writeManifest.has(rel)) continue;
  const text = fs.readFileSync(file, "utf8");
  // 过短的片段（多半是失败/截断提示）不要落盘冒充源码
  if (text.length < 200) continue;
  const dest = path.join(APP, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text);
  restored++;
  console.log(`  ${String(text.length).padStart(7)}B  ${rel}`);
}

console.log(`\n从 read 片段还原 ${restored} 个文件`);

// ── 重打 edit-log（覆盖所有现存文件） ──
const edits = JSON.parse(fs.readFileSync(EDIT_LOG, "utf8"));
let ok = 0, miss = 0;
for (const e of edits) {
  const file = path.join(APP, e.rel);
  if (!fs.existsSync(file)) continue;
  let text = fs.readFileSync(file, "utf8");
  for (const ed of e.edits) {
    if (typeof ed?.oldText !== "string" || typeof ed?.newText !== "string") continue;
    if (text.includes(ed.oldText)) { text = text.replace(ed.oldText, ed.newText); ok++; }
    else miss++;
  }
  fs.writeFileSync(file, text);
}
console.log(`edit 重打: 成功 ${ok} 处 / 未匹配 ${miss} 处`);
