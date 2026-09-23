// tools/extract-writes.mjs — 从会话 JSONL 提取所有 write 调用的完整内容
//
// 结构（实测）：
//   {"type":"message","message":{"role":"assistant","content":[
//     {"type":"toolCall","id":"call_x","name":"write",
//      "arguments":{"path":"...","content":"...完整全文..."}}]}}
//
// 每个 path 可能被写多次，取最后一次（它反映最终状态）。
// edit 的 oldText/newText 单独导出：只有在原文件已还原时才能套用。

import fs from "node:fs";
import path from "node:path";

const SESSIONS = process.argv.slice(2);
const OUT = "W:/Games/Hanako/Work/已分类/工作/代码/tavern-recovered";
const APP_PREFIXES = [
  "W:\\Games\\Hanako\\.hanako\\apps\\eleckoi-tavern\\",
  "W:/Games/Hanako/.hanako/apps/eleckoi-tavern/",
  "apps/eleckoi-tavern/",
];

function relPath(p) {
  if (typeof p !== "string") return null;
  const s = p.replace(/\//g, "\\");
  for (const pre of APP_PREFIXES) {
    const norm = pre.replace(/\//g, "\\");
    if (s.startsWith(norm)) return s.slice(norm.length);
  }
  return null;
}

/** rel -> [{ts, content}] */
const writes = new Map();
const editLog = [];

for (const file of SESSIONS) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { continue; }

  for (const row of text.split("\n")) {
    if (!row.trim()) continue;
    let o; try { o = JSON.parse(row); } catch { continue; }
    if (o?.type !== "message") continue;
    const msg = o.message;
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;

    for (const c of msg.content) {
      if (c?.type !== "toolCall") continue;
      const args = c.arguments || {};
      const rel = relPath(args.path);
      if (!rel) continue;

      if (c.name === "write") {
        if (!writes.has(rel)) writes.set(rel, []);
        writes.get(rel).push({ ts: o.timestamp || "", content: args.content ?? "" });
      } else if (c.name === "edit") {
        editLog.push({ rel, ts: o.timestamp || "", edits: args.edits || [] });
      }
    }
  }
}

console.log(`\n提取到 ${writes.size} 个被 write 过的文件、${editLog.length} 处 edit\n` + "─".repeat(60));

// 落盘：每个文件取最后一次 write
let totalBytes = 0;
const manifest = [];
for (const [rel, list] of [...writes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const last = list[list.length - 1];
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, last.content, "utf8");
  totalBytes += last.content.length;
  manifest.push({
    rel,
    bytes: last.content.length,
    writes: list.length,
    firstTs: list[0].ts,
    lastTs: last.ts,
  });
  console.log(`  ${String(last.content.length).padStart(7)}B  ×${String(list.length).padStart(2)}  ${rel}`);
}

fs.writeFileSync(path.join(OUT, "_manifest.json"), JSON.stringify(manifest, null, 1), "utf8");
fs.writeFileSync("W:/Games/Hanako/Work/已分类/工作/代码/tavern-edit-log.json", JSON.stringify(editLog, null, 1), "utf8");

console.log("─".repeat(60));
console.log(`合计 ${(totalBytes / 1024).toFixed(1)} KB → ${OUT}`);
console.log(`edit 记录 → tavern-edit-log.json`);
