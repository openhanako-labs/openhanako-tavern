// test/check-preset-zone-keys.mjs — 预设编辑器分区键一致性静态检查
//
// 背景（2026-10-02）：renderZone 曾把显示键 "sys"/"chat" 写进 data-zone，而块的
// position 值空间是 "system"/"in_chat"——addBlock/moveBlockInZone 拿显示键跟数据
// 字段比对，永远失配：「＋ 加一个块」推进数组却在两个分区的过滤器里都消失（界面
// 毫无反应，保存时才被 validatePreset 拒绝），「上移/下移」静默返回。
// 2d06a05（界面重设计）引入。修复：data-zone 一律写 position 真值，样式类另走 cls。
//
// 这个检查锁两件事：
//   1. renderZone 的第二参（zone）在调用处只会是 position 真值；
//   2. bindBlockEvents 的三个 addEventListener 都经 AbortController 的 signal 挂载——
//      #pe-blocks 是持久容器，不带 signal 就会在每轮渲染后堆叠监听，
//      toggle/expand 出现「点一下等于点 N 下」的奇偶失灵。

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const src = fs.readFileSync(path.join(root, "ui/assets/modules/presets.js"), "utf8");

let errors = 0;
const fail = (msg) => { console.log(`  ❌ ${msg}`); errors++; };
const ok = (msg) => console.log(`  ✅ ${msg}`);

// ── 1. renderZone 调用处的 zone 键 ──
const callSites = [...src.matchAll(/renderZone\(\s*\w+\s*,\s*["']([^"']+)["']/g)].map(m => m[1]);
const badKeys = callSites.filter(k => k !== "system" && k !== "in_chat");
if (callSites.length >= 2 && badKeys.length === 0) {
  ok(`renderZone 调用 ${callSites.length} 处，zone 键全部是 position 真值（${callSites.join(", ")}）`);
} else {
  fail(`renderZone 的 zone 键失配：${JSON.stringify(callSites)}——只允许 "system"/"in_chat"`);
}

// ── 2. data-zone 由 zone 变量渲染，不允许写死显示键 ──
if (/\bdata-zone="\$\{zone\}"/.test(src) && !/data-zone="(sys|chat)"/.test(src)) {
  ok("data-zone 由 ${zone} 渲染，没有写死的显示键");
} else {
  fail('data-zone 出现了写死的 "sys"/"chat"，或没有用 ${zone} 渲染');
}

// ── 3. addBlock 的 position 直接取 zone（zone 即真值，两套值空间不分叉）──
if (/position:\s*zone,/.test(src)) {
  ok("addBlock 的 position 直接取 zone 变量");
} else {
  fail("addBlock 没有把 zone 直接写进 position——值空间会再次分叉");
}

// ── 4. 监听器经 AbortController 管理 ──
const acOk = /wrap\._peAC\?\.abort\(\)/.test(src) && /new AbortController\(\)/.test(src);
const withSignal = [...src.matchAll(/\{\s*signal\s*\}\)/g)].length;
if (acOk && withSignal >= 3) {
  ok(`监听器经 AbortController 管理（${withSignal} 处挂点带 { signal }）`);
} else {
  fail(`bindBlockEvents 的监听缺少 signal 管理：AbortController=${acOk}，带 signal 的挂点=${withSignal}/3`);
}

console.log(errors === 0 ? "\n预设分区键检查通过\n" : `\n预设分区键检查失败 ${errors} 项\n`);
process.exit(errors > 0 ? 1 : 0);
