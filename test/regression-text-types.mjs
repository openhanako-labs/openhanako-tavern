// regression-text-types.mjs — 对白标记（文本类型里最"本地"的那一条判据）
//
// 判据是引号配对，纯正则，不要求模型标任何东西。
// 这条测试要守住的是：**只标记引号里的字，别误伤别的**。
import { renderMarkdown } from "../ui/assets/modules/markdown.js";

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  }
}
const countSay = (h) => (h.match(/class="say"/g) || []).length;

console.log("=== 对白标记 ===");

// 1. 默认不开——别的调用方（摘要、复制）不该被牵连
{
  const h = renderMarkdown("「关上门。」");
  ok("默认不标记", !h.includes('class="say"'), h);
}

// 2. 打开后标记，且引号连同内容一起进 span
{
  const h = renderMarkdown("「关上门。」她说「外面不只有风。」", { dialogue: true });
  ok("两处引号都标记", countSay(h) === 2, `找到 ${countSay(h)} 处：${h}`);
  ok("引号连同内容一起进 span", h.includes('<span class="say">「关上门。」</span>'), h);
  ok("引号外的字留在外面", h.includes("她说"), h);
}

// 3. 四种引号都认
{
  const h = renderMarkdown("「甲」『乙』“丙”\"丁\"", { dialogue: true });
  ok("四种引号都认", countSay(h) === 4, `找到 ${countSay(h)} 处：${h}`);
}

// 4. 不跨行配对——一段的收尾引号配上下一段的开头引号，几乎总是误判
{
  const h = renderMarkdown("「上面这句没关\n下面这句没开」", { dialogue: true });
  ok("不跨行配对", countSay(h) === 0, h);
}

// 5. 没有引号时原样不动
{
  const h = renderMarkdown("她没有回头，只抬手把一张纸按回桌上。", { dialogue: true });
  ok("无引号时不动", h === "她没有回头，只抬手把一张纸按回桌上。", h);
}

// 6. 转义在前——这是插标签安全的前提
{
  const h = renderMarkdown("<script>alert(1)</script>「好」", { dialogue: true });
  ok("HTML 仍被转义", !h.includes("<script"), h);
  ok("转义之后照样能标记", h.includes('<span class="say">「好」</span>'), h);
}

// 7. 与行内标记共存
{
  const h = renderMarkdown("**「走。」**", { dialogue: true });
  ok("粗体与对白共存", h.includes("<strong>") && h.includes('class="say"'), h);
}

// 8. 未闭合的引号不该吃掉后半段
{
  const h = renderMarkdown("他说「门关上了 然后就走掉了。", { dialogue: true });
  ok("未闭合引号不匹配", countSay(h) === 0, h);
}

// 9. 空引号也算一对（角色可能就吐个「」）
{
  const h = renderMarkdown("「」", { dialogue: true });
  ok("空引号配对", countSay(h) === 1, h);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
