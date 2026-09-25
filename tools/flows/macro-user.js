// tools/flows/macro-user.js —— 为什么 {{char}} 展开了、{{user}} 没有
//
// 引擎层单独测过：两个都能展开（tools/probe-macros.mjs）。
// 数据也看过：first_mes 里两个宏都在，半角花括号。
// 那就只剩一种可能——界面喂给它的上下文不一样。直接问页面上那个实例。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(900);

const CONV = "e952e1c7-f779-49f3-ae75-c84daf4269b3";
const chat = await import(new URL("./assets/modules/chat.js", location.href).href);
const state = (await import(new URL("./assets/modules/state.js", location.href).href)).state;

await chat.openConversation(CONV);
await sleep(800);

const out = {};
const m = state.macro;
out["有 macro 吗"] = !!m;
out["对话的 userName"] = JSON.stringify(state.currentConv?.userName);
out["角色的 name"] = JSON.stringify(state.currentCharacter?.name);

if (m) {
  out["process('{{char}}')"] = m.process("{{char}}");
  out["process('{{user}}')"] = m.process("{{user}}");
  out["process('A{{user}}B')"] = m.process("A{{user}}B");
  // 空串替换会被当成"没解析"吗——这正是可疑之处
  out["process('{{unknown}}')"] = m.process("{{unknown}}");
}
out["first_mes"] = JSON.stringify(state.currentCharacter?.first_mes);
out["renderMessages 后中间那段文字"] = (document.getElementById("messages-container")?.innerText || "")
  .replace(/\s+/g, " ").trim().slice(0, 120);
return out;
