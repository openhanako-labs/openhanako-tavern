// test/check-module-load.mjs —— 服务端模块必须能被真 import
//
// 治的是 2026-09-25 那个病：lib/embed/tool.js 里一个半角引号，
// `node --check` 报 OK、宿主报 "Unexpected identifier"，用户看到"安装未完成"。
//
// 做法：起一个子进程跑 test/lib/load-probe.mjs（真 import 每个文件），
// 把结果分成 OK / SYNTAX / ENV：
//   · SYNTAX → 红（宿主也加载不了，而且只在用户点安装时才会发现）
//   · ENV    → 只提示（那些模块本来就要宿主在才活得起来）
//
// 为什么用子进程：import 会执行模块副作用，坏文件可能把进程带走；
// 而且一个文件炸掉不该让整轮检查断在那里。

import { spawnSync } from "node:child_process";
import path from "node:path";

const APP = path.resolve(import.meta.dirname, "..");
const probe = path.join(APP, "test", "lib", "load-probe.mjs");

const r = spawnSync(process.execPath, [probe], { encoding: "utf8", cwd: APP });
const out = `${r.stdout || ""}${r.stderr || ""}`.replace(/^\uFEFF/, "");

const rows = out.split(/\r?\n/).filter((l) => l.includes("\t")).map((l) => l.split("\t"));
const ok = rows.filter((r) => r[0] === "OK");
const syntax = rows.filter((r) => r[0] === "SYNTAX");
const env = rows.filter((r) => r[0] === "ENV");

console.log(`\n=== 模块真加载（${rows.length} 个文件）===\n`);
console.log(`  ✅ 加载成功 ${ok.length}`);

if (env.length) {
  console.log(`  ⚠️  缺宿主环境 ${env.length}（不算错，列出来免得以为漏了）`);
  for (const [, rel, msg] of env.slice(0, 6)) console.log(`       ${rel}  — ${msg.slice(0, 70)}`);
}

if (syntax.length) {
  console.log(`\n  ❌ 解析/语法失败 ${syntax.length} —— 宿主也会加载不了：`);
  for (const [, rel, msg] of syntax) console.log(`       ${rel}\n         ${msg}`);
  console.log("");
  process.exit(1);
}

if (rows.length === 0) {
  console.log("  ❌ 探针没有输出——检查本身没跑起来（别把这种当绿）");
  process.exit(1);
}

console.log("\n✅ 全部能加载\n");
