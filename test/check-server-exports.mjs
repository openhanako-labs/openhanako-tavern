// test/check-server-exports.mjs — 服务端导出名一致性（新增，常驻）
//
// 为什么需要这个：前端有 check-frontend-modules 查导出名，服务端没有。
// node --check 按 CommonJS 解析，看不出「import 了不存在的导出」
// （重复声明也看不出）。这些错只在 ESM import 时炸，
// 而 App 的入口正是 ESM —— 于是全躲过静态检查，直达运行时。
//
// 本文件静态扫：import 的每个名字，目标模块真的导出了吗。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// ROOT 从脚本位置推导（test/ 的上一级），不写死绝对路径——
// 这份快照会在 apps/ 与备份目录之间搬来搬去，写死就找不到。
const ROOT = path.resolve(import.meta.dirname, "..");
const SKIP = new Set([".git", "node_modules", "_recovery"]);

function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) yield* walk(p); }
    else if (/\.(js|mjs)$/.test(e.name)) yield p;
  }
}

const files = [...walk(ROOT)];

// 收集每个文件导出的名字（含 re-export 的透传，向下追一层）
function exportsOf(abs, depth = 0) {
  const src = fs.readFileSync(abs, "utf8");
  const names = new Set();
  // 注意 function 与名字之间可能有 *（生成器）：export async function* readX
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|class)\s+(\w+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+(\w+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const seg = part.split(/\bas\b/);
      names.add((seg[1] || seg[0]).trim());
    }
  }
  if (/^export\s+default/m.test(src)) names.add("default");
  // export * from "./x.js" —— 把被导出模块的名字并进来
  if (depth < 2) {
    for (const m of src.matchAll(/^export\s*\*\s*from\s*["'](\.[^"']+)["']/gm)) {
      const t = path.resolve(path.dirname(abs), m[1]);
      const withExt = /\.[a-z]+$/i.test(t) ? t : t + ".js";
      if (fs.existsSync(withExt)) for (const n of exportsOf(withExt, depth + 1)) names.add(n);
    }
  }
  return names;
}

const cache = new Map();
const avail = (abs) => {
  if (!cache.has(abs)) cache.set(abs, exportsOf(abs));
  return cache.get(abs);
};

let errors = 0;
for (const abs of files) {
  const src = fs.readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g)) {
    let t = path.resolve(path.dirname(abs), m[2]);
    if (!/\.[a-z]+$/i.test(t)) t += ".js";
    if (!fs.existsSync(t)) {
      console.log(`❌ ${path.relative(ROOT, abs)}: import 自不存在的 ${path.relative(ROOT, t)}`);
      errors++;
      continue;
    }
    const have = avail(t);
    for (const raw of m[1].split(",")) {
      const name = raw.split(/\bas\b/)[0].trim();
      if (!name) continue;
      if (!have.has(name)) {
        console.log(`❌ ${path.relative(ROOT, abs)}: 从 ${m[2]} import 了未导出的 "${name}"`);
        errors++;
      }
    }
  }
}

console.log(`扫描 ${files.length} 个文件`);
console.log(errors === 0 ? "✅ 服务端导出名全部对齐" : `❌ ${errors} 处不对齐`);
process.exit(errors > 0 ? 1 : 0);
