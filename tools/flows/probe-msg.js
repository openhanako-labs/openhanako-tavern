// tools/flows/probe-msg.js —— 消息到底渲染了没有（临时探针）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
const CONV = "e952e1c7-f779-49f3-ae75-c84daf4269b3";
const chat = await import(new URL("./assets/modules/chat.js", location.href).href);

out["打开前 messages-container 子元素数"] = document.getElementById("messages-container")?.children.length ?? -1;
await chat.openConversation(CONV);
await sleep(2000);

const box = document.getElementById("messages-container");
out["打开后 子元素数"] = box?.children.length ?? -1;
out["容器 class"] = box?.className || "(没有容器)";
out["前两个孩子的 class"] = [...(box?.children || [])].slice(0, 3).map((e) => e.className);
const msgs = [...document.querySelectorAll(".message")];
out["message 元素数"] = msgs.length;
out["第一条的 id"] = msgs[0]?.dataset.id || "(没有)";
out["第一条里 msg-acts 在不在"] = msgs[0]?.querySelector(".msg-acts") ? "在" : "不在";
out["第一条里所有 data-act"] = [...(msgs[0]?.querySelectorAll("[data-act]") || [])].map((b) => b.dataset.act).join(",");
out["第一条 innerHTML 片段"] = (msgs[0]?.innerHTML || "").replace(/\s+/g, " ").slice(0, 300);

return out;
