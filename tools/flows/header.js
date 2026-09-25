// tools/flows/header.js —— 标题行：品牌 / 这一场 / 读数 并成一行了吗
//
// 上一版品牌（h1.brand）单独占一整行，而它**一条样式都没有**，
// 按浏览器默认的大标题渲染；在宿主里还与窗口标题上的 App 名重复。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = document.createElement("style");
st.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
document.head.appendChild(st);
window.__errs = window.__errs || [];
window.addEventListener("error", (e) => window.__errs.push(String(e.message)));
await sleep(900);

const CONV = "e952e1c7-f779-49f3-ae75-c84daf4269b3";
const chat = await import(new URL("./assets/modules/chat.js", location.href).href);

const header = () => document.getElementById("chat-header");
const snap = () => ({
  文字: (header()?.innerText || "").replace(/\s+/g, " ").trim(),
  高: Math.round(header()?.getBoundingClientRect().height || 0)
});

const out = {};
out["打开对话前"] = snap();

const brand = document.querySelector(".brand");
out["品牌·在标题行里吗"] = brand ? (brand.closest("#chat-header") ? "在（对）" : "独立一行（错）") : "(没有 .brand)";
out["品牌·字号"] = brand ? getComputedStyle(brand).fontSize : null;

await chat.openConversation(CONV);
await sleep(1000);

out["打开对话后"] = snap();
out["世界格子在抽屉里渲染了几个"] = document.querySelectorAll("#board-list .board-cell").length;

out["页面报错"] = (window.__errs || []).slice(0, 4);
return out;
