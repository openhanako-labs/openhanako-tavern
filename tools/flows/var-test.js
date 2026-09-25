// tools/flows/var-test.js —— 流程：变量抽屉的「测试替换」真的接在自己那张卡上吗
//
// 修之前：按钮读的是抽屉顶部那个没标题的孤儿框（已经被删），
// 你填「输入文本」点「测试」什么也不会发生。
//
// 要看到的是四件事：
//   · 读的是标着「输入文本」的那个框
//   · 不填 JSON 时用的是**这一场的真实值**
//   · 引用到的变量名列出来（名字写错才看得出来）
//   · 值没给的单独说一句

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = document.createElement("style");
st.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
document.head.appendChild(st);

window.__errs = window.__errs || [];
window.addEventListener("error", (e) => window.__errs.push(String(e.message)));

await sleep(900);

const CONV = "e952e1c7-f779-49f3-ae75-c84daf4269b3";
const chat = await import(new URL("./assets/modules/chat.js", location.href).href);
const shell = await import(new URL("./assets/modules/shell.js", location.href).href);
await chat.openConversation(CONV);
await sleep(600);
shell.openDrawer("variables");
await sleep(700);

const out = {};
out["孤儿框还在吗"] = !!document.getElementById("vf-test-input");
out["「这一场」块"] = document.getElementById("conv-vars-list")?.innerText.replace(/\s+/g, " ").trim();
out["测试替换的输入框存在"] = !!document.getElementById("replace-test-input");

// 填它自己那张卡里的字段，然后点它自己的按钮
document.getElementById("replace-test-input").value = "好感是 {{好感}}，另外 {{没定义的名字}}";
document.getElementById("test-replace-btn").click();
await sleep(900);

const box = document.getElementById("replace-test-result");
out["结果可见"] = box ? !box.classList.contains("hidden") : null;
out["结果文字"] = box ? box.innerText : null;

out["页面报错"] = (window.__errs || []).slice(0, 4);
return out;
