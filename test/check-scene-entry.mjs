// test/check-scene-entry.mjs — 场景插图入口必须落在真动作上（常驻）
//
// 根因记录（RED-017 同族）：**入口画出来了、点了没反应**。
// 右栏面板是模板串拼出来的，少了绑定不会报错——按钮照样在，
// 用户点一下什么都不会发生，控制台一片干净。
//
// 这条盯的是两条完整的链，缺一环就算失败：
//
//   一、设置入口（右栏角色面板）
//     ① 面板里有这颗按钮（且写着「场景插图」）
//     ② 渲染后绑了它
//     ③ 绑向的是 scene.js 里真存在的 openScene
//     ④ 工具抽屉那份**没被顺手删掉**——它是没开对话时唯一的入口
//
//   二、手动补一张（⋯ 菜单「这一场」那组）
//     ⑤ 菜单里有 data-act="illustrate"
//     ⑥ 弹窗 #illustrate-modal 在（按钮点了得有地方去）
//     ⑦ chat-more.js 把动作接到 openIllustrate
//     ⑧ illustrate.js 打的是真端点 POST /conversations/:id/illustrate
//     ⑨ 路由传了 source:"manual"——不传的话 mode=off 会把手动拦死
//
// ④ 与 ⑨ 都是故意的：它们看着像细节，其实是两个真出事的地方。

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MODULES = path.join(ROOT, "ui", "assets", "modules");

const read = (p) => fs.readFileSync(p, "utf8");
const mod = (f) => read(path.join(MODULES, f));

const charactersJs = mod("characters.js");
const sceneJs = mod("scene.js");
const chatMoreJs = mod("chat-more.js");
const mainJs = mod("main.js");
const html = read(path.join(ROOT, "ui", "characters.html"));
const routesJs = read(path.join(ROOT, "lib", "illustration", "routes.js"));

let illustrateJs = "";
try { illustrateJs = mod("illustrate.js"); } catch { /* 缺文件下面会报 */ }

let errors = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const fail = (m) => { console.log(`  ❌ ${m}`); errors++; };

console.log("\n=== 场景插图入口接线 ===\n");

// ── 一、设置入口 ──
if (!/id="ctx-scene"[^>]*>\s*场景插图/.test(charactersJs)) {
  fail('右栏角色面板里没有 id="ctx-scene" 的「场景插图」按钮');
} else {
  ok("右栏角色面板里有「场景插图」按钮");
}

if (!/querySelector\("#ctx-scene"\)\?\.addEventListener/.test(charactersJs)) {
  fail('renderCharContext 里没绑 #ctx-scene（按钮在、点了没反应）');
} else {
  ok("渲染后绑了它");
}

if (!/export async function openScene/.test(sceneJs)) {
  fail("scene.js 里没有 openScene，绑定无处可去");
} else if (!/m\.openScene\(\)/.test(charactersJs)) {
  fail("绑定里没调 openScene()");
} else {
  ok("绑向 scene.js 的 openScene（真存在）");
}

if (!html.includes('id="open-scene-settings"')) {
  fail('工具抽屉里的 #open-scene-settings 没了——没开对话就进不去场景插图设置');
} else if (!/bindSceneEntry/.test(sceneJs)) {
  fail("工具抽屉入口没人绑");
} else {
  ok("工具抽屉那份还在（没开对话时的兜底入口）");
}

// ⑤ 兄弟仨要齐：语音朗读 / 出图设置 / 场景插图 都在「设置（配一次就不动）」那一组里。
//
// 为什么值得钉：场景插图原本只有工具抽屉那一份，声读与出图都在 ⋯ 菜单，
// 用户在一个“设置”分组里只能看到 2/3——他不会觉得“还有一个没放”，
// 只会觉得这个菜单就这些。
{
  const g = html.match(/<div class="more-group">设置（配一次就不动）<\/div>([\s\S]*?)<div class="more-group">/);
  const seg = g ? g[1] : "";
  const missing = ["tts", "image", "scene"].filter((a) => !new RegExp(`data-act="${a}"`).test(seg));
  if (!g) fail("找不到「设置（配一次就不动）」那一组");
  else if (missing.length) fail(`⋯ 菜单「设置」组缺入口：${missing.join(", ")}（兄弟仨该齐）`);
  else ok("⋯ 菜单「设置」组里语音朗读 / 出图设置 / 场景插图都在");

  if (!/act === "scene"/.test(chatMoreJs) || !/m\.openScene\(\)/.test(chatMoreJs)) {
    fail('chat-more.js 没接 "scene" 这个动作（按钮在、点了没反应）');
  } else {
    ok('chat-more.js 把 "scene" 接到了 openScene');
  }
}

// ── 二、手动补一张 ──
if (!illustrateJs) {
  fail("缺 ui/assets/modules/illustrate.js —— 面板承诺的「手动补一张入口」不存在");
} else {
  ok("illustrate.js 在");

  if (!html.includes('data-act="illustrate"')) {
    fail('⋯ 菜单里没有 data-act="illustrate"（找不到入口）');
  } else {
    ok("⋯ 菜单里有「补一张场景图」");
  }

  if (!html.includes('id="illustrate-modal"')) {
    fail("缺 #illustrate-modal（按钮点了没地方去）");
  } else {
    ok("弹窗 #illustrate-modal 在");
  }

  if (!/act === "illustrate"/.test(chatMoreJs) || !/openIllustrate/.test(chatMoreJs)) {
    fail("chat-more.js 没接 illustrate 这个动作（按钮点了没反应）");
  } else {
    ok("⋯ 菜单动作接上了 openIllustrate");
  }

  if (!/export function bindIllustrate/.test(illustrateJs) || !/bindIllustrate\(\)/.test(mainJs)) {
    fail("bindIllustrate 没被 main.js 调用（弹窗按钮全都没绑）");
  } else {
    ok("main.js 装配了 bindIllustrate");
  }

  if (!/conversations\/\$\{[^}]*\}\/illustrate/.test(illustrateJs)) {
    fail("illustrate.js 没打 POST /conversations/:id/illustrate");
  } else {
    ok("打的是真端点 POST /conversations/:id/illustrate");
  }

  if (!/source: "manual"/.test(routesJs)) {
    fail('路由没传 source:"manual"（手动会被 mode=off 拦死——这正是刚修的那个坑）');
  } else {
    ok('路由传了 source:"manual"（手动只受总闸管）');
  }

  // 轮询要能把**新**消息放上去：插图永远是新增一条，不是更新已有那条。
  if (!/state\.currentConv\.messages\.push\(latest\)/.test(mod("chat.js"))) {
    fail("chat.js 的轮询只会更新已有消息，插图是新增的——图会永远不出现");
  } else {
    ok("轮询会把新插图消息放上去（不是只更新已有的）");
  }

  // ── 插图那一层：样式与放大 ──
  //
  // 「JS 里有类名」不等于「有人给它写过样式」。这一套曾经**一行 CSS 都没有**：
  // 图按原始尺寸糊满气泡、提示词是裸 div、三个状态长得一模一样。
  const chatJs = mod("chat.js");
  const css = read(path.join(ROOT, "ui", "assets", "characters.css"));
  const needCss = [".illus-img", ".illus-prompt", ".illus-note", ".illus-pending", ".illus-failed", ".illus-img-missing"];
  const noCss = needCss.filter((sel) => !new RegExp(sel.replace(/\./g, "\\.") + "\\s*[,{]").test(css));
  if (noCss.length) {
    fail(`这些插图类名在 CSS 里没样式：${noCss.join(", ")}（JS 里写了类名、没人给它们写样式）`);
  } else {
    ok(`${needCss.length} 个插图类名都有样式`);
  }

  if (!/illus-note/.test(chatJs)) {
    fail("renderIllustrationBody 没渲染降级那一行（degraded/refNote 落到消息上也没人显示）");
  } else {
    ok("降级那一行会渲染出来");
  }

  if (!/illus-zoomable/.test(chatJs) || !/openImageViewer\(img\.src/.test(chatJs)) {
    fail("插图没绑点开放大（计划 2.7 要的是「缩略图 + 点开放大 + 三态」）");
  } else {
    ok("插图点了能放大");
  }
}

console.log("\n" + "=".repeat(50));
console.log(errors === 0 ? "场景插图入口接线全部通过" : `失败 ${errors} 项`);
console.log("=".repeat(50));
process.exit(errors > 0 ? 1 : 0);
