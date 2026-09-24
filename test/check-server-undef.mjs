// test/check-server-undef.mjs — 扫 lib 里「调用了但从未定义/导入」的名字（常驻）
//
// 病因已记录过两次，都是同一种：
//
//   重建 App 时 read 分页把文件**尾部整段截掉**——函数定义丢了、调用还在。
//   前端有一条 check-undefined-refs.mjs 专治它（起因是 FETCH_TIMEOUT_MS
//   的定义被截掉，apiFetch 一调用就 ReferenceError，最后只吐出一句
//   「All fetch attempts failed」），但它只扫 ui/assets/modules/。
//
//   服务端从来没查过。于是：
//     · withRealWindow —— 4 处调用、定义整段消失
//       → 四条生成路由一被调用就 ReferenceError
//       → **「发消息」这个主操作从路由层整个是死的**
//     · persistUsage / persistSummary / createSseStream / extractReasoning
//       / withGenerationContext —— 同一段里一起没的
//
// 判据是启发式的，方向故意偏「宁可漏报」：
//   · 只查小写开头的名字（构造器 / 类名误报率太高，放过）
//   · 前面有 . 或 # 的不算调用（成员与私有方法是另一回事）
//   · 定义位置收得很宽：import、声明、解构、函数参数、箭头参数、
//     类方法、对象方法简写、get/set 访问器——全都算「已知」
// 所以它抓的是「这个名字在本文件里哪儿都没出现过」，
// 而不是「作用域分析说它未定义」。误报少，才是能长期开着的护栏。
//
// 已知会漏的：跨文件的全局挂载、动态 eval、模板字符串里 ${} 的调用
//（整个模板字符串被剥掉了）。

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LIB = path.join(ROOT, "lib");

function walk(d) {
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "await", "new",
  "function", "do", "else", "delete", "void", "in", "of", "case", "throw",
  "yield", "super", "this", "class", "const", "let", "var", "async", "try",
  "finally", "break", "continue", "default", "export", "import", "from", "as"
]);

const BUILTINS = new Set([
  "console", "require", "Number", "String", "Boolean", "Array", "Object", "JSON",
  "Math", "Date", "RegExp", "Error", "TypeError", "RangeError", "Map", "Set",
  "WeakMap", "Promise", "Symbol", "BigInt", "parseInt", "parseFloat", "isNaN",
  "isFinite", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval", "structuredClone",
  "fetch", "URL", "URLSearchParams", "AbortController", "TextEncoder", "TextDecoder",
  "Buffer", "atob", "btoa", "queueMicrotask", "globalThis", "process", "eval",
  "Intl", "Proxy", "Reflect", "Float32Array", "Uint8Array", "Uint32Array",
  "ArrayBuffer", "crypto", "performance", "FormData", "Blob", "File",
  "Response", "Request", "Headers", "ReadableStream", "WritableStream"
]);

/** 已知的误报（真存在但启发式看不见）。加进来要写清原因。 */
const ALLOW = new Set([
  // 目前为空。加之前先确认它不是真问题。
]);

/**
 * 剥掉正则字面量。
 *
 * 不剥的话，regex-heavy 的代码里到处是假调用：
 * `/^(\d*)d(\d+)$/` 里那个 `d(` 会被看成调用 d(…)。
 *
 * 用的判定：`/` 前面是「只能接表达式起始」的字符（( [ { , ; = ! & | ? : + - * % ~ ^ < >）
 * 或行首——那就是正则字面量，扫到配对的 `/` 为止（照顾字符类与转义）。
 * 除法不会误伤：`a / b` 里 `/` 前面是标识符。
 */
function stripRegexLiterals(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "/" && s[i + 1] !== "/" && s[i + 1] !== "*") {
      const prev = out.replace(/\s+$/, "").slice(-1);
      if (prev === "" || "([{,!&|?:;=+-*%~^<>".includes(prev)) {
        let j = i + 1, inClass = false, closed = false;
        while (j < s.length) {
          const c = s[j];
          if (c === "\\") { j += 2; continue; }
          if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          else if (c === "/" && !inClass) { closed = true; break; }
          else if (c === "\n") break;
          j++;
        }
        if (closed) { out += " RE "; i = j + 1; continue; }
      }
    }
    out += ch;
    i++;
  }
  return out;
}

let bad = 0;
const files = walk(LIB);

for (const file of files) {
  const raw = fs.readFileSync(file, "utf8");

  // 剥注释与字符串（模板字符串整体剥掉——里面 ${} 的调用不追）
  const src = stripRegexLiterals(
    raw
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
      .replace(/`(?:[^`\\]|\\.)*`/g, " `` ")
      .replace(/"(?:[^"\\]|\\.)*"/g, ' "" ')
      .replace(/'(?:[^'\\]|\\.)*'/g, " '' ")
  );

  const known = new Set([...BUILTINS]);

  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(",")) {
      const n = part.split(/\bas\b/).pop().trim();
      if (n) known.add(n);
    }
  }
  for (const m of src.matchAll(/import\s+(\w+)\s*(?:,|from)/g)) known.add(m[1]);
  for (const m of src.matchAll(/import\s*\*\s*as\s*(\w+)/g)) known.add(m[1]);

  for (const m of src.matchAll(/(?:^|\s)(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) known.add(m[1]);
  for (const m of src.matchAll(/(?:^|\s)(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) known.add(m[1]);
  for (const m of src.matchAll(/(?:^|\s)class\s+([A-Za-z_$][\w$]*)/g)) known.add(m[1]);

  // 类方法 / 对象方法简写（含 #私有 与 get/set）：行首 name(...) { —— 调用不会被 { 跟在后面
  for (const m of src.matchAll(/^\s*(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?\*?(#?[A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    known.add(m[1]);
    known.add(m[1].replace(/^#/, ""));
    for (const part of m[2].split(",")) {
      const n = part.split(/[:=]/)[0].trim().replace(/^\.\.\./, "").replace(/[{}[\]]/g, "");
      if (/^[A-Za-z_$][\w$]*$/.test(n)) known.add(n);
    }
  }

  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(",")) {
      const n = part.split(/[:=]/).pop().trim().replace(/^\.\.\./, "");
      if (n) known.add(n);
    }
  }
  for (const m of src.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]\s*=/g)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().replace(/^\.\.\./, "");
      if (n) known.add(n);
    }
  }
  for (const m of src.matchAll(/(?:function\s*\*?\s*\w*|^\s*(?:const|let)\s+\w+\s*=)\s*\(([^)]*)\)/gm)) {
    for (const part of m[1].split(",")) {
      const n = part.split(/[:=]/)[0].trim().replace(/^\.\.\./, "").replace(/[{}[\]]/g, "");
      if (/^[A-Za-z_$][\w$]*$/.test(n)) known.add(n);
    }
  }
  for (const m of src.matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const part of m[1].split(",")) {
      const n = part.split(/[:=]/)[0].trim().replace(/^\.\.\./, "").replace(/[{}[\]]/g, "");
      if (/^[A-Za-z_$][\w$]*$/.test(n)) known.add(n);
    }
  }
  for (const m of src.matchAll(/(?:^|[(,\s])([A-Za-z_$][\w$]*)\s*=>/g)) known.add(m[1]);
  for (const m of src.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) known.add(m[1]);

  const used = new Map();
  for (const m of src.matchAll(/(?<![.#\\\w$])([a-zA-Z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (KEYWORDS.has(name) || known.has(name) || ALLOW.has(name)) continue;
    if (/^[A-Z]/.test(name)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    if (!used.has(name)) used.set(name, line);
  }

  if (used.size) {
    bad += used.size;
    console.log(`\n  ❌ ${path.relative(ROOT, file).replace(/\\/g, "/")}`);
    for (const [name, line] of used) {
      console.log(`     ${line}: ${name}(…) —— 本文件里找不到它的定义或导入`);
    }
  }
}

console.log(bad === 0
  ? `  ✅ 扫 ${files.length} 个 lib 文件：没有「调用了但没定义」的名字`
  : `  ❌ 共 ${bad} 处`);
process.exit(bad > 0 ? 1 : 0);
