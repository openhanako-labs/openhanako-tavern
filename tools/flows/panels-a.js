// tools/flows/panels-a.js —— 走四个"数据面板"：世界 / 变量 / 预设 / 设定库
//
// 这一趟不只看"它开不开"，而是看**里面有没有东西**：
// 列表条目数、头几条的文字、空态说的是不是人话、按钮有没有全禁用。
// 前几轮的经验是——面板打开、innerText 也对，照样可能是死的。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = document.createElement("style");
st.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
document.head.appendChild(st);

window.__errs = window.__errs || [];
window.addEventListener("error", (e) => window.__errs.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) =>
  window.__errs.push("unhandled: " + String((e.reason && e.reason.message) || e.reason)));

await sleep(900);

const CONV = "e952e1c7-f779-49f3-ae75-c84daf4269b3";
const chat = await import(new URL("./assets/modules/chat.js", location.href).href);
const shell = await import(new URL("./assets/modules/shell.js", location.href).href);
await chat.openConversation(CONV);
await sleep(700);

/** 面板速写：宽高、条目、头几条、空态、按钮状态。 */
function snapshot(id, listSel) {
  const el = document.getElementById(id);
  if (!el) return { 面板: id, 状态: "不存在" };
  const r = el.getBoundingClientRect();
  const list = el.querySelectorAll(listSel);
  const buttons = [...el.querySelectorAll("button")];
  const txt = (el.innerText || "").replace(/\s+/g, " ").trim();
  return {
    面板: id,
    hidden: el.classList.contains("hidden"),
    可见: !!el.offsetParent,
    宽: Math.round(r.width),
    高: Math.round(r.height),
    条目数: list.length,
    头几条: [...list].slice(0, 4).map((x) => (x.innerText || "").replace(/\s+/g, " ").trim().slice(0, 46)),
    按钮数: buttons.length,
    禁用按钮: buttons.filter((b) => b.disabled).length,
    正文: txt.slice(0, 240),
    有报错样式: el.querySelectorAll(".error,.danger-line").length
  };
}

const out = {};

shell.openDrawer("board"); await sleep(600);
out.世界 = snapshot("drawer-board", ".board-cell, .cell, .board-row");

shell.openDrawer("presets"); await sleep(600);
out.预设 = snapshot("drawer-presets", ".preset-card, .preset-row, .card");

shell.openDrawer("settings"); await sleep(600);
out.设定库 = snapshot("drawer-settings", ".setting-row, .setting-card, .row");

// 变量放最后：截图会停在这一屏上——新样式要看截图才算看过
shell.openDrawer("variables"); await sleep(600);
// 变量抽屉里有两块：定义列表 + 这一场的取值
out.变量 = snapshot("drawer-variables", ".var-card, .conv-var, tr");

out.页面报错 = (window.__errs || []).slice(0, 5);
return out;
