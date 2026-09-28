// test/regression-gallery-drawer.mjs — 图库抽屉的接线
//
// 为什么要测这个：
//   抽屉加完不会报错，只会「点了没反应」「有框没内容」「图是裂的」。
//   而这三类的共同点是**每一处单独看都像做完了**：
//     · dom.js 少一个 key      → openDrawer 静默 return（dom.js 文件头自己写了这个坑）
//     · shell.js 少一个分支    → 抽屉开得了，但里面永远是骨架条
//     · CSS 少一条 gal- 规则   → JS 里类名齐全、样式零（2.7 的插图就是这么栽的）
//   所以这里把「入口 → 抽屉 → dom → shell → 模块 → CSS」整条链钉住。
//
// 与 check-css-wiring 的分工：那个检查器**扫不到 JS 模板字符串里生成的类名**
// （它的文件头点名了这是已知盲区）。所以 gal-* 这一类由本测试逐个对 CSS。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const HTML = read("ui/characters.html");
const CSS = read("ui/assets/characters.css");
const DOM = read("ui/assets/modules/dom.js");
const SHELL = read("ui/assets/modules/shell.js");
const MAIN = read("ui/assets/modules/main.js");
const CMD = read("ui/assets/modules/command.js");
const GAL = read("ui/assets/modules/gallery.js");
const GALQ = read("ui/assets/modules/gallery-query.js");

// CSS 里去注释再扫——注释里提到的类名不算有规则
const CSS_RULES = new Set();
for (const m of CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\.([a-zA-Z][\w-]*)/g)) {
  CSS_RULES.add(m[1]);
}

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "\n      " + (e?.message ?? e)); }
}

console.log("\n── ① 入口：⋯ 菜单里有「图库」──");

ok("app-more-menu 里有 data-drawer=\"gallery\" 的按钮", () => {
  const menuStart = HTML.indexOf('id="app-more-menu"');
  const menuEnd = HTML.indexOf('id="more-menu"', menuStart);
  const block = HTML.slice(menuStart, menuEnd > menuStart ? menuEnd : menuStart + 3000);
  assert(/data-drawer="gallery"/.test(block),
    "⋯ 菜单里没有图库入口——加了抽屉却没给路，等于没有");
});

ok("入口图标不是空的", () => {
  assert(/data-drawer="gallery"><span class="mi">[^<]+<\/span>图库/.test(HTML),
    "入口缺图标或缺文案");
});

console.log("\n── ② 抽屉结构符合基准 5（spec-drawer.md 一节）──");

const drawerBlock = (() => {
  const s = HTML.indexOf('id="drawer-gallery"');
  assert(s > -1, "找不到 #drawer-gallery");
  const e = HTML.indexOf('id="drawer-director"', s);
  // 去掉注释再断言：抽屉上方的说明注释里就写着「不要写『加载中…』」，
  // 不剥掉会自己踩自己（check-css-wiring 对 CSS 也是同样处理）。
  return HTML.slice(s, e > s ? e : s + 4000).replace(/<!--[\s\S]*?-->/g, "");
})();

ok("头 / filter / 计数 / body 四段齐全", () => {
  assert(/class="drawer-head"/.test(drawerBlock), "缺 .drawer-head");
  assert(/class="drawer-filter"/.test(drawerBlock), "缺 .drawer-filter");
  assert(/id="gallery-count" class="drawer-count"/.test(drawerBlock), "缺计数行");
  assert(/id="gallery-list" class="drawer-body"/.test(drawerBlock), "缺 .drawer-body");
});

ok("两个 select：范围（scope）+ 类型（kind）", () => {
  assert(/id="gallery-scope"/.test(drawerBlock), "缺范围选择");
  assert(/id="gallery-kind"/.test(drawerBlock), "缺类型选择");
  // 范围必须有两个值：本场 / 全部。这是「两级」的字面保证。
  const scopeSel = drawerBlock.slice(drawerBlock.indexOf('id="gallery-scope"'));
  const scopeOpts = scopeSel.slice(0, scopeSel.indexOf("</select>"));
  assert(/value="conv"/.test(scopeOpts), "范围缺「本场」");
  assert(/value="all"/.test(scopeOpts), "范围缺「全部」");
});

ok("初始容器是骨架格，不是「加载中…」", () => {
  // 基准 5 · 第四节：加载态用骨架条；「加载中…」会在真空态时骗用户一直等
  assert(/gal-skel/.test(drawerBlock), "初始容器没有骨架格");
  assert(!/加载中/.test(drawerBlock), "抽屉里还写着「加载中…」");
});

ok("没有工具条——按纪律这里一颗都凑不出来", () => {
  assert(!/class="drawer-toolbar"/.test(drawerBlock),
    "图库放出了工具条。基准 5 第二节：先问它有没有可能从来不需要被按");
});

ok("「再看更多」存在且默认隐藏（不足一页整行不显示）", () => {
  assert(/id="gallery-more"/.test(drawerBlock), "缺「再看更多」容器");
  assert(/id="gallery-more"[^>]*class="gal-more hidden"/.test(drawerBlock),
    "「再看更多」没有默认 hidden——一进去就显示一行没用的按钮");
});

ok("抽屉没有被嵌进另一个抽屉里", () => {
  // 上一级 div 必须是 drawer-settings 的闭合之后——嵌进去会连高度一起丢
  const settingsEnd = HTML.lastIndexOf("</div>", HTML.indexOf('id="drawer-gallery"'));
  const settingsStart = HTML.indexOf('id="drawer-settings"');
  assert(settingsEnd > settingsStart, "drawer-gallery 似乎还在 drawer-settings 内部");
});

console.log("\n── ③ dom.js 注册（少一个 key = 静默失效）──");

ok("DRAWERS 里有 gallery", () => {
  assert(/gallery:\s*document\.getElementById\("drawer-gallery"\)/.test(DOM),
    "dom.js 的 DRAWERS 没注册 gallery——openDrawer 会静默 return");
});

for (const [key, id] of [
  ["galleryListEl", "gallery-list"],
  ["galleryCountEl", "gallery-count"],
  ["galleryScopeEl", "gallery-scope"],
  ["galleryKindEl", "gallery-kind"],
  ["galleryMoreEl", "gallery-more"],
  ["galleryMoreBtn", "gallery-more-btn"]
]) {
  ok(`dom.${key} → #${id}`, () => {
    assert(new RegExp(`${key}:\\s*document\\.getElementById\\("${id}"\\)`).test(DOM),
      `dom.js 里没有 ${key}`);
    assert(new RegExp(`id="${id}"`).test(HTML), `HTML 里没有 #${id}`);
  });
}

console.log("\n── ④ shell.js 懒加载分支 ──");

ok("openDrawer 的 gallery 分支存在", () => {
  assert(/name === "gallery"/.test(SHELL), "shell.js 没有 gallery 分支——抽屉只会永远转骨架");
});

ok("分支里先 bind 再 load", () => {
  const i = SHELL.indexOf('name === "gallery"');
  const block = SHELL.slice(i, i + 260);
  assert(/bindGallery\(\)/.test(block) && /loadGallery\(\)/.test(block),
    "分支没同时调 bindGallery 与 loadGallery");
});

ok("openDrawer 的 JSDoc 里登记了 gallery", () => {
  assert(/@param \{[^}]*"gallery"[^}]*\} name/.test(SHELL),
    "JSDoc 的类型联合里没有 gallery——下一个人会以为它不存在");
});

console.log("\n── ⑤ 命令面板入口 ──");

ok("command.js 里有「图库」", () => {
  assert(/id:\s*"gallery"/.test(CMD), "命令面板缺图库入口");
  assert(/openDrawer\("gallery"\)/.test(CMD), "图库入口没有真的 openDrawer");
});

console.log("\n── ⑥ gallery.js 真的用契约，不是自己另写一套 ──");

for (const fn of ["buildGalleryQuery", "galleryEmptyState", "galleryCountText"]) {
  ok(`import 并调用 ${fn}`, () => {
    assert(new RegExp(`import\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from\\s*"\\./gallery-query\\.js"`).test(GAL),
      `gallery.js 没从 gallery-query.js import ${fn}`);
    assert(new RegExp(`\\b${fn}\\(`).test(GAL.replace(new RegExp(`import[^;]*${fn}[^;]*;`, "g"), "")),
      `import 了却没调用 ${fn}`);
  });
}

ok("默认看「本场」（ui.scope 初值）", () => {
  assert(/scope:\s*"conv"/.test(GAL),
    "默认不是「本场」——用户打开图库第一眼应该看到当前这一场的图");
});

ok("走 /media/index 查询，不自己扫目录", () => {
  assert(/apiFetch\(`media\/index\$\{q\}`\)/.test(GAL), "没走 /media/index");
});

console.log("\n── ⑦ CSS：gal-* 每个类都要有规则 ──");

// gallery.js 模板里 + HTML 里出现的 gal-* 类。
// 这一条顶的是 check-css-wiring 的已知盲区（它扫不到模板字符串里生成的类名）。
const galClasses = new Set();
for (const src of [GAL, HTML, CSS]) {
  for (const m of src.matchAll(/\bgal-([a-zA-Z][\w-]*)/g)) galClasses.add("gal-" + m[1]);
}
for (const c of galClasses) {
  ok(`.${c} 有 CSS 规则`, () => {
    assert(CSS_RULES.has(c), `CSS 里没有 .${c}——JS 里类名齐全、样式零`);
  });
}

ok("网格是两列（344px 抽屉的可行解）", () => {
  assert(/grid-template-columns:\s*1fr\s+1fr/.test(CSS), "网格不是两列");
});

ok("格子是正方形 + object-fit:cover（横竖图都不裁成一条）", () => {
  assert(/aspect-ratio:\s*1\s*\/\s*1/.test(CSS), "格子没锁正方形");
  assert(/object-fit:\s*cover/.test(CSS), "img 没做 cover");
});

ok("有 .gal-broken 样式（台账有、文件没了要看得出来）", () => {
  assert(/\.gal-cell\.gal-broken/.test(CSS), "没有文件丢失的可见样式");
});

console.log("\n── ⑧ 字节懒加载，不是一次全拉 ──");

ok("用 IntersectionObserver", () => {
  assert(/new IntersectionObserver/.test(GAL), "没有 IntersectionObserver");
});

ok("一次只渲染一页（PAGE）", () => {
  assert(/const PAGE\s*=\s*\d+/.test(GAL), "没有 PAGE 常量");
  assert(/slice\(ui\.shown,\s*ui\.shown\s*\+\s*PAGE\)/.test(GAL), "没有按 PAGE 切片");
});

ok("图片走 JSON 通道拿 base64，不用 <img src>", () => {
  assert(/apiFetch\(`media\/\$\{encodeURIComponent\(id\)\}`\)/.test(GAL),
    "没走 /media/:id 的 JSON 通道");
  assert(!/<img[^>]+src="\/media\//.test(GAL),
    "出现了裸 <img src=\"/media/...\">——真机里那条路 403");
});

ok("data URL 拼 base64", () => {
  assert(/data:\$\{[^}]*mime[^}]*\};base64,/.test(GAL), "没拼 base64 data URL");
});

console.log("\n── ⑨ 三态分开（基准 5 · 第四节）──");

ok("加载态是骨架格", () => {
  assert(/gal-skel/.test(GAL), "gallery.js 里没有骨架格");
});

ok("空态走公共 emptyHtml", () => {
  assert(/emptyHtml\(/.test(GAL), "没用公共空态");
});

ok("错误态走公共 errHtml，且说清是谁的错", () => {
  assert(/errHtml\(/.test(GAL), "没用公共错误态");
  assert(/图还在盘上/.test(GAL), "错误态没说清「数据没坏，只是这趟没读上来」");
});

ok("空态带 hasConv（没开会话是另一种空）", () => {
  assert(/hasConv:\s*!!currentConvId\(\)/.test(GAL),
    "没把「当前有没有对话」传给空态——四种空会被合并成一种");
});

console.log("\n" + "=".repeat(50));
console.log(`${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
