// test/lib/load-probe.mjs —— 把每个服务端模块**真 import 一遍**
//
// 为什么不能只靠 node --check
// ---------------------------
// 2026-09-25：lib/embed/tool.js 里我把两个**半角引号**写进了中文字符串，
// 于是 `没授权` 掉进代码位置变成标识符。`node --check` 对它报了 OK ✗，
// 宿主加载时报 "Unexpected identifier '没授权'"，用户看到的是"安装未完成"。
// 教训：**`node --check` 对 ESM 文件不可靠，真 import 才是判据。**
//
// 这个探针只做一件事：对每个文件 await import()，把结果分三类：
//   OK      真加载成功
//   SYNTAX  语法/解析错（**必须修**——宿主也加载不了）
//   ENV     能解析，但缺运行环境（比如 index.js 要 sdk）——不算错
//
// 分类的意义：把"我的代码坏了"和"这里没有宿主"分开。
// 前者要红，后者不该红——不然这个检查会很快被人无视。

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const APP = path.resolve(import.meta.dirname, "..", "..");
const SKIP_DIRS = new Set([".git", "node_modules", "_recovery", "sdk", "ui", "test", "tools", "docs"]);

function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(p);
    } else if (e.name.endsWith(".js")) {
      yield p;
    }
  }
}

const targets = [...walk(path.join(APP, "lib"))];
const entry = path.join(APP, "index.js");
if (fs.existsSync(entry)) targets.push(entry);

for (const abs of targets) {
  const rel = path.relative(APP, abs).replace(/\\/g, "/");
  try {
    await import(pathToFileURL(abs).href);
    console.log(`OK\t${rel}`);
  } catch (e) {
    const msg = String(e?.message || e).split("\n")[0];
    // SyntaxError 一定是代码坏了；别的（缺 sdk、缺全局）都归 ENV。
    const kind = e instanceof SyntaxError ? "SYNTAX" : "ENV";
    console.log(`${kind}\t${rel}\t${msg}`);
  }
}
