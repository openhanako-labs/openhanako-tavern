// tools/extract-reads.mjs — 从会话 JSONL 提取所有 read 调用的返回内容
//
// read 的返回是带截断的文本（可能 "2000 lines or 50KB" 截断），
// 对大文件只是片段。但配上 edit 的 old/new，多数能还原。
//
// toolResult 结构（实测）：
//   {"type":"message","message":{"role":"toolResult","toolName":"read",
//    "content":[{"type":"text","text":"...文件内容..."}]}}

import fs from "node:fs";
import path from "node:path";

const SESSIONS = process.argv.slice(2);
const OUT = "W:/Games/Hanako/Work/已分类/工作/代码/tavern-reads";

function relPath(p) {
  if (typeof p !== "string") return null;
  const s = p.replace(/\//g, "\\");
  const pre = "W:\\Games\\Hanako\\.hanako\\apps\\eleckoi-tavern\\";
  // read 的 input 里 path 可能是相对 App 根的
  if (s.startsWith(pre)) return s.slice(pre.length);
  return null;
}

// 需要把 toolCallId → 请求参数 对上（read 的参数在 toolCall.arguments 里）
const callArgs = new Map();   // id -> {name, path, ...}
/** rel -> [{ts, text}] */
const reads = new Map();

for (const file of SESSIONS) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { continue; }

  for (const row of text.split("\n")) {
    if (!row.trim()) continue;
    let o; try { o = JSON.parse(row); } catch { continue; }
    if (o?.type !== "message") continue;
    const msg = o.message;
    const content = msg?.content;
    if (!Array.isArray(content)) continue;

    // 第一遍：记 toolCall
    if (msg.role === "assistant") {
      for (const c of content) {
        if (c?.type !== "toolCall") continue;
        const args = c.arguments || {};
        const rel = relPath(args.path);
        if (rel) callArgs.set(c.id, { name: c.name, rel, args });
      }
    }

    // 第二遍：收 toolResult
    if (msg.role === "toolResult") {
      const id = msg.toolCallId;
      const call = callArgs.get(id);
      if (!call || call.name !== "read") continue;
      const body = content.filter(c => c?.type === "text").map(c => c.text).join("\n");
      if (!body) continue;
      if (!reads.has(call.rel)) reads.set(call.rel, []);
      reads.get(call.rel).push({ ts: o.timestamp || "", text: body });
    }
  }
}

console.log(`\n提取到 ${reads.size} 个文件的 read 记录\n` + "─".repeat(64));

const manifest = [];
for (const [rel, list] of [...reads.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  // 取最长的一次（最可能没被截断）
  const best = list.reduce((a, b) => (b.text.length > a.text.length ? b : a));
  const safe = rel.replace(/[\\/]/g, "__");
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, safe + ".read.txt"), best.text, "utf8");
  manifest.push({ rel, bytes: best.text.length, reads: list.length, ts: best.ts });
  console.log(`  ${String(best.text.length).padStart(7)}B  ×${String(list.length).padStart(2)}  ${rel}`);
}

fs.writeFileSync(path.join(OUT, "_manifest.json"), JSON.stringify(manifest, null, 1), "utf8");
console.log("─".repeat(64));
const total = manifest.reduce((n, m) => n + m.bytes, 0);
console.log(`合计 ${(total / 1024).toFixed(1)} KB → ${OUT}`);
