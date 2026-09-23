// tools/probe-session.mjs — 摸清会话 JSONL 的真实结构（一次性）
import fs from "node:fs";

const f = process.argv[2];
const rows = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);

const types = {};
let hitWrite = 0, hitEleckoi = 0, hitToolWord = 0;
const samples = [];

for (const r of rows) {
  let o; try { o = JSON.parse(r); } catch { continue; }
  types[o.type] = (types[o.type] || 0) + 1;
  if (r.includes('"write"')) { hitWrite++; if (samples.length < 3) samples.push(r.slice(0, 700)); }
  if (r.includes("eleckoi-tavern")) hitEleckoi++;
  if (/toolUse|tool_use|toolCall|toolResult/.test(r)) hitToolWord++;
}

console.log("总行数:", rows.length);
console.log("type 分布:", JSON.stringify(types, null, 1));
console.log("含 '\"write\"' 的行:", hitWrite);
console.log("含 'eleckoi-tavern' 的行:", hitEleckoi);
console.log("含 tool* 词的行:", hitToolWord);
console.log("\n--- write 样本 ---");
for (const s of samples) console.log(s + "\n");
