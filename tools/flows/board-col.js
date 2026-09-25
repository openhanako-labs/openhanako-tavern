// tools/flows/board-col.js —— 黑板列：从两个入口开关，格子真在列里
//
// 这一条要验的是"世界的入口还是活的"：它从抽屉变成了常驻列，
// 而三个入口（标题行那颗按钮 / 顶栏「世界」/ ⋯ 菜单）都必须照样能开能关，
// 并且**不许再冒出空抽屉**（那正是"特例没写"的形状）。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const disp = (id) => getComputedStyle(document.getElementById(id)).display;
const openDrawers = () =>
  [...document.querySelectorAll("main > .drawer")].filter((e) => !e.classList.contains("hidden")).map((e) => e.id);
const main = document.querySelector("main");

const out = {};

// 先真的开一场：标题行那颗按钮的可见性挂在 renderHeaderMeta 上，
// 不开对话时它还是初始的 hidden——那样量到的是“没初始化”，不是“它不可见”。
const chat = await import(new URL("./assets/modules/chat.js", location.href).href);
await chat.openConversation("e952e1c7-f779-49f3-ae75-c84daf4269b3");
await sleep(900);

out["① 初始（默认收起）#board-col"] = disp("board-col");
out["① 标题行按钮可见"] = !!document.getElementById("board-toggle")?.offsetParent;
out["① 按钮文字"] = document.getElementById("board-toggle")?.innerText.replace(/\s+/g, " ");
out["① 按钮上的数"] = document.getElementById("board-toggle-n")?.textContent;
out["① 聊天占哪一列"] = getComputedStyle(document.getElementById("view-chat")).gridColumnStart;

// 入口一：标题行那颗「世界 N 格」
document.getElementById("board-toggle").click();
await sleep(600);
out["② 展开后 #board-col"] = disp("board-col");
out["② main 的类"] = main.className;
out["② 列宽(px)"] = Math.round(document.getElementById("board-col").getBoundingClientRect().width);
out["② 列里的格子数"] = document.querySelectorAll("#board-list > *").length;
out["② 列里第一条"] = (document.querySelector("#board-list > *")?.innerText || "").replace(/\n+/g, "|").slice(0, 70);
out["② 列与聊天不重叠"] = (() => {
  const a = document.getElementById("board-col").getBoundingClientRect();
  const b = document.getElementById("view-chat").getBoundingClientRect();
  return a.right <= b.left + 1;
})();
out["② 顶栏「世界」高亮"] = !!document.querySelector('#topnav [data-drawer="board"]')?.classList.contains("on");
out["② 抽屉一个都没冒出来"] = openDrawers();

// 入口二：顶栏的「世界」（老入口，现在该是开关）
document.querySelector('#topnav [data-drawer="board"]').click();
await sleep(500);
out["③ 顶栏点一下后 #board-col"] = disp("board-col");
out["③ 同时冒出来的抽屉"] = openDrawers();
document.querySelector('#topnav [data-drawer="board"]').click();
await sleep(500);
out["③ 再点一下（该开回来）"] = disp("board-col");

// 入口三：⋯ 菜单
const more = document.getElementById("app-more-btn");
if (more) { more.click(); await sleep(350); }
const entry = document.querySelector('#app-more-menu [data-drawer="board"]');
out["④ ⋯ 菜单里有世界入口"] = !!entry;
if (entry) {
  const was = disp("board-col");
  entry.click();
  await sleep(600);
  // ⋯ 里那一条也是**开关**（当前开着就该关），所以不假设方向，只验“真的变了 + 没冒抽屉”
  out["④ ⋯ 入口点前/后"] = `${was} → ${disp("board-col")}`;
  out["④ 它真的切了"] = was !== disp("board-col");
  out["④ 点它之后冒出的抽屉"] = openDrawers();
}

// 收起后：一个看不见的面板不该还摸得到
if (disp("board-col") !== "none") { document.getElementById("board-toggle").click(); await sleep(400); }
out["⑤ 收起后 display"] = disp("board-col");
out["⑤ 收起后 offsetParent"] = String(document.getElementById("board-col").offsetParent);
out["⑤ 格子还留在 DOM 里"] = document.querySelectorAll("#board-list > *").length > 0;

// 留在**展开**状态：--shot 拍的是流程结束时那一瞬，要看的就是它该长的样子。
if (disp("board-col") === "none") { document.getElementById("board-toggle").click(); await sleep(600); }
out["⑥ 截图前状态"] = disp("board-col");
out["⑥ 顶栏「世界」高亮（此时角色面板还开着）"] = !!document.querySelector('#topnav [data-drawer="board"]')?.classList.contains("on");

return out;
