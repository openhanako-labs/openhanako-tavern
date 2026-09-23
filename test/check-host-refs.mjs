// test/check-host-refs.mjs — 扫前端模块：用了宿主对象但没 import（常驻）
//
// 为什么单独一个检查：check-undefined-refs 只扫 UPPER_SNAKE 常量，
// 漏了小写的宿主对象。真实案例：chat.js 的 sendMessageStream 用了裸 hana，
// 没 import { hana } from "../sdk.js" —— 运行时报 hana is not defined，
// 而 node --check 完全沉默（它不解析作用域外的标识符）。
//
// 判定：文件里出现裸 hana（排除字符串/注释/属性访问前的 hana），
// 但没有任何 import 语句引入 hana，就报错。
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(path.resolve(import.meta.dirname, ".."), "ui", "assets", "modules");
const files = fs.readdirSync(DIR).filter(f => f.endsWith(".js"));

let bad = 0;
for (const f of files) {
  const raw = fs.readFileSync(path.join(DIR, f), "utf8");
  const hasImport = /import\s*\{[^}]*\bhana\b[^}]*\}\s*from/.test(raw)
    || /import\s+hana\s+from/.test(raw);

  // 剥字符串与注释后再找裸 hana，避免把注释里的例子当代码
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/`(?:[^`\\]|\\.)*`/g, " `` ")
    .replace(/"(?:[^"\\]|\\.)*"/g, ' "" ')
    .replace(/'(?:[^'\\]|\\.)*'/g, " '' ");

  // 裸 hana：前面不是 . 也不是 window. 之类
  const uses = [];
  for (const m of code.matchAll(/(?<![.\w$])hana\b/g)) uses.push(m.index);

  if (uses.length > 0 && !hasImport) {
    const line = code.slice(0, uses[0]).split("\n").length;
    console.log(`  ❌ ${f}: 第 ${line} 行起用了 hana，但没有 import 它`);
    console.log(`     ${code.split("\n")[line - 1].trim().slice(0, 90)}`);
    bad++;
  }
}
console.log(bad === 0 ? `✅ ${files.length} 个模块对 hana 的引用都有 import` : `❌ ${bad} 个模块用了未 import 的 hana`);
process.exit(bad > 0 ? 1 : 0);
