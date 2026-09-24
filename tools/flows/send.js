// tools/flows/send.js —— 流程：开一条对话 → 发一条消息 → 把观测量回传
//
// 在 App 页面里执行（同源 iframe），所以 `document` 就是 App 的文档、
// dynamic import 拿到的是 App 真在用的那份模块实例。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const out = {};
out.页面 = location.href.slice(-60);

// 后台标签页会节流 transition，量出来的布局全是假象——先关掉动效
const st = document.createElement("style");
st.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
document.head.appendChild(st);

// 抓流程期间的报错（装得早才抓得到）
window.__errs = window.__errs || [];
window.addEventListener("error", (e) => window.__errs.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) =>
  window.__errs.push("unhandled: " + String((e.reason && e.reason.message) || e.reason)));

await sleep(1000);   // 等模块图跑完

const CONV = "e952e1c7-f779-49f3-ae75-c84daf4269b3";
const chat = await import(new URL("./assets/modules/chat.js", location.href).href);
await chat.openConversation(CONV);
await sleep(700);

out["打开后·消息节点数"] = document.querySelector(".messages")?.children.length;
out["打开后·聊天标题"] = document.querySelector(".chat-title, #chat-title")?.textContent?.trim().slice(0, 40);
const cd = document.getElementById("drawer-character");
out["当前角色面板"] = cd
  ? { 宽: Math.round(cd.getBoundingClientRect().width), 内容: (document.getElementById("char-ctx-body")?.innerText || "").replace(/\n+/g, " / ").slice(0, 90) }
  : "无";

const ta = [...document.querySelectorAll("textarea")].find((t) => (t.placeholder || "").includes("输入消息"));
const sendBtn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "发送");
out.找到输入框 = !!ta;
out.找到发送键 = !!sendBtn;

if (ta && sendBtn) {
  ta.value = "你还在吗？";
  sendBtn.click();
  await sleep(4500);

  out["发送后·消息文本"] = (document.querySelector(".messages")?.innerText || "")
    .replace(/\n+/g, " / ").slice(0, 300);
  out["发送后·读数条"] = document.getElementById("gen-meta")?.innerText.replace(/\n+/g, "|").slice(0, 130);
  out["发送后·输入框残留"] = JSON.stringify(ta.value).slice(0, 60);
  out["发送后·发送键 disabled"] = sendBtn.disabled;
}

out.错误toast = [...document.querySelectorAll(".toast.error")].map((t) => t.textContent.slice(0, 130));
out.页面报错 = (window.__errs || []).slice(0, 6);

return out;
