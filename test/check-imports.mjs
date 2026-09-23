// test/check-imports.mjs — 断链扫描：import 指向不存在的文件就报出来
// 保留（一次性工具转正）：这轮恢复里最容易出现的就是这个病。
import fs from "node:fs";
import path from "node:path";

const APP = path.resolve(import.meta.dirname, "..");
const SKIP_DIRS = new Set([".git", "node_modules", "_recovery"]);

function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(p); }
    else if (/\.(js|mjs)$/.test(e.name)) yield p;
  }
}

const missing = new Map();
let scanned = 0;
for (const abs of walk(APP)) {
  scanned++;
  // 先剥块注释与行注释：举例用的示例代码常写成 import 语句，
  // 不剥就会报出「lib/lore/lib/lore/index.js」这种根本不存在的断链。
  const src = fs.readFileSync(abs, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    let t = path.resolve(path.dirname(abs), m[1]);
    if (!/\.[a-z]+$/i.test(t)) t += ".js";
    if (!fs.existsSync(t)) {
      const rel = path.relative(APP, t).replace(/\\/g, "/");
      if (!missing.has(rel)) missing.set(rel, []);
      missing.get(rel).push(path.relative(APP, abs).replace(/\\/g, "/"));
    }
  }
}

console.log(`扫描 ${scanned} 个 js`);
if (missing.size === 0) {
  console.log("✅ 无断链");
  process.exit(0);
}
console.log(`❌ ${missing.size} 个断链：`);
for (const [t, u] of [...missing].sort()) {
  console.log(`  ${t}`);
  console.log(`     ← ${u.slice(0, 3).join(", ")}${u.length > 3 ? ` 等 ${u.length} 处` : ""}`);
}
process.exit(1);
