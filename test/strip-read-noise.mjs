// test/strip-read-noise.mjs — 清掉 read 工具输出混进源码的噪音行
// 用后即删。
//
// 从 read 片段还原文件时，工具的行号提示与截断提示被一起写进了源码。
// 形态：
//   [1093 more lines in file. Use offset=380 to continue.]
//   [Showing lines 1-200 of 1293]
// 这些不是合法 JS，必须删。

import fs from "node:fs";
import path from "node:path";

const files = process.argv.slice(2);
const NOISE = [
  // 实际形态是 "[1093 more lines in file. Use offset=380 to continue.]"
  // 注意是 "in file" 不是 "in the file" —— 少一个 the 就整条失效
  /^\s*\[\d+ more lines? in (the )?file\. Use offset=\d+ to continue\.\]\s*$/i,
  /^\s*\[\d+ lines? truncated[^\]]*\]\s*$/i,
  /^\s*\[Showing \d+ of \d+ lines?[^\]]*\]\s*$/i
];

let total = 0;
for (const f of files) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  const kept = [];
  let removed = 0;
  for (const l of lines) {
    if (NOISE.some(re => re.test(l))) { removed++; continue; }
    kept.push(l);
  }
  if (removed > 0) {
    fs.writeFileSync(f, kept.join("\n"));
    total += removed;
    console.log(`  ${path.basename(f)}: 删 ${removed} 行噪音`);
  }
}
console.log(`\n共删 ${total} 行`);
