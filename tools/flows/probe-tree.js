// tools/flows/probe-tree.js —— 把第一条消息的子树整个量一遍
//
// 上一步：两条消息都是 293.925px，flex-grow:0，margin:0 → 294px 来自内容，
// 而内容看上去是空的。那就把子树摊开看谁高。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = document.createElement("style");
st.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
document.head.appendChild(st);
await sleep(900);

const chat = await import(new URL("./assets/modules/chat.js", location.href).href);
await chat.openConversation("e952e1c7-f779-49f3-ae75-c84daf4269b3");
await sleep(700);

const box = document.getElementById("messages-container");
const first = box && box.children[0];
if (!first) return { err: "没有第一条消息" };

const rows = [];
const walk = (el, depth) => {
  const c = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  rows.push({
    d: depth,
    tag: el.tagName.toLowerCase(),
    cls: el.className || "",
    h: Math.round(r.height * 100) / 100,
    w: Math.round(r.width * 100) / 100,
    pos: c.position,
    disp: c.display,
    mt: c.marginTop,
    mb: c.marginBottom,
    minH: c.minHeight,
    hProp: c.height,
    text: el.children.length === 0 ? (el.textContent || "").trim().slice(0, 30) : ""
  });
  if (depth < 4) [...el.children].forEach((k) => walk(k, depth + 1));
};
walk(first, 0);

return {
  消息列表样式: (() => {
    const cs = getComputedStyle(first);
    return { padding: cs.padding, borderWidth: cs.borderTopWidth, lineHeight: cs.lineHeight, fontSize: cs.fontSize, whiteSpace: cs.whiteSpace };
  })(),
  子树: rows,
  首条HTML: first.innerHTML.slice(0, 420)
};
