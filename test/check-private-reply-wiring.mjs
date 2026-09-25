// test/check-private-reply-wiring.mjs
//
// 「N 处一模一样的落盘」是脚本改的 → 得有条护栏盯着别漏一个。
// 这正是脚本最容易犯的错：数量核对了，改完却有一处形状没跟上。
//
// 判据：routes.js 里每一处 MessageRole.ASSISTANT 的 addMessage，
// 都必须包着 privateOf()（本行或紧邻上一行出现即可——脚本就是那么写的）。
//
// ⚠️ 已知盲区（显式登记，不装看不见）：判据是**逐行**的。
// 如果哪天把一次 addMessage 写成多行调用，行里就找不到 MessageRole.ASSISTANT，
// 这一处会被漏掉。改多行时要顺手把这个检查器改成跨行匹配。
//
// 找不到目标要**大声说**：一个"0 处，通过"的检查器比没有还坏。
import fs from "node:fs";
import path from "node:path";

// 可选参数：指一个别的文件来跑（反证用）。不传就看 routes.js。
const url = process.argv[2]
  ? path.resolve(process.argv[2])
  : new URL("../lib/conversations/routes.js", import.meta.url);
const src = fs.readFileSync(url, "utf8");
const lines = src.split(/\r?\n/);

let total = 0;
const missing = [];

lines.forEach((l, i) => {
  if (!/addMessage\(.*MessageRole\.ASSISTANT/.test(l)) return;
  total++;
  const prev = lines[i - 1] || "";
  if (l.includes("privateOf(") || prev.includes("privateOf(")) return;
  missing.push(i + 1);
});

if (total === 0) {
  console.log("❌ 一处助手落盘都没扫到 —— 检查器认错了目标，不算通过");
  process.exit(1);
}
if (missing.length > 0) {
  console.log(`❌ 有 ${missing.length} 处助手落盘没接 privateOf（行 ${missing.join(", ")}）——`);
  console.log("   角色写 [[私语:某某]] 会被当成正文存下来（标记出现在气泡里，而且不私密）");
  process.exit(1);
}
console.log(`✅ ${total} 处助手落盘全部接了私语标记解析`);
