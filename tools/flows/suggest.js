// tools/flows/suggest.js —— 流程：点「给点方向」→ 看候选条 → 点一条填进输入框

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

const row = document.getElementById("suggest-row");
const btn = document.getElementById("suggest-btn");
out["找到容器"] = !!row;
out["找到按钮"] = !!btn;
out["按钮文案"] = btn ? btn.textContent.trim() : null;
if (!btn || !row) return out;

btn.click();
await sleep(1800);

const chips = [...row.querySelectorAll(".suggest-chip")];
out["候选条数"] = chips.length;
out["候选文案"] = chips.map((c) => c.textContent.trim());
out["容器可见"] = !row.classList.contains("hidden") && !!row.offsetParent;

if (chips.length > 0) {
  chips[0].click();
  await sleep(150);
  const input = document.getElementById("chat-input");
  out["点第一条后输入框"] = input ? input.value : "(没有输入框)";
  out["输入框获得焦点"] = document.activeElement === input;
}

out["错误toast"] = [...document.querySelectorAll(".toast.error")].map((t) => t.textContent.slice(0, 110));
out["页面报错"] = (window.__errs || []).slice(0, 5);

return out;
