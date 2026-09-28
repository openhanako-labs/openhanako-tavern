// test/regression-director-drawer.mjs — 公式抽屉：编辑在弹窗、开关在行首
//
// 为什么要测这个：
//   基准 5 的样张（eleckoi-dir-drawer）把公式编辑器从 344px 的抽屉
//   搬进了全宽弹窗——理由是**字段是嵌套的**（state 是对象、rules 是数组），
//   vanilla-jsoneditor 的树模式每层缩进吃掉 20px，三层就折成一行一个字。
//   实测：抽屉里 46vh ≈ 280px，弹窗里 798px。
//
//   这类"搬家"最容易出的问题是**搬了一半**：
//   编辑器搬走了，但事件还绑在旧容器上；或者抽屉里留着一个空的
//   #director-editor 占位。所以这里盯三件事：
//     ① 编辑器宿主在弹窗里，且抽屉里不再有旧容器
//     ② 开关是行首的 .dir-sw（role=switch），不是原来的「启用/停用」文字按钮
//     ③ enabled 在引擎里真的被读（这是开关敢做出来的唯一理由）

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "ui", "characters.html"), "utf8");
const JS = fs.readFileSync(path.join(ROOT, "ui", "assets", "modules", "director.js"), "utf8");
const MAIN = fs.readFileSync(path.join(ROOT, "ui", "assets", "modules", "main.js"), "utf8");
const PIPELINE = fs.readFileSync(path.join(ROOT, "lib", "conversations", "pipeline.js"), "utf8");
const MODEL = fs.readFileSync(path.join(ROOT, "lib", "director", "model.js"), "utf8");

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "\n      " + (e?.message ?? e)); }
}

console.log("\n── ① 编辑器在弹窗里（基准 5 · 样张「丙」）──");

ok("弹窗 #director-editor-modal 存在", () => {
  assert(/id="director-editor-modal"/.test(HTML), "找不到编辑器弹窗");
});

ok("编辑器宿主 #dir-editor-host 在弹窗内", () => {
  const modalStart = HTML.indexOf('id="director-editor-modal"');
  const hostAt = HTML.indexOf('id="dir-editor-host"');
  assert(modalStart > -1 && hostAt > -1, "弹窗或宿主不存在");
  assert(hostAt > modalStart, "宿主不在弹窗之后——可能还留在抽屉里");
});

ok("抽屉里不再有旧的 #director-editor 容器", () => {
  // 抽屉的 body 里不该再出现编辑器占位
  const drawerStart = HTML.indexOf('id="drawer-director"');
  const drawerEnd = HTML.indexOf('id="drawer-variables"');
  const drawerBlock = HTML.slice(drawerStart, drawerEnd);
  assert(!/id="director-editor"/.test(drawerBlock),
    "抽屉里还有 #director-editor——搬家搬了一半");
});

ok("弹窗用了全宽（modal-fullscreen）", () => {
  const modalStart = HTML.indexOf('id="director-editor-modal"');
  const block = HTML.slice(modalStart, modalStart + 400);
  assert(/modal-fullscreen/.test(block), "弹窗没用 modal-fullscreen，JSON 区撑不开");
});

console.log("\n── ② 开关在行首，不是文字按钮 ──");

ok("列表行渲染 .dir-sw（role=switch）", () => {
  assert(/class="dir-sw"/.test(JS), "找不到 .dir-sw");
  assert(/role="switch"/.test(JS), "开关缺 role=switch（读屏认不出）");
  assert(/aria-checked=/.test(JS), "开关缺 aria-checked（状态读不出来）");
});

ok("开关带 data-act=toggle，能被事件委托接住", () => {
  const m = JS.match(/class="dir-sw"[^>]*data-act="([^"]+)"/);
  assert(m, "开关上没有 data-act");
  assert.equal(m[1], "toggle");
});

ok("不再有「启用/停用」文字按钮", () => {
  assert(!/>\$\{d\.enabled === false \? "启用" : "停用"\}</.test(JS),
    "旧的「启用/停用」按钮还在——开关和它重复了");
});

ok("停用态有 .off 类（划线与压淡）", () => {
  assert(/dir-item\$\{on \? " on" : ""\}\$\{off \? " off" : ""\}/.test(JS)
      || /dir-item[^`]*\$\{off \? " off"/.test(JS),
    "行上没有 .off 状态类");
});

console.log("\n── ③ enabled 真的进引擎（开关敢做出来的理由）──");

ok("pipeline 里读 enabled 并短路", () => {
  assert(/entity\.enabled === false/.test(PIPELINE),
    "引擎没读 enabled——那这个开关就是摆设");
});

ok("model 里 enabled 有默认值与归一", () => {
  assert(/enabled:\s*overrides\.enabled !== false/.test(MODEL),
    "model 没有把 enabled 归一成布尔");
});

console.log("\n── ④ 弹窗按钮绑在 main.js（静态元素只绑一次）──");

for (const id of ["dir-save", "dir-cancel", "director-editor-close", "dir-del", "dir-sim"]) {
  ok(`#${id} 有绑定`, () => {
    assert(new RegExp(`getElementById\\("${id}"\\)\\?\\.addEventListener`).test(MAIN),
      `main.js 里没绑 #${id}`);
  });
}

ok("弹窗按钮不是每次重绘重建（不再绑在 renderEditor 里）", () => {
  const renderEditor = JS.slice(JS.indexOf("function renderEditor()"), JS.indexOf("function mountEditor"));
  assert(!/addEventListener\("click", saveDirector\)/.test(renderEditor),
    "renderEditor 里还在绑保存——元素现在在 HTML 里，绑多次会叠监听器");
});

console.log("\n" + "=".repeat(50));
console.log(`${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
