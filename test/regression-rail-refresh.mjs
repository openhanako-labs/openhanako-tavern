// test/regression-rail-refresh.mjs — 角色变更要同步刷左栏 rail（第 0 批追加）
//
// Bug（今天报的）：导入角色卡成功后，左侧栏角色列表不刷新——新卡要等切页
// 或重开才出现。
//
// 根因：commitImport() / saveCharacter() / deleteCharacter() 三个入口
// 都只调了 loadCharacters()（那只刷主区），没有叫左栏 rail 也刷。
// rail.js 里 `rail-refresh` 事件监听得好好的，nav-bus.askRailRefresh
// 也留着——就是没人调用。
//
// 修法：新增一个 helper `refreshCharacters()`，一次改动两处一起刷。
// 三个入口都改用它。
//
// 反证：
//   · 把 helper 里的 askRailRefresh 删掉 → ① 直接红
//   · 把 import 的 askRailRefresh 删掉 → ② 直接红
//   · 三个入口中任一处改回 loadCharacters() → ③ 或 ④ 直接红
//   · 从 helper 里去掉 await loadCharacters → ① 断言 loadCharacters 会红

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHARS = path.join(ROOT, "ui", "assets", "modules", "characters.js");
const NAVBUS = path.join(ROOT, "ui", "assets", "modules", "nav-bus.js");

const charsSrc = fs.readFileSync(CHARS, "utf8");
const navSrc = fs.readFileSync(NAVBUS, "utf8");

let pass = 0;
const failed = [];
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed.push(name);
    console.error(`  ❌ ${name}\n     ${e?.message || e}`);
  }
}

function sliceFunction(src, name) {
  const re = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const start = src.search(re);
  if (start === -1) return null;
  // 从函数体第一个 `{` 开始，按花括号配对找结尾
  let open = src.indexOf("{", start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

// ── ① helper 存在，且同时调两个刷新通道 ──
ok("① refreshCharacters helper 存在，且调用 loadCharacters + askRailRefresh", () => {
  const body = sliceFunction(charsSrc, "refreshCharacters");
  assert.ok(body, "应该能定位到 refreshCharacters 函数");
  assert.match(body, /\bloadCharacters\s*\(/, "该调 loadCharacters");
  assert.match(body, /\baskRailRefresh\s*\(/, "该调 askRailRefresh");
  assert.match(body, /await\s+loadCharacters\s*\(/, "loadCharacters 应 await（等它刷完再叫 rail）");
});

// ── ② 从 nav-bus 正确 import askRailRefresh ──
ok("② characters.js 从 nav-bus.js import askRailRefresh", () => {
  assert.match(charsSrc, /from\s+["']\.\/nav-bus\.js["']/, "应从 ./nav-bus.js 导入");
  assert.match(charsSrc, /import\s*\{[^}]*\baskRailRefresh\b[^}]*\}\s*from\s+["']\.\/nav-bus\.js["']/);
});

// ── ③ nav-bus.js 的 askRailRefresh 走的是 rail-refresh 事件 ──
ok("③ nav-bus.askRailRefresh 走的是 rail-refresh（与 rail.js 监听的 key 匹配）", () => {
  assert.match(navSrc, /askRailRefresh/, "nav-bus.js 里要有 askRailRefresh");
  assert.match(navSrc, /t:\s*["']rail-refresh["']/, "该发 t: 'rail-refresh'");
});

// ── ④ 三个入口都调用 refreshCharacters ──
ok("④ saveCharacter / deleteCharacter / commitImport 都调用 refreshCharacters", () => {
  for (const name of ["saveCharacter", "deleteCharacter", "commitImport"]) {
    const body = sliceFunction(charsSrc, name);
    assert.ok(body, `应能找到 ${name}`);
    assert.match(
      body,
      /\brefreshCharacters\s*\(/,
      `${name} 里应有 refreshCharacters()`
    );
    // 这三个函数里不该再单独调 loadCharacters（那等于忘了叫 rail）
    // helper 内部会调，这里不再直接调
    assert.equal(
      /\bloadCharacters\s*\(/.test(body),
      false,
      `${name} 里不该直接调 loadCharacters（用 refreshCharacters 替代）`
    );
  }
});

// ── ⑤ loadCharacters 仍然导出（其他模块可能引用） ──
ok("⑤ loadCharacters 仍被导出，兼容外部调用方", () => {
  assert.match(charsSrc, /export\s+async\s+function\s+loadCharacters/);
});

console.log("");
if (failed.length) {
  console.error(`❌ 左栏刷新回归：${pass} 过 / ${failed.length} 败`);
  process.exit(1);
}
console.log(`✅ 左栏刷新回归：${pass} 过 / 0 败`);
