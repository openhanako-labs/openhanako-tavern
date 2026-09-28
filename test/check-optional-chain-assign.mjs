// 检查：`?.` 不能出现在赋值左侧。
//
// 为什么单开这一条：`a?.b = c` 是 ECMAScript 的「早期错误」（Early Error），
// 报的是 "Invalid left-hand side in assignment"。它发生在**解析阶段**，
// 也就是整个模块一个字符都不会执行——不是运行时才炸。
//
// 为什么 node --check 抓不到：ui/assets/modules/*.js 里用了 ESM 的 export，
// node --check 对 .js 扩展名按 CommonJS 解析，遇到 export 会提前退出，
// 于是这条早期错误被跳过。测试全绿、浏览器一开就白屏，就是这个盲区造成的。
//
// 这里用正则做静态扫描，属于"宁可误报不可漏报"的辅助检查。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SCAN_DIRS = ["ui"];
const EXT = /\.(js|mjs)$/;

/** 命中即「.? 在赋值左侧」 */
const BAD = /\?\.\s*[A-Za-z_$][\w$]*\s*(?:=(?!=)|\+=|-=|\*=|\/=|%=|\*\*=|\|\|=|&&=|\?\?=)/;

const files = [];
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "vendor") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (EXT.test(e.name)) files.push(p);
  }
}
for (const d of SCAN_DIRS) {
  try { if (statSync(d).isDirectory()) walk(d); } catch { /* 目录不存在则跳过 */ }
}

const hits = [];
for (const f of files) {
  const lines = readFileSync(f, "utf8").split(/\r?\n/);
  lines.forEach((l, i) => {
    // 跳过注释行，减少噪音
    const t = l.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    if (BAD.test(l)) hits.push(`${relative(process.cwd(), f)}:${i + 1}  ${t.slice(0, 90)}`);
  });
}

if (hits.length) {
  console.log("✗ 发现 `?.` 在赋值左侧（整个模块会解析失败）：");
  for (const h of hits) console.log("    " + h);
  console.log("\n  改法：先取元素 → 判空 → 再赋值。");
  process.exit(1);
}

console.log("✓ `?.` 赋值检查通过（" + files.length + " 个文件）");
