// test/check-undefined-refs.mjs — 扫前端模块里「引用了 UPPER_SNAKE 常量但没定义」（常驻）
//
// 为什么需要：read 分页会把常量定义整段丢掉，而引用它的代码还在。
// node --check 查不出未定义变量（只查语法），check-frontend-modules
// 只查 import 名对不对。于是这类错直达运行时：一个 ReferenceError
// 把所有请求全炸掉，界面只显示一句笼统的「加载失败」。
//
// 真实案例：FETCH_TIMEOUT_MS 的定义被 read 截断丢掉，apiFetch 一调用就
// ReferenceError，两条 attempt 全废，最后 throw「All fetch attempts failed」。
// 那句错误信息本身也把真实原因吞了。
//
// 判据收得很窄：只查 UPPER_SNAKE 命名（模块级常量的约定），
// 且不在「声明 + import + 全局」集合里。局部变量一律不查——误报会淹掉真信号。
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(path.resolve(import.meta.dirname, ".."), "ui", "assets", "modules");
const files = fs.readdirSync(DIR).filter(f => f.endsWith(".js"));

const GLOBAL_CONSTS = new Set([
  "JSON", "URL", "Math", "Object", "Array", "String", "Number", "Boolean", "Date",
  "RegExp", "Error", "Map", "Set", "Promise", "Uint8Array", "Buffer", "Headers",
  "FormData", "TextDecoder", "TextEncoder", "AbortController", "Blob", "File",
  "FileReader", "Image", "WebSocket", "HTMLElement", "CustomEvent", "Event",
  "NaN", "Infinity", "HTTP", "UTF", "ASCII", "GET", "POST", "PUT", "DELETE",
  "PATCH", "HEAD", "OPTIONS", "ID", "DOM", "UI", "API", "URLSearchParams"
]);

let problems = 0;
for (const f of files) {
  const src = fs.readFileSync(path.join(DIR, f), "utf8");
  const known = new Set(GLOBAL_CONSTS);

  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(",")) known.add(part.split(/\bas\b/).pop().trim());
  }
  for (const m of src.matchAll(/import\s+(\w+)\s+from/g)) known.add(m[1]);
  for (const m of src.matchAll(/import\s*\*\s*as\s+(\w+)/g)) known.add(m[1]);
  for (const m of src.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) known.add(m[1]);
  for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function\*?|class)\s+(\w+)/gm)) known.add(m[1]);
  // 解构：const { A, B } = ...
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(",")) known.add(part.split(":").pop().trim());
  }

  // 剥字符串与注释
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/`(?:[^`\\]|\\.)*`/g, " `` ")
    .replace(/"(?:[^"\\]|\\.)*"/g, ' "" ')
    .replace(/'(?:[^'\\]|\\.)*'/g, " '' ");

  const used = new Set();
  for (const m of code.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) used.add(m[1]);

  const unknown = [...used].filter(n => !known.has(n));
  if (unknown.length > 0) {
    console.log(`  ❌ ${f}: 引用了未定义的常量 → ${unknown.join(", ")}`);
    problems++;
  }
}
console.log(problems === 0 ? `✅ ${files.length} 个模块的 UPPER_SNAKE 常量都有定义` : `❌ ${problems} 个模块有未定义常量`);
process.exit(problems > 0 ? 1 : 0);
