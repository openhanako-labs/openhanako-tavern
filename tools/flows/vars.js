// tools/flows/vars.js —— 流程：发一条 → 看「本轮变量变化」那行 chips
//
// 桩会在正文尾巴上带一笔 {{setvar::好感::N}}。
// 要看到的是三件事：正文里不该再出现 {{setvar}}、下面多一行 chip、
// 而且变量**真的落盘了**（不是只画了个 chip）。

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
await sleep(700);

const out = {};
const lastMsg = () => {
  const box = document.getElementById("messages-container");
  const all = [...box.querySelectorAll(".message.assistant")];
  return all[all.length - 1] || null;
};

out["发送前·最后一条有 chips 吗"] = !!(lastMsg() && lastMsg().querySelector(".msg-vars"));

// 通过输入框发（走的和玩家一样的路）
const input = document.getElementById("chat-input");
input.value = "你还在吗？";
document.getElementById("send-btn").click();
await sleep(2200);

const m = lastMsg();
out["气泡正文"] = m ? m.querySelector(".bubble").innerText.trim() : "(没有气泡)";
out["正文里有残留的 setvar 吗"] = /setvar/.test(m ? m.querySelector(".bubble").innerText : "");
const chips = m ? [...m.querySelectorAll(".var-chip")] : [];
out["变量 chips"] = chips.map((c) => c.textContent.trim());
out["chips 的位置"] = chips.length ? (chips[0].closest(".bubble") ? "在气泡里" : "在气泡外（对）") : null;

// 落盘了吗：直接问后端
const r = await fetch(`/__api/conversations/${CONV}/variables`);
const d = await r.json();
out["后端返回的对话变量"] = d?.data?.variables ?? d?.variables ?? d;

out["页面报错"] = (window.__errs || []).slice(0, 4);
return out;
