// test/check-ui-reachability.mjs — 前端 import 落点必须在 /ui/ 可达域内（常驻）
//
// 根因记录：chat.js 曾 import "../../../lib/macros/index.js"。文件系统上
// 它存在（检查器报绿），但 URL 上有两处致命：
//   1. URL 层级比文件系统多 _surface/<token> 两级，相对路径指偏
//   2. /ui/ 暴露域外的 lib/ 根本不下发
// 结果整张模块图 404，页面停在"加载中"的静态初始态。
//
// 判据：相对引用解析后的落点必须仍在 ui/ 目录内。
// 文件系统语义与 URL 语义在 ui/ 内等价（_surface/<token>/ ≅ ui/），
// 一旦越出 ui/，两边都错——所以判据只需要一条。
import fs from "node:fs";
import path from "node:path";

const APP = path.resolve(import.meta.dirname, "..");
const UI = path.join(APP, "ui");

const REF_PATTERNS = [
  /from\s*["'](\.{1,2}\/[^"']+)["']/g,        // import ... from "./x"
  /import\s*["'](\.{1,2}\/[^"']+)["']/g,       // import "./x"
  /export\s+[^;]*?from\s*["'](\.{1,2}\/[^"']+)["']/g, // export ... from
  /(?:src|href)\s*=\s*["'](\.{1,2}\/[^"']+)["']/g     // <script src> <link href>
];

function* files(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!["_recovery", "node_modules"].includes(e.name)) yield* files(p); }
    else if (/\.(js|mjs|html)$/.test(e.name)) yield p;
  }
}

let bad = 0, scanned = 0;
for (const abs of files(UI)) {
  scanned++;
  const src = fs.readFileSync(abs, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const relFile = path.relative(APP, abs).replace(/\\/g, "/");

  for (const re of REF_PATTERNS) {
    for (const m of src.matchAll(re)) {
      const spec = m[1];
      if (spec.includes("://")) continue;              // http(s) 外链不管
      const target = path.resolve(path.dirname(abs), spec);
      if (!target.startsWith(UI + path.sep) && target !== UI) {
        const rel = path.relative(APP, target).replace(/\\/g, "/");
        console.log(`  ❌ ${relFile}`);
        console.log(`     "${spec}" → ${rel}（越出 ui/ 可达域，浏览器 404）`);
        bad++;
      }
    }
  }
}
console.log(bad === 0
  ? `✅ 扫 ${scanned} 个前端文件，所有相对引用都在 /ui/ 可达域内`
  : `❌ ${bad} 处越界引用`);
process.exit(bad > 0 ? 1 : 0);
