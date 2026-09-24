// tools/flows/preview.js —— 流程：开对话 → 点「组装预览」→ 看账画出来没有

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};

const st = document.createElement("style");
st.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
document.head.appendChild(st);

window.__errs = window.__errs || [];
window.addEventListener("error", (e) => window.__errs.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) =>
  window.__errs.push("unhandled: " + String((e.reason && e.reason.message) || e.reason)));

await sleep(1000);

const CONV = "e952e1c7-f779-49f3-ae75-c84daf4269b3";
const chat = await import(new URL("./assets/modules/chat.js", location.href).href);
await chat.openConversation(CONV);
await sleep(700);

const btn = document.querySelector('button[data-act="prompt"]');
out.找到组装预览入口 = !!btn;
if (!btn) return out;
btn.click();
await sleep(1500);

const body = document.getElementById("preview-body");
const text = (body?.innerText || "").replace(/\n+/g, " / ");
out.模态可见 = !!document.getElementById("preview-modal")?.offsetParent;
out.有账 = text.includes("这一轮的账");
out.有没进 = text.includes("没进");
out.预览文本 = text.slice(0, 1500);
out.错误toast = [...document.querySelectorAll(".toast.error")].map((t) => t.textContent.slice(0, 110));
out.页面报错 = (window.__errs || []).slice(0, 5);

return out;
