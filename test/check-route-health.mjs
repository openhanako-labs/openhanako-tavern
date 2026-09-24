// test/check-route-health.mjs — 路由面的两个「静态看得见」的病（常驻）
//
// 这一条是两个真 bug 换来的，它们都属于同一类：
// **形状对、名字对、静态检查全绿，但从来没工作过。**
//
//   病一：调了不存在的方法。
//     lib/regex/routes.js 里的 POST/PUT 调 `regexRepo.saveRule(...)`，
//     而仓储里根本没有 saveRule（有 create / update / importRules / ...）。
//     于是「创建与修改正则」的 API 从写下那天起就是死的，
//     一路报 "saveRule is not a function"——而没有界面，从没人碰到过。
//     路由的**路径**有 check-route-order 看着，它**调的方法名**没人看。
//
//   病二：报错写成了返回。
//     `return notFound(...)` —— notFound() 返回的是一个 Error 对象，
//     return 出去会被 route() 当成「成功的返回值」包成
//     {ok:true, data:{}}，于是 404 变成 200。前端只看得到「数据是空的」，
//     无从区分「没这条」与「有这条但字段全空」。
//     **报错的方法如果返回而不是抛出，报错就变成了沉默。**
//
// 这两条都是纯文本可判的，所以值得一个常驻检查——它们不会抛错、
// 不会在日志里留痕，只会在某个用户第一次点那个按钮的那天暴露。

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LIB = path.join(ROOT, "lib");

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const files = walk(LIB);
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, "/");

// ── 收集仓储侧可用的方法名（并集） ──
//
// 判据故意宽松：只问「这个方法名在任何一个仓储里存在吗」。
// 按 class 精确配对需要解析哪个参数对应哪个类（路由拿的是构造好的实例，
// 没有类型信息），那种解析又脆又容易假报——而这一条要抓的是
// 「这个名字哪儿都没有」，宽松判据足够且几乎不误报。
const repoMethods = new Set();
const repoFiles = files.filter(f => /[/\\]repo\.js$/.test(f));

for (const f of repoFiles) {
  const src = fs.readFileSync(f, "utf8");
  // class 体内两格缩进的方法（含 async / generator）
  for (const m of src.matchAll(/^\s{2}(?:async\s+)?(?:\*)?([a-zA-Z_$][\w$]*)\s*\(/gm)) {
    repoMethods.add(m[1]);
  }
  // 模块级的独立函数（normalizeRule / fromStRegexScript 这类也会被 routes 调）
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/gm)) {
    repoMethods.add(m[1]);
  }
  // 解构出来的键名（如 const { A, B } = ...）不在此列，误报就误报
}

let bad = 0;
const routeFiles = files.filter(f => /[/\\]routes\.js$/.test(f));

console.log(`\n扫 ${routeFiles.length} 个 routes 文件 / ${repoFiles.length} 个仓储，` +
  `仓储侧共有 ${repoMethods.size} 个可用名字\n` + "─".repeat(64));

for (const f of routeFiles) {
  const raw = fs.readFileSync(f, "utf8");
  const lines = raw.split("\n");
  // 剥注释，避免把文档示例当成真调用
  const src = lines.map(l => /^\s*(\/\/|\*|\/\*)/.test(l) ? "" : l).join("\n");
  const problems = [];

  // ── 病一：xxxRepo.method( ──
  for (const m of src.matchAll(/\b(\w*[Rr]epo)\.([a-zA-Z_$][\w$]*)\s*\(/g)) {
    const [, ident, method] = m;
    if (repoMethods.has(method)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    problems.push({
      line,
      kind: "调了不存在的方法",
      detail: `${ident}.${method}(…) —— 仓储侧没有这个方法`
    });
  }

  // ── 病二：return notFound / httpError ──
  for (const m of src.matchAll(/\breturn\s+(notFound|httpError)\s*\(/g)) {
    const line = src.slice(0, m.index).split("\n").length;
    problems.push({
      line,
      kind: "报错写成了返回",
      detail: `return ${m[1]}(…) —— 应该 throw：返回 Error 会被包成 {ok:true,data:{}}`
    });
  }

  if (problems.length) {
    bad += problems.length;
    console.log(`\n  ❌ ${rel(f)}`);
    for (const p of problems) console.log(`     ${p.line}: ${p.kind} —— ${p.detail}`);
  }
}

console.log("\n" + "─".repeat(64));
console.log(bad === 0
  ? "  ✅ 路由侧没有「调不存在的方法」与「报错写成返回」"
  : `  ❌ 共 ${bad} 处`);
process.exit(bad > 0 ? 1 : 0);
