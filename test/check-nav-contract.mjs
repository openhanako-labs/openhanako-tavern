// test/check-nav-contract.mjs
//
// 跨侧契约护栏：左栏（rail）是独立 iframe，通过 localStorage 总线给主视图发导航意图。
// 发送方和接收方在两个文件里，谁也看不见谁——匹配不上的消息会被分支链末尾**无声吞掉**。
//
// 这个坑真的发生过：
//   rail.html 的「+ 角色」按钮 → nav({ t: "new-char" })      （不带 id）
//   shell.js 的接收分支        → msg.t === "new-char" && msg.id  （带 id 才接）
//   ⇒ 按钮点了没反应，控制台也一声不吭。
//
// 判据：rail 侧发出去的每个 t，主侧必须有处理它的分支。
//
// 已知盲区（显式登记，别假装它全能）：
//   · 只认字面量 t: "x" 与 msg.t === "x"；拼出来/间接传的名字抓不到
//   · 只扫下面 SEND_FILES / RECV_FILES 两个清单，新发送方要手动加进来
//   · 不做"分支里到底做没做事"的判断（空分支也算接住了）
//
// 用法：
//   node test/check-nav-contract.mjs            # 查仓库
//   node test/check-nav-contract.mjs <目录>      # 查副本（用来做反证：喂个坏样本，必须红）
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(here, "..");

const SEND_FILES = ["ui/assets/rail.js", "ui/rail.html"];
const RECV_FILES = ["ui/assets/modules/shell.js"];

const read = (p) => {
  const abs = path.join(root, p);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
};

const SEND_RE = /nav\(\s*\{\s*t:\s*["']([^"']+)["']/g;
const RECV_RE = /msg\.t\s*===\s*["']([^"']+)["']/g;

const sends = new Map(); // t -> [file:line]
const recvs = new Map();

for (const f of SEND_FILES) {
  const src = read(f);
  if (src == null) {
    console.log(`❌ 发送方文件缺失: ${f}`);
    process.exit(1);
  }
  for (const m of src.matchAll(SEND_RE)) {
    if (!sends.has(m[1])) sends.set(m[1], []);
    sends.get(m[1]).push(f);
  }
}
for (const f of RECV_FILES) {
  const src = read(f);
  if (src == null) {
    console.log(`❌ 接收方文件缺失: ${f}`);
    process.exit(1);
  }
  for (const m of src.matchAll(RECV_RE)) {
    if (!recvs.has(m[1])) recvs.set(m[1], []);
    recvs.get(m[1]).push(f);
  }
}

// 反证会用到：一个都没扫到 = 判据失效，不能算绿
if (sends.size === 0 || recvs.size === 0) {
  console.log(`❌ 扫描结果为空（发出 ${sends.size} / 接住 ${recvs.size}）——判据失效，不能算绿`);
  process.exit(1);
}

let bad = 0;
console.log(`导航契约：rail 发出 ${sends.size} 种，主视图接住 ${recvs.size} 种`);
for (const [t, where] of [...sends].sort()) {
  const ok = recvs.has(t);
  console.log(`  ${ok ? "✓" : "❌"} ${t.padEnd(16)} 发出于 ${where.join(", ")}`);
  if (!ok) bad++;
}
for (const t of [...recvs.keys()].sort()) {
  if (!sends.has(t)) console.log(`  · ${t.padEnd(16)} 只有接收方（可能是历史遗留或内部调用）`);
}

if (bad) {
  console.log(`\n❌ ${bad} 个导航意图发出去没人接——在界面上表现为"点了没反应，且不报错"。`);
  process.exit(1);
}
console.log("\n✓ 导航契约完整");
