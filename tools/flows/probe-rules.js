// tools/flows/probe-rules.js —— 谁给 .message 塞了 294px 的高度
//
// 内容 104.8px、盒子 293.925px。块级盒子不会自己长高，所以一定有一条
// 命中它的规则在设高度。与其把 CSS 再读一遍（我已经漏读过一次），
// 不如让 DOM 把**所有命中它的规则**列出来。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = document.createElement("style");
st.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
document.head.appendChild(st);
await sleep(900);

const chat = await import(new URL("./assets/modules/chat.js", location.href).href);
await chat.openConversation("e952e1c7-f779-49f3-ae75-c84daf4269b3");
await sleep(700);

const el = document.getElementById("messages-container")?.children[0];
if (!el) return { err: "没有第一条消息" };

const matched = [];
const keyframes = [];
for (const sheet of document.styleSheets) {
  let rules;
  try { rules = sheet.cssRules; } catch { continue; }
  for (const r of rules) {
    if (r.type === CSSRule.KEYFRAMES_RULE) {
      if (/slide|float|grow/.test(r.name)) keyframes.push({ name: r.name, text: r.cssText.slice(0, 260) });
      continue;
    }
    if (!r.selectorText) continue;
    let hit = false;
    try { hit = el.matches(r.selectorText); } catch { hit = false; }
    if (hit) matched.push({ sel: r.selectorText, css: (r.style.cssText || "").slice(0, 240) });
  }
}

const before = Math.round(el.getBoundingClientRect().height);
// 实验：把高度交回去，看它是不是自己塌回内容高
el.style.height = "auto";
const afterAuto = Math.round(el.getBoundingClientRect().height);
el.style.height = "";

return {
  实测高: before,
  置auto后高: afterAuto,
  命中规则数: matched.length,
  命中的规则: matched,
  相关keyframes: keyframes
};
