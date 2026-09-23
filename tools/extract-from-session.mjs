// tools/extract-from-session.mjs — 从会话 JSONL 中提取文件痕迹，评估可恢复范围
// 一次性工具，恢复完成后删除。
//
// 会话 JSONL 里每条记录含 tool_use（我发起的 write/edit/read）与 tool_result
// （文件内容/回显）。write 的 content 是完整全文；edit 的 old/new 是成对片段；
// read 的 result 是带行号的部分内容。三者拼起来就是可恢复面。

import fs from "node:fs";
import path from "node:path";

const SESSIONS = process.argv.slice(2);
if (SESSIONS.length === 0) {
  console.error("用法: node tools/extract-from-session.mjs <session.jsonl> [...]");
  process.exit(1);
}

// 目标：eleckoi-tavern 下的文件
const PREFIXES = [
  "apps/eleckoi-tavern/",
  "W:/Games/Hanako/.hanako/apps/eleckoi-tavern/",
  "W:\\Games\\Hanako\\.hanako\\apps\\eleckoi-tavern\\",
];

function underApp(p) {
  if (typeof p !== "string") return null;
  let s = p.replace(/\\/g, "/");
  for (const pre of PREFIXES) {
    const i = s.indexOf(pre.replace(/\\/g, "/"));
    if (i >= 0) return s.slice(i + pre.replace(/\\/g, "/").length);
  }
  return null;
}

/** write: {name:"write", input:{path, content}} */
const writes = new Map();   // relPath -> [{session, idx, content}]
/** edit: {name:"edit", input:{path, edits:[{oldText,newText}]}} */
const edits = [];           // {session, idx, path, edits}
/** read: {name:"read", input:{path|fileId}} */
const reads = new Set();

let lines = 0, parsed = 0;

for (const file of SESSIONS) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) { console.error(`读不到 ${file}: ${e.message}`); continue; }

  const rows = text.split("\n");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.trim()) continue;
    lines++;
    let obj;
    try { obj = JSON.parse(row); } catch { continue; }
    parsed++;

    // tool_use 可能在 message.content[] 里
    const contents = [];
    if (obj?.type === "assistant" && Array.isArray(obj.message?.content)) {
      contents.push(...obj.message.content);
    } else if (Array.isArray(obj?.content)) {
      contents.push(...obj.content);
    }
    for (const c of contents) {
      if (c?.type !== "tool_use") continue;
      const name = c.name;
      const input = c.input || {};
      const rel = underApp(input.path) || underApp(input.fileId);
      if (name === "write" && rel) {
        if (!writes.has(rel)) writes.set(rel, []);
        writes.get(rel).push({ session: path.basename(file), idx: i, content: input.content ?? "" });
      } else if (name === "edit" && rel) {
        edits.push({ session: path.basename(file), idx: i, path: rel, edits: input.edits || [] });
      } else if (name === "read" && rel) {
        reads.add(rel);
      }
    }
  }
}

console.log(`\n扫描 ${lines} 行，解析 ${parsed} 条\n` + "─".repeat(56));

console.log(`\n【write 全文】${writes.size} 个文件`);
const writable = [...writes.entries()].sort((a, b) => a[0].localeCompare(b[0]));
for (const [rel, list] of writable) {
  const last = list[list.length - 1];
  console.log(`  ${String(last.content.length).padStart(7)}B  ${rel}` +
    (list.length > 1 ? `  (共 ${list.length} 次写)` : ""));
}

console.log(`\n【edit 片段】${edits.length} 处，涉及 ${new Set(edits.map(e => e.path)).size} 个文件`);
const byPath = new Map();
for (const e of edits) {
  if (!byPath.has(e.path)) byPath.set(e.path, []);
  byPath.get(e.path).push(e);
}
for (const [p, list] of [...byPath.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const chars = list.reduce((n, e) => n + e.edits.reduce((m, x) => m + (x.newText?.length || 0), 0), 0);
  console.log(`  ${list.length} 处 / ${chars}B  ${p}`);
}

console.log(`\n【read 过（仅供对照，非完整）】${reads.size} 个`);
fs.writeFileSync("W:/Games/Hanako/Work/已分类/工作/代码/tavern-recovery-inventory.json",
  JSON.stringify({
    writes: Object.fromEntries([...writes].map(([k, v]) => [k, v.map(x => ({ session: x.session, idx: x.idx, len: x.content.length }))])),
    edits: edits.map(e => ({ path: e.path, session: e.session, idx: e.idx, n: e.edits.length })),
    reads: [...reads]
  }, null, 1));
console.log("\n清单已写入 tavern-recovery-inventory.json");
