// tools/flows/probe-form.js —— 点「新建」之后，到底是谁弹出来了
//
// 上一步：表单没出现，但 modal-save / modal-close 可见。
// 说明有东西被弹出来了，只是里面不是 #board-form。
// 问页面：哪个 modal 在显示？#board-form 挂在谁里面？它自己是什么 display？

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = document.createElement("style");
st.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
document.head.appendChild(st);
await sleep(900);

const CONV = "e952e1c7-f779-49f3-ae75-c84daf4269b3";
const chat = await import(new URL("./assets/modules/chat.js", location.href).href);
const shell = await import(new URL("./assets/modules/shell.js", location.href).href);
await chat.openConversation(CONV);
await sleep(600);

const out = {};
const describe = (el) => ({
  tag: el.tagName.toLowerCase(),
  id: el.id || null,
  cls: el.className && typeof el.className === "string" ? el.className : null,
  display: getComputedStyle(el).display,
  visible: el.offsetParent !== null || getComputedStyle(el).position === "fixed"
});

shell.openDrawer("board");
await sleep(600);

out["点之前·可见的 modal"] = [...document.querySelectorAll(".modal")]
  .filter((m) => getComputedStyle(m).display !== "none")
  .map(describe);
out["点之前·board-form 的祖先链"] = (() => {
  const f = document.getElementById("board-form");
  const chain = [];
  let el = f;
  while (el && el !== document.body) { chain.push(describe(el)); el = el.parentElement; }
  return chain;
})();

document.getElementById("create-board-cell-btn")?.click();
await sleep(700);

out["点之后·可见的 modal"] = [...document.querySelectorAll(".modal")]
  .filter((m) => getComputedStyle(m).display !== "none")
  .map(describe);
out["点之后·board-form"] = describe(document.getElementById("board-form"));
out["点之后·可见按钮（全）"] = [...document.querySelectorAll("button")]
  .filter((b) => b.offsetParent !== null)
  .map((b) => `${b.id || "." + b.className}:${(b.textContent || "").trim().slice(0, 10)}`);
out["点之后·可见表单域"] = [...document.querySelectorAll("input,textarea,select")]
  .filter((i) => i.offsetParent !== null)
  .map((i) => `${i.id || i.name || i.type}`).slice(0, 20);

return out;
