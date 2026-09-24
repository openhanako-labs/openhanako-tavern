// tools/flows/probe-height.js —— 量一量气泡为什么被拉满
//
// 从截图上看得见：一句「你还在吗?」撑成一个 340px 高的空盒子。
// CSS 里 .message 没有 flex:1，所以病根是别处——别猜，量。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = document.createElement("style");
st.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
document.head.appendChild(st);
await sleep(900);

const chat = await import(new URL("./assets/modules/chat.js", location.href).href);
await chat.openConversation("e952e1c7-f779-49f3-ae75-c84daf4269b3");
await sleep(700);

const box = document.getElementById("messages-container");
if (!box) return { err: "没有 #messages-container" };

const cs = getComputedStyle(box);
const kids = [...box.children];

return {
  容器: {
    id: box.id,
    cls: box.className,
    高: Math.round(box.getBoundingClientRect().height),
    滚动高: box.scrollHeight,
    display: cs.display,
    flexDirection: cs.flexDirection,
    justifyContent: cs.justifyContent,
    alignItems: cs.alignItems,
    子元素数: kids.length
  },
  子元素: kids.map((el) => {
    const c = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      cls: el.className,
      h: Math.round(r.height),
      w: Math.round(r.width),
      flexGrow: c.flexGrow,
      flexBasis: c.flexBasis,
      alignSelf: c.alignSelf,
      height: c.height,
      marginTop: c.marginTop,
      marginBottom: c.marginBottom,
      文本首行: (el.textContent || "").trim().split("\n")[0].slice(0, 18)
    };
  })
};
