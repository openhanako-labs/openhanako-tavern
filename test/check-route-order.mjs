// test/check-route-order.mjs — 路由遮蔽检查
//
// Hono 按注册顺序匹配。若 /a/:id 注册在 /a/tags 之前，访问 /a/tags 会命中 :id。
// 这里静态扫描所有 routes 文件，找出被遮蔽的字面量路由。

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const libDir = path.join(root, "lib");

const files = [];
async function walk(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else if (e.name.endsWith(".js")) files.push(p);
  }
}
await walk(libDir);

const re = /app\.(get|post|put|delete|patch)\s*\(\s*["'`]([^"'`]+)["'`]/g;

const routes = [];
for (const f of files) {
  const raw = await fs.readFile(f, "utf8");
  // 剥掉注释行，避免把文档示例当成真路由
  const src = raw
    .split("\n")
    .map(l => /^\s*(\/\/|\*|\/\*)/.test(l) ? "" : l)
    .join("\n");
  for (const m of src.matchAll(re)) {
    routes.push({
      method: m[1].toUpperCase(),
      path: m[2],
      file: path.relative(root, f)
    });
  }
}

/** 把路由模板拆成段，判断两条路由是否会互相匹配。 */
function segments(p) {
  return p.split("/").filter(Boolean);
}

/** a 是否会吞掉 b（b 是字面量，a 含 :param）。 */
function shadows(a, b) {
  const sa = segments(a);
  const sb = segments(b);
  if (sa.length !== sb.length) return false;
  for (let i = 0; i < sa.length; i++) {
    const x = sa[i];
    if (x.startsWith(":")) continue;          // 通配，能匹配任何
    if (x !== sb[i]) return false;
  }
  return true;
}

const problems = [];

// 同一文件内的顺序敏感（Hono 按注册序）
const byFile = new Map();
for (const r of routes) {
  if (!byFile.has(r.file)) byFile.set(r.file, []);
  byFile.get(r.file).push(r);
}

for (const [file, list] of byFile) {
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const earlier = list[i];
      const later = list[j];
      if (earlier.method !== later.method) continue;
      // earlier 含 :param，later 是纯字面量 → later 被遮蔽
      if (!earlier.path.includes(":")) continue;
      if (later.path.includes(":")) continue;
      if (shadows(earlier.path, later.path)) {
        problems.push({
          file,
          method: earlier.method,
          shadowed: later.path,
          by: earlier.path,
          hint: `把 ${later.path} 挪到 ${earlier.path} 之前`
        });
      }
    }
  }
}

console.log(`\n扫描 ${files.length} 个文件，${routes.length} 条路由\n` + "─".repeat(50));

if (problems.length === 0) {
  console.log("  ✅ 无路由遮蔽");
} else {
  for (const p of problems) {
    console.log(`  ❌ ${p.file}  ${p.method} ${p.shadowed}`);
    console.log(`     被 ${p.by} 遮蔽 —— ${p.hint}`);
  }
}

// 顺便列出重复路径
const seen = new Map();
const dups = [];
for (const r of routes) {
  const key = `${r.method} ${r.path}`;
  if (seen.has(key)) dups.push({ key, files: [seen.get(key), r.file] });
  else seen.set(key, r.file);
}
if (dups.length) {
  console.log("\n  重复定义:");
  for (const d of dups) console.log(`    ${d.key}  (${d.files.join(", ")})`);
}

console.log("\n" + "=".repeat(50));
process.exit(problems.length > 0 ? 1 : 0);
