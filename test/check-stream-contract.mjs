// test/check-stream-contract.mjs — 流式事件名的跨侧契约
//
// 为什么需要它：这个 App 里最贵的一个 bug 就是一个词之差——
// 后端推 `{type:"delta", content}`，前端只认 `{type:"chunk"}`。
// 结果是**助手那条回复永远渲染不出来**：气泡从没被建，最后那条 done
// 又只在「气泡已存在」时才更新它。没有报错、没有 toast、没有异常，
// 数据全到了，屏幕上什么都没有。
//
// 45 个测试一个都没拦住它：路由测试只问「handler 抛没抛」，
// UI 测试只问「函数在不在」。**两侧各自都对，接缝没人看。**
//
// 所以这里只做一件事：把两侧的事件名摆在一起对。
// 静态就能查，而且它抓的正是那种「看不见的错」。

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");

// ── 后端推了哪些 type ──
const backend = read("lib/conversations/routes.js");
const emitted = [...backend.matchAll(/send\(\s*\{\s*type:\s*"([a-z-]+)"/g)].map(m => m[1]);
assert.ok(emitted.length >= 4, `只从后端里扫出 ${emitted.length} 种事件——解析器大概坏了`);
const emittedTypes = [...new Set(emitted)].sort();

// ── 前端接了哪些 type ──
const frontend = read("ui/assets/modules/chat.js");
const handled = new Set(
  [...frontend.matchAll(/data\.type\s*===\s*"([a-z-]+)"/g)].map(m => m[1])
);

const unhandled = emittedTypes.filter(t => !handled.has(t));

/**
 * 故意不接的：**写了理由才算数**，不写就是「没决定」。
 *
 * 这一层不能省：不加的话，下次多推一种事件时，要么报一个假错，
 * 要么为了让报错消失而随手添个空分支——两种都让判据失去意义。
 */
const IGNORED = new Map([
  ["reasoning", "思考增量只在流里推、不入气泡；落盘后由消息自己的 reasoning 段渲染，重载就能看见。要让它实时显示是一个新功能（一条「正在想…」的折叠条），不是修 bug 的顺带活。"]
]);

const missing = unhandled.filter(t => !IGNORED.has(t));

console.log("\n=== 流式事件名的跨侧契约 ===\n");
console.log(`  后端推：${emittedTypes.join(" / ")}`);
console.log(`  前端接：${[...handled].sort().join(" / ")}`);
if (unhandled.length) {
  for (const t of unhandled) {
    console.log(`  ${IGNORED.has(t) ? "○" : "❌"} ${t}：${IGNORED.get(t) || "前端没人接"}`);
  }
}

if (missing.length) {
  console.log(`\n  ❌ 前端没人接：${missing.join(", ")}`);
  console.log("     这类错不会报错：那一帧被 JSON.parse 之后安静地丢掉，");
  console.log("     屏幕上少的是内容，不是错误。");
}

assert.deepStrictEqual(
  missing, [],
  `后端推了但前端没接（也没写明为什么）的事件类型：${missing.join(", ")}——` +
  `先确认是「该接没接」（改前端）还是「推错了」（改后端），别两边各改一半；` +
  `如果确认故意不接，写进 IGNORED 并附一句理由`
);

// 反过来不报错，只提示：前端可能留着兼容旧事件名的分支（如 chunk）。
const extra = [...handled].filter(t => !emittedTypes.includes(t));
if (extra.length) console.log(`\n  （前端还认这几个后端不推的名字，当兼容分支看：${extra.join(", ")}）`);

console.log("\n通过 ✅");
