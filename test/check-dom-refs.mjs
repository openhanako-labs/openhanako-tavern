// test/check-dom-refs.mjs — 扫所有前端模块引用的 dom.* 是否都存在于 dom.js（常驻）
//
// 为什么需要：dom.js 是从 read 分页恢复的，尾部被截掉过一批引用。
// 少了某项不会抛错——调用方写的是 dom.x?.addEventListener(...)，
// optional chaining 让整条绑定静默跳过。于是侧栏收起、对话选择器
// 这些功能「按钮点了没反应」，而控制台一片干净。
//
// 这类静默失效比抛错难查十倍，所以值得一个专门检查。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIR = path.join(ROOT, "ui", "assets", "modules");

const domSrc = fs.readFileSync(path.join(DIR, "dom.js"), "utf8");
// dom.js 里定义的键：对象字面量里的 key:，以及后续的 dom.x =
const defined = new Set();
for (const m of domSrc.matchAll(/^\s{2}(\w+)\s*:/gm)) defined.add(m[1]);
for (const m of domSrc.matchAll(/^dom\.(\w+)\s*=/gm)) defined.add(m[1]);

let bad = 0;
for (const f of fs.readdirSync(DIR).filter(x => x.endsWith(".js") && x !== "dom.js")) {
  const src = fs.readFileSync(path.join(DIR, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/`(?:[^`\\]|\\.)*`/g, " `` ")
    .replace(/"(?:[^"\\]|\\.)*"/g, ' "" ')
    .replace(/'(?:[^'\\]|\\.)*'/g, " '' ");

  for (const m of src.matchAll(/(?<![.\w$])dom\.(\w+)/g)) {
    if (!defined.has(m[1])) {
      const line = src.slice(0, m.index).split("\n").length;
      console.log(`  ❌ ${f}:${line} 用了 dom.${m[1]}，dom.js 里没有定义`);
      bad++;
    }
  }
}
console.log(bad === 0
  ? `✅ ${defined.size} 个 dom 引用，所有模块都用得上`
  : `❌ ${bad} 处引用了不存在的 dom.*`);
process.exit(bad > 0 ? 1 : 0);
