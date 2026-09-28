// test/regression-avatar-url.mjs — 界面上不能再出现裸 <img src> 指向 App 路由
//
// 这个雷踩过一次（真机日志原话）：<img> 不会自己带鉴权，请求 URL 里没有
// /_surface/<票据>/ 那一段，宿主直接 403。card 页改成了 avatar.json + 自己
// 拼 Blob 之后，rail 页（不同 iframe）还停在老写法——同一 App 两处 UI，
// 同一个错误形状。
//
// 反证：把 rail.js 或 core.js 里的某个 <img> 改回拿裸 App URL，
// 本文件必须变红。
//
// 覆盖两半：
//   1. rail.js 里没有 `hana.api.url` —— 那条路只有裸 fetch 能用，<img> 不能用。
//   2. 任何 ui/**.js|html 里的 <img src="...">，模板/裸值不能指向 App 路由：
//      - 不含 apiUrl(...) / hana.api.url(...)（那种写法就是拿裸 URL 当 src）
//      - 不含 "/api/apps/"（那种是硬编码的绝对路由）
//   blob: 与 data: URL 是正门，不受检（它们是浏览器自己认的）。

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const ROOT = path.resolve(import.meta.dirname, "..");
const UI = path.join(ROOT, "ui");

function stripLineComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(p);
    } else if (/\.(js|html)$/.test(e.name)) {
      yield p;
    }
  }
}

function read(p) {
  return fs.readFileSync(p, "utf8");
}

function listBadImgSrc() {
  const bad = [];
  for (const p of walk(UI)) {
    const src = stripLineComments(read(p));
    const rel = path.relative(ROOT, p).replace(/\\/g, "/");

    // 只关心真正被 DOM 渲染的 <img src="..."> 或 src=`...`。
    // 匹配 <img ... src="..." / src='...' / src=`...`
    for (const m of src.matchAll(/<img\b[^>\n]*\bsrc\s*=\s*(['"`])([^'"`]*)\1/gi)) {
      const value = m[2];
      if (!value) continue;
      if (/^blob:/i.test(value) || /^data:/i.test(value)) continue;
      // 硬编码绝对路由：一眼就能看出来，直接算坏。
      if (/\/api\/apps\//.test(value)) {
        bad.push({ file: rel, line: lineOf(src, m.index), value, reason: "src 指向 /api/apps/" });
        continue;
      }
      // 模板变量：值里出现 apiUrl(...) 或 hana.api.url(...)
      if (/apiUrl\s*\(/.test(value)) {
        bad.push({ file: rel, line: lineOf(src, m.index), value, reason: "src 用了 apiUrl()（不带鉴权）" });
      } else if (/hana\.api\.url\s*\(/.test(value)) {
        bad.push({ file: rel, line: lineOf(src, m.index), value, reason: "src 用了 hana.api.url()（<img> 不会带鉴权）" });
      }
    }
  }
  return bad;
}

function lineOf(text, idx) {
  return text.slice(0, idx).split("\n").length;
}

// ── 断言 ──
let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { console.error(`  ❌ ${name}\n     ${e?.message || e}`); process.exitCode = 1; }
}

ok("① rail.js 里不再出现 hana.api.url（<img> 不走那条路）", () => {
  const src = stripLineComments(read(path.join(UI, "assets", "rail.js")));
  assert.equal(/hana\.api\.url/.test(src), false, "rail.js 里有 hana.api.url，说明 <img> 还在拿裸 URL");
});

ok("② 全 UI 里没有 <img src> 指向 App 路由（硬编码或 apiUrl/hana.api.url 模板）", () => {
  const bad = listBadImgSrc();
  if (bad.length) {
    const lines = bad.map((b) => `    ${b.file}:${b.line}  ${b.reason}  →  src="${b.value.slice(0, 80)}"`);
    assert.fail("发现了 " + bad.length + " 处裸 <img src>：\n" + lines.join("\n"));
  }
});

ok("③ card 页 avatar 已经走 JSON 通道（core.js 的 apiAvatarBlobUrl 存在并读 avatar.json）", () => {
  const core = read(path.join(UI, "assets", "modules", "core.js"));
  assert.match(core, /apiAvatarBlobUrl/);
  assert.match(core, /avatar\.json/);
});

ok("④ 看图浮层已经接上（openImageViewer + bindAvatarZoom 都在 core.js 里）", () => {
  const core = read(path.join(UI, "assets", "modules", "core.js"));
  assert.match(core, /openImageViewer/);
  assert.match(core, /bindAvatarZoom/);
});

ok("⑤ 看图浮层绑到了角色头像上（characters.js 里调了 bindAvatarZoom）", () => {
  const src = read(path.join(UI, "assets", "modules", "characters.js"));
  assert.match(src, /bindAvatarZoom/);
});

ok("⑥ rail 头像走了 avatar.json + Blob（与 card 页同一方向）", () => {
  const src = read(path.join(UI, "assets", "rail.js"));
  assert.match(src, /avatar\.json/);
  assert.match(src, /URL\.createObjectURL/);
});

ok("⑦ 看图浮层的 #image-viewer 样式挂在 characters.css（不写样式就是全宽裸图）", () => {
  const css = read(path.join(UI, "assets", "characters.css"));
  assert.match(css, /\.image-viewer\s*\{/);
  assert.match(css, /\.iv-frame\s+img/);
});

ok("⑧ rail 缩略图尺寸是 20×20（计划 0.2 定的数），且首字母占位 .ph 也在同一规格里", () => {
  const css = read(path.join(UI, "rail.html"));
  const block = /(?:\.item\s*)?img\.ava[^{}]*\{[^}]*\}/.exec(css)?.[0] || "";
  assert.match(block, /width\s*:\s*20px/, "缺 width:20px");
  assert.match(block, /height\s*:\s*20px/, "缺 height:20px");
  // 首字母占位跟头像同一尺寸，不换图时行头不跳
  const phBlock = /\.item\s*\.ph[^{}]*\{[^}]*\}/.exec(css)?.[0] || "";
  assert.ok(phBlock, "缺 .item .ph 块（首字母占位应该有尺寸）");
});

console.log("");
console.log(`✅ 头像 URL 反证：${pass} 过 / 0 败`);
