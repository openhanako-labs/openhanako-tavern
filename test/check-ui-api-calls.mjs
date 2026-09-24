// test/check-ui-api-calls.mjs — 前端调的每个端点，后端真的注册了吗
//
// 为什么需要它：`apiFetch("tool-groups")` 这类错**不会报错**。
// 它只是一条 404，前端 catch 到之后弹一句「加载失败」，或者干脆吞掉。
// 表现出来的样子是「没有数据」，不是「代码写错了」——这个 App 里
// 这类错已经出现过一整族（工具面板、单条消息删除、四条生成路由），
// 所以让它常驻。
//
// 只扫**真被页面加载的**文件：入口是 ui/*.html 里的 <script src>，
// 然后顺着 import 走。仓库里躺着一份没人引用的旧副本
// （ui/assets/characters.js），扫它只会制造幻影——第一版就把它的行号
// 和 modules/characters.js 混成了同一个标签。
//
// 判据故意只看两件事：**路径 + 方法**能不能对上一个注册项。
// 参数形状、返回体、鉴权不在这里管（那是 regression-routes-smoke 的事）。

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const abs = (rel) => path.join(ROOT, ...rel.split("/"));
const lineAt = (src, idx) => src.slice(0, idx).split("\n").length;

// ── 先把注释抹掉 ──────────────────────────────────────
//
// 不抹的话，**注释里提到的东西会被当成真代码**：
//   - 前端：`// URL 由 hana.api.url() 拼` → 幻影调用
//   - 后端：注释掉的 `app.get("/x")` → 注册表凭空多一条，**判据变松**
// 后者比前者危险：它会把一条真的打错的端点放过去。
//
// 抹成等长空格（保留换行），行号就仍然对得上。
// 只把「行首或空白之后的 //」当注释开头，避开 `https://` 与正则里的 `\/\/`。
function blankComments(src) {
  const out = [...src];
  let i = 0, inTpl = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "`") { inTpl = !inTpl; i++; continue; }
    if (!inTpl && (ch === '"' || ch === "'")) {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) { if (src[j] === "\\") j++; j++; }
      i = j + 1; continue;                       // 字符串要留着——路径就在里面
    }
    if (!inTpl && ch === "/" && src[i + 1] === "/" && (i === 0 || /\s/.test(src[i - 1]))) {
      while (i < src.length && src[i] !== "\n") { out[i] = " "; i++; }
      continue;
    }
    if (!inTpl && ch === "/" && src[i + 1] === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < src.length) { out[i] = " "; out[i + 1] = " "; i += 2; }
      continue;
    }
    i++;
  }
  return out.join("");
}

// ── 后端注册表 ────────────────────────────────────────
// 路径都是字面量（实测过），所以静态解析就够。
function readRegistry() {
  const files = fs.readdirSync(path.join(ROOT, "lib"))
    .map(d => `lib/${d}/routes.js`)
    .filter(p => fs.existsSync(abs(p)));
  files.push("index.js");

  const out = [];
  const re = /app\.(get|post|put|delete|patch)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  for (const rel of files) {
    const src = blankComments(fs.readFileSync(abs(rel), "utf8"));
    let m;
    while ((m = re.exec(src))) {
      out.push({ method: m[1].toUpperCase(), path: m[2].replace(/^\//, ""), from: rel });
    }
  }
  return out;
}

// ── 跟着页面真加载的东西走 ────────────────────────────
function reachableUiFiles() {
  const queue = [];
  for (const h of fs.readdirSync(path.join(ROOT, "ui")).filter(f => f.endsWith(".html"))) {
    const src = fs.readFileSync(path.join(ROOT, "ui", h), "utf8");
    for (const m of src.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) {
      queue.push(path.posix.join("ui", m[1].replace(/^\.\//, "")));
    }
  }
  const seen = new Set();
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel) || !fs.existsSync(abs(rel))) continue;
    seen.add(rel);
    const src = fs.readFileSync(abs(rel), "utf8");
    for (const m of src.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
    }
  }
  return [...seen];
}

// ── 解析调用（跳过字符串/模板里的括号与逗号）──────────
function scanRaw(src, openIdx) {
  let depth = 0, inTpl = false;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "`") { inTpl = !inTpl; depth += inTpl ? 1 : -1; continue; }
    if (!inTpl && (ch === '"' || ch === "'")) {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) { if (src[j] === "\\") j++; j++; }
      i = j; continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return src.slice(openIdx + 1, i); }
  }
  return null;
}

function splitTop(raw) {
  const parts = []; let depth = 0, cur = "", inTpl = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "`") { inTpl = !inTpl; depth += inTpl ? 1 : -1; cur += ch; continue; }
    if (!inTpl && (ch === '"' || ch === "'")) {
      let j = i + 1;
      while (j < raw.length && raw[j] !== ch) { if (raw[j] === "\\") j++; j++; }
      cur += raw.slice(i, j + 1); i = j; continue;
    }
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map(s => s.trim());
}

function methodOf(optExpr) {
  if (!optExpr || optExpr.trim() === "{}") return "GET";
  const m = optExpr.match(/\bmethod\s*:\s*["'`](\w+)["'`]/);
  if (m) return m[1].toUpperCase();
  return optExpr.trim().startsWith("{") ? "GET" : "?";
}

const QUERY_VARS = /^(qs|query|q|params|queryString)$/;

/** 表达式 → 端点路径。拿不准就返回 null（进盲区，不假装它是对的）。 */
function normalizePath(expr) {
  const e = String(expr || "").trim();
  if (e.startsWith("`")) {
    let inner = e.slice(1, e.lastIndexOf("`"));
    inner = inner.replace(/\$\{([^}]*)\}\s*$/, (mm, name) => (QUERY_VARS.test(name.trim()) ? "" : "/:p"));
    inner = inner.replace(/^.*?\$\{[^}]*\}\s*[?&]/, "");
    inner = inner.replace(/\$\{[^}]*\}/g, ":p");
    return inner.split("?")[0].replace(/^\//, "").replace(/\/{2,}/g, "/");
  }
  if (/^["']/.test(e)) {
    const q = e[0];
    let j = 1;
    while (j < e.length && e[j] !== q) { if (e[j] === "\\") j++; j++; }
    return e.slice(1, j).split("?")[0].replace(/^\//, "");
  }
  return null;
}

function scanCalls(rel, src) {
  const calls = [];

  for (const m of src.matchAll(/\bapiFetch\s*\(/g)) {
    // 跳过**定义**（`export async function apiFetch(path, options)`）
    if (/(^|\s)(async\s+)?function\s*$/.test(src.slice(Math.max(0, m.index - 40), m.index))) continue;
    const openIdx = src.indexOf("(", m.index);
    const raw = scanRaw(src, openIdx);
    if (raw == null) continue;
    const [p, o] = splitTop(raw);
    calls.push({ rel, line: lineAt(src, openIdx), pathExpr: p, method: methodOf(o) });
  }

  // hana.api.url("...") —— 拼 URL 给裸 fetch 用（流式那条路）
  for (const m of src.matchAll(/hana\.api\.url\s*\(/g)) {
    const openIdx = src.indexOf("(", m.index);
    const raw = scanRaw(src, openIdx);
    if (raw == null) continue;
    calls.push({ rel, line: lineAt(src, openIdx), pathExpr: splitTop(raw)[0], method: "ANY" });
  }

  return calls;
}

// ── 判据 ──────────────────────────────────────────────
function classify(call, registry) {
  const p = normalizePath(call.pathExpr);
  if (p == null || call.method === "?") {
    return { ok: null, why: "盲区", detail: `${call.rel}:${call.line}  ${p == null ? "(路径是变量)" : "(方法不是字面量)"}` };
  }
  const us = p.split("/").filter(Boolean);
  const hit = registry.some(r => {
    if (call.method !== "ANY" && r.method !== call.method) return false;
    const rs = r.path.split("/").filter(Boolean);
    if (rs.length !== us.length) return false;
    return rs.every((seg, i) => seg.startsWith(":") || seg === us[i] || us[i] === ":p");
  });
  return {
    ok: hit,
    detail: `${call.rel}:${call.line}  ${call.method === "ANY" ? "(任一方法)" : call.method} ${p}`
  };
}

/**
 * 盲区快照。
 *
 * 只列**看得到的**盲区，并钉住数量：新的变量型调用会在这里冒出来，
 * 而不是安静地溜进「扫不到 = 没问题」。
 */
const EXPECTED_BLIND = [
  // 预览分发：两个分支都是已注册端点（activation-preview / prompt-preview）
  "ui/assets/modules/chat-more.js — endpoint"
];
// ── 跑 ────────────────────────────────────────────────
const registry = readRegistry();
const uiFiles = reachableUiFiles();
const calls = uiFiles.flatMap(rel => scanCalls(rel, blankComments(fs.readFileSync(abs(rel), "utf8"))));

const matched = [], unmatched = [], blind = [];
for (const c of calls) {
  const r = classify(c, registry);
  if (r.ok === true) matched.push(r.detail);
  else if (r.ok === false) unmatched.push(r.detail);
  else blind.push(`${c.rel} — ${String(c.pathExpr).split("\n")[0].slice(0, 40)}`);
}

console.log("=== 前端端点引用 vs 后端注册表 ===\n");

// DEBUG_UI_CALLS=1 时把所有调用原样倒出来——排查解析器误读时用。
if (process.env.DEBUG_UI_CALLS) {
  for (const c of calls) {
    console.log(`   ${c.rel}:${c.line}  ${c.method}  ${String(c.pathExpr).split("\n")[0].slice(0, 70)}`);
  }
  console.log("");
}
console.log(`  入口可达的界面文件  ${uiFiles.length} 个`);
console.log(`  后端注册路由        ${registry.length} 条`);
console.log(`  前端端点引用        ${calls.length} 处`);
console.log(`    ✅ 对上 ${matched.length}   ❌ 对不上 ${unmatched.length}   👁 盲区 ${blind.length}`);

if (unmatched.length) {
  console.log("\n  ❌ 前端的这两件事对不上：");
  for (const u of unmatched) console.log("     " + u);
  console.log("\n     这类错不会抛异常，只会安静地 404 —— 界面表现是「没有数据」。");
}
if (blind.length) {
  console.log("\n  👁 盲区（解释器拿不到路径或方法）：");
  for (const b of blind) console.log("     " + b);
}

// ── 反证：判据必须有牙齿 ──────────────────────────────
// 不给一条真·不存在的端点喂进去，就不知道上面那个 ✅ 是不是「没扫到」。
{
  const probe = { rel: "（反证）", line: 1, pathExpr: "`tool-groups/${id}`", method: "PUT" };
  const r = classify(probe, registry);
  assert.strictEqual(
    r.ok, false,
    "判据没有牙齿：一条不存在的端点被判成了对的——那么本文件的 ✅ 不代表任何东西"
  );
}

// ── 断言 ──────────────────────────────────────────────
assert.ok(registry.length >= 80, `后端注册表只解析出 ${registry.length} 条——解析器大概坏了`);
assert.ok(uiFiles.length >= 10, `入口只走到 ${uiFiles.length} 个文件——import 追踪大概坏了`);
assert.ok(calls.length >= 60, `只扫到 ${calls.length} 处调用——解析器大概坏了（绿得没有意义）`);
assert.deepStrictEqual(
  blind.map(b => b.split("  ")[0]),
  EXPECTED_BLIND,
  "盲区集合变了。新增的必须**人工确认过**再写进 EXPECTED_BLIND，不要直接抄进去"
);
assert.strictEqual(
  unmatched.length, 0,
  `有 ${unmatched.length} 处前端在打后端没注册的端点：\n  ${unmatched.join("\n  ")}`
);

console.log("\n通过 ✅");
