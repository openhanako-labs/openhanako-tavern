// tools/probe-embedding-config.mjs —— 看插件是怎么配 embedding 的（**值一律打码**）
//
// 起因：宿主全树搜索出现 plugin-data/biaoqingbao/embedding-config.json。
// 有人已经把这个生态里的 embedding 配好过——那就该照它的样子走，
// 而不是我另发明一套。
//
// 纪律：这个脚本**只报结构**：键名、类型、长度、像不像 key、
// 以及 base_url / model 这类**可以用**的字段。任何 key 值只报长度与前后缀。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = path.join(os.homedir(), ".hanako");
const targets = [
  path.join(HOME, "plugin-data", "biaoqingbao", "embedding-config.json"),
  path.join(HOME, "model-catalog", "current.json")
];

const SECRET_RE = /(key|token|secret|password|credential)/i;
const USABLE_RE = /(url|endpoint|model|dim|dimension|provider|type|enabled|api$|batch|topk|name|id$)/i;

function describe(k, v, depth = 0) {
  const pad = "  ".repeat(depth);
  if (v === null) return `${pad}${k}: null`;
  if (typeof v === "object" && !Array.isArray(v)) return null; // 递归处理
  if (Array.isArray(v)) {
    const sample = v.length ? (typeof v[0] === "object" ? "{…}" : JSON.stringify(v[0]).slice(0, 40)) : "";
    return `${pad}${k}: [${v.length}] ${sample}`;
  }
  if (typeof v === "number" || typeof v === "boolean") return `${pad}${k}: ${v}`;
  const s = String(v);
  if (SECRET_RE.test(k) && s.length > 8) {
    return `${pad}${k}: <已打码> len=${s.length} 前缀=${s.slice(0, 3)}…`;
  }
  return `${pad}${k}: ${JSON.stringify(s.length > 90 ? s.slice(0, 90) + "…" : s)}`;
}

function walk(o, depth = 0, prefix = "") {
  for (const [k, v] of Object.entries(o || {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      console.log(`${"  ".repeat(depth)}${k}:`);
      walk(v, depth + 1, prefix + k + ".");
    } else {
      const line = describe(k, v, depth);
      if (line) console.log(line);
    }
  }
}

for (const p of targets) {
  console.log(`\n── ${p.replace(HOME, "~")}`);
  if (!fs.existsSync(p)) { console.log("   （不存在）"); continue; }
  const size = fs.statSync(p).size;
  console.log(`   大小 ${Math.round(size / 1024 * 10) / 10}KB`);
  let json;
  try { json = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { console.log(`   解析失败：${e.message}`); continue; }

  // 只在"embedding 相关"的子树里深挖；其余只报顶层键名，免得淹掉。
  const keys = Object.keys(json);
  console.log(`   顶层键：${keys.slice(0, 12).join(", ")}${keys.length > 12 ? ` …共 ${keys.length}` : ""}`);
  const embedKey = keys.find((k) => /embed/i.test(k));
  const sub = embedKey ? json[embedKey] : json;
  if (embedKey) console.log(`   ↳ 展开 ${embedKey}:`);
  walk(sub, embedKey ? 2 : 1);
}
