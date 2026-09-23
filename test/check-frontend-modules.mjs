// test/check-frontend-modules.mjs — 前端模块导出/依赖一致性
//
// 校验两件事：
//   1. 每个 import 的名字，目标模块真的导出了吗
//   2. 有没有循环依赖
//
// 语法对错交给 node --check（本文件只管名字与依赖图）。
// 早期版本用 new Function() 编译剥了 import 的代码来判断语法，
// 那会把模板串与正则里的反引号搞乱，报一堆假错——已移除。

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DIR = path.join(path.resolve(import.meta.dirname, ".."), "ui", "assets", "modules");
const files = fs.readdirSync(DIR).filter(f => f.endsWith(".js"));

let errors = 0;

// ── 1. 语法（交给 node --check，它比 new Function 可靠）──
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", path.join(DIR, f)], { stdio: "pipe" });
  } catch (e) {
    console.log(`  ❌ ${f}: 语法错误`);
    console.log("     " + String(e.stderr || e.message).split("\n").slice(0, 3).join("\n     "));
    errors++;
  }
}
console.log(`语法：${files.length - errors}/${files.length} 通过`);

// ── 2. 收集每个文件的导出 ──
const sources = new Map();
for (const f of files) sources.set(f, fs.readFileSync(path.join(DIR, f), "utf8"));

const exportsOf = new Map();
for (const [f, src] of sources) {
  const names = new Set();
  // export function/class/const/let/var NAME
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|class)\s+(\w+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+(\w+)/gm)) names.add(m[1]);
  // export { a, b as c }
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const as = part.split(/\bas\b/);
      names.add((as[1] || as[0]).trim());
    }
  }
  // export default
  if (/^export\s+default/m.test(src)) names.add("default");
  exportsOf.set(f, names);
}

console.log("\n各模块导出：");
for (const [f, names] of [...exportsOf].sort()) {
  console.log(`  ${f.padEnd(18)} ${[...names].sort().join(", ") || "（无）"}`);
}

// ── 3. 校验 import ──
console.log("\n校验 import：");
let importErrors = 0;
for (const [f, src] of sources) {
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/([^"]+)"/g)) {
    const target = m[2];
    const avail = exportsOf.get(target);
    if (!avail) {
      console.log(`  ❌ ${f}: import 自不存在的模块 ${target}`);
      importErrors++;
      continue;
    }
    for (const raw of m[1].split(",")) {
      const name = raw.split(/\bas\b/)[0].trim();
      if (!name) continue;
      if (!avail.has(name)) {
        console.log(`  ❌ ${f}: 从 ${target} import 了未导出的 "${name}"`);
        importErrors++;
      }
    }
  }
}
if (importErrors === 0) console.log("  ✅ 所有 import 名字都能对上");
errors += importErrors;

// ── 4. 循环依赖 ──
const graph = new Map();
for (const [f, src] of sources) {
  const deps = [];
  for (const m of src.matchAll(/from\s*"\.\/([^"]+)"/g)) deps.push(m[1]);
  graph.set(f, deps);
}
console.log("\n依赖图：");
for (const [f, deps] of [...graph].sort()) {
  console.log(`  ${f.padEnd(18)} → ${deps.join(", ") || "（无）"}`);
}

let cycles = 0;
function findCycle(start, cur, seen, pathArr) {
  for (const next of graph.get(cur) || []) {
    if (next === start && pathArr.length > 0) return [...pathArr, next];
    if (!graph.has(next) || seen.has(next)) continue;
    seen.add(next);
    const r = findCycle(start, next, seen, [...pathArr, next]);
    if (r) return r;
  }
  return null;
}
for (const f of files) {
  const c = findCycle(f, f, new Set(), [f]);
  if (c) {
    console.log(`\n  ❌ 循环依赖: ${c.join(" → ")}`);
    cycles++;
    break;
  }
}

console.log("\n" + "=".repeat(50));
const ok = errors === 0 && cycles === 0;
console.log(ok ? "全部通过" : `失败 ${errors + cycles} 项`);
process.exit(ok ? 0 : 1);
