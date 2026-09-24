// tools/flows/look.js —— 让页面停在「有对话」的状态，好让我截图看
//
// 前几轮我都是用 innerText 和元素树"看"界面的：能读到"抽屉宽 344"，
// 读不到它长得像不像那张卡。这个流程只做一件事：把页面摆成有人用的样子，
// 然后**什么都不做**地留在那儿。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const st = document.createElement("style");
st.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
document.head.appendChild(st);

await sleep(900);

const chat = await import(new URL("./assets/modules/chat.js", location.href).href);
await chat.openConversation("e952e1c7-f779-49f3-ae75-c84daf4269b3");
await sleep(800);

// 把候选条也点出来——它在卡上是「行动面板」的一部分
const btn = document.getElementById("suggest-btn");
if (btn) { btn.click(); await sleep(1600); }

const row = document.getElementById("suggest-row");
return {
  消息数: document.querySelector(".messages")?.children.length,
  候选条数: row ? row.querySelectorAll(".suggest-chip").length : 0,
  读数条可见: !!document.getElementById("gen-meta")?.offsetParent,
  读数条文字: document.getElementById("gen-meta")?.innerText.replace(/\n+/g, "|"),
  右栏宽: Math.round(document.getElementById("drawer-character")?.getBoundingClientRect().width || 0),
  输入区可见: !!document.getElementById("chat-input-area")?.offsetParent
};
