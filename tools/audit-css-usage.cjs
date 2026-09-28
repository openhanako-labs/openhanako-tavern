// 审计脚本：给定类名列表，列出它们在 ui/ 下的所有出现位置
// 用法：node tools/audit-css-usage.cjs class1 class2 ...
// 或者：node tools/audit-css-usage.cjs --list dead.txt

const { readFileSync, readdirSync, statSync, existsSync } = require("fs");
const { join, dirname, relative } = require("path");

const ROOT = join(__dirname, "..");
const UI = join(ROOT, "ui");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|html|css)$/.test(name)) out.push(p);
  }
  return out;
}

let classes;
if (process.argv[2] === "--list") {
  classes = readFileSync(process.argv[3], "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
} else {
  classes = process.argv.slice(2);
}

const files = walk(UI).filter(f => !f.includes("vendor"));

// 对每个类名，找出它出现的位置。要区分"作为类选择器/属性值"和"作为普通子串"。
// 用词边界匹配 `xxx`，但排除出现在 `.xxx-yyy` 这种复合词里（要精确）
const results = new Map();
for (const c of classes) results.set(c, []);

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const lines = src.split(/\r?\n/);
  const rel = relative(UI, f);
  for (const c of classes) {
    // 精确匹配：c 前面是 . " ' ` ( ， 后面是 " ' ` ) , 空白 或结尾
    const re = new RegExp("(?<![\\w-])" + c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w-])", "g");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (re.test(line)) {
        results.get(c).push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
        re.lastIndex = 0;
        break; // 每个类每个文件只报第一次
      }
    }
  }
}

for (const [c, locs] of results) {
  console.log(`\n=== .${c} ===`);
  if (locs.length === 0) {
    console.log("  (no references found)");
  } else {
    for (const l of locs) console.log("  " + l);
  }
}
