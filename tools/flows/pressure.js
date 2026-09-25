// tools/flows/pressure.js —— 流程：发一条 → 看读数条上的压力
//
// 要看到的是：`上下文 X / Y · Z%`，而且 Y 是**真上限**（不是 8000 兜底）。
// 兜底值出现时应当写「上限未知」——所以这条流程同时也验那句诚实。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = document.createElement("style");
st.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
document.head.appendChild(st);

window.__errs = window.__errs || [];
window.addEventListener("error", (e) => window.__errs.push(String(e.message)));

await sleep(900);

const CONV = "e952e1c7-f779-49f3-ae75-c84daf4269b3";
const chat = await import(new URL("./assets/modules/chat.js", location.href).href);
await chat.openConversation(CONV);
await sleep(600);

const out = {};
out["发送前读数"] = document.getElementById("gen-meta")?.innerText.replace(/\n+/g, "|");

document.getElementById("chat-input").value = "你在守什么？";
document.getElementById("send-btn").click();
await sleep(2400);

const t = document.getElementById("gen-tokens");
out["发送后·上下文那格"] = t ? t.textContent.trim() : "(没有)";
out["标了警戒色吗"] = t ? t.classList.contains("tight") : null;
out["缓存那格"] = document.getElementById("gen-cache")?.textContent.trim();

// 直接问后端要这一轮的 meta，核对界面上的数
const r = await fetch("/__api/conversations/" + CONV);
const conv = (await r.json())?.data;
const last = [...(conv?.messages || [])].reverse().find((m) => m.role === "assistant");
out["最后一条消息有账吗"] = Array.isArray(last?.varDiff) ? last.varDiff.map((d) => d.text) : null;

out["页面报错"] = (window.__errs || []).slice(0, 4);
return out;
