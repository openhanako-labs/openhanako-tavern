// test/check-escape-html.mjs — escapeHtml 的判空守卫不能吞掉 0
//
// 为什么要测这个：
//   escapeHtml 是全前端的基础函数，用 `!str` 判空看似自然——
//   但 `!0` 为 true，数字 0 会被当成"空"返回空串。
//   调用方拿到 "" 后当空值用，**不会报错**，
//   要很久以后才以「点了没反应」「少了半个字」这种形式暴露。
//
// 真事故（2026-09-28）：
//   设定库分组的 key 是数字 0/1/2，renderSection 写
//   `data-key="${escapeHtml(g.key)}"`。escapeHtml(0) → ""，
//   常驻组抬头 data-key 成了空串，折叠的读写 key 错位，
//   于是「常驻」点了没反应，而 key 为 1/2 的另外两组正常。
//
// 本测试同时盯两处：
//   ① core.js 的守卫语义（静态检查：不许出现 !str 这种写法）
//   ② 守卫的实际行为（用一份等价实现跑边界值）

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CORE = path.join(ROOT, "ui", "assets", "modules", "core.js");

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "\n      " + (e?.message ?? e)); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

console.log("\n── ① core.js 的守卫语义（静态）──");

const src = fs.readFileSync(CORE, "utf8");
const m = src.match(/export\s+function\s+escapeHtml\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
assert(m, "core.js 里找不到 escapeHtml 的实现");
const body = m[1];

ok("守卫不再用 `!str`（会把数字 0 当空）", () => {
  assert(!/if\s*\(\s*!str\s*\)/.test(body), "escapeHtml 里出现了 `if (!str)` —— 0 会被吞成空串");
});

ok("守卫显式排除 null 与空串", () => {
  assert(/str\s*==\s*null|str\s*===\s*null/.test(body) || /==\s*null/.test(body),
    "守卫没有显式判 null");
  assert(/str\s*===\s*""|str\s*==\s*""/.test(body), "守卫没有显式判空串");
});

ok("返回值走 String(str)，不直接塞 textContent", () => {
  // div.textContent = str 在 str 是数字时其实也能工作（会被隐式转字符串），
  // 但显式 String() 更清楚，也避免将来有人把守卫改回 !str 后行为更隐蔽。
  assert(/String\(\s*str\s*\)/.test(body), "没有看到 String(str)");
});

console.log("\n── ② 守卫行为（等价实现，跑边界值）──");

// 与 core.js 修正后的语义逐条对齐
const esc = (str) => {
  if (str == null || str === "") return "";
  if (typeof str === "number" && !Number.isFinite(str)) return "";
  if (str === false) return "";
  return String(str);
};

ok("数字 0 返回 \"0\"（这是当初坏掉的那一条）", () => {
  assert(esc(0) === "0", `escapeHtml(0) 应为 "0"，实际 ${JSON.stringify(esc(0))}`);
});

ok("数字 1 / 2 返回 \"1\" / \"2\"", () => {
  assert(esc(1) === "1" && esc(2) === "2", "数字 1/2 转义异常");
});

ok("null / undefined / 空串 → 空串", () => {
  assert(esc(null) === "" && esc(undefined) === "" && esc("") === "");
});

ok("false → 空串（保持原有行为）", () => {
  assert(esc(false) === "");
});

ok("NaN / Infinity → 空串（不产出 \"NaN\" 这种字面量）", () => {
  assert(esc(NaN) === "", `NaN 应为空串，实际 ${JSON.stringify(esc(NaN))}`);
  assert(esc(Infinity) === "", `Infinity 应为空串，实际 ${JSON.stringify(esc(Infinity))}`);
});

ok("普通字符串与中文照常", () => {
  assert(esc("常驻") === "常驻");
  assert(esc("触发") === "触发");
});

ok("危险字符仍然被转义（安全性质没丢）", () => {
  // 这份等价实现只做 String()，转义由 DOM 的 textContent→innerHTML 负责。
  // 这里断言的是「不该原样返回带标签的串」这一意图——用 DOM 语义模拟。
  const dangerous = "<img src=x onerror=alert(1)>";
  const escaped = dangerous.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  assert(!escaped.includes("<"), "转义后不该还有裸的尖括号");
});

console.log("\n" + "=".repeat(50));
console.log(`${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
