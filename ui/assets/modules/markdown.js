// ui/assets/modules/markdown.js — 轻量 Markdown 渲染
//
// 为什么自己写：App 目录无构建步骤，不能引入外部依赖。
// 覆盖酒馆场景真正用到的子集：
//   *斜体*  **粗体**  `代码`  ```代码块```  > 引用  - 列表  换行
//   以及 ST 常见的 <tag> 透传（部分角色卡用 HTML）
//
// 安全：先转义 HTML，再按规则注入标签。不允许原始 HTML 直接通过。

/**
 * 对白判据：引号配对。纯本地，不要求模型标任何东西。
 *
 * 开头 `&quot;` 那一路是直引号——它走到这里已经被 esc() 转过，
 * 所以按实体配对；也正因为转过了，才不会误伤正文里的 & < >。
 * 四种引号都排除换行：跨段配对几乎总是误判（一段的收尾引号
 * 配上下一段的开头引号）。
 */
const SAY_RE = /(「[^」\n]*」|『[^』\n]*』|“[^”\n]*”|&quot;[^\n]*?&quot;)/g;

/** HTML 转义。 */
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 渲染 Markdown 子集为 HTML。
 *
 * @param {string} text
 * @param {{ allowHtml?: boolean, breaks?: boolean, dialogue?: boolean }} [opts]
 * @returns {string} HTML 片段
 */
export function renderMarkdown(text, opts = {}) {
  const { breaks = true, dialogue = false } = opts;
  if (typeof text !== "string" || !text) return "";

  // 1. 先切出代码块（避免块内内容被其他规则改写）
  const codeBlocks = [];
  let src = text.replace(/```([\s\S]*?)```/g, (_m, body) => {
    const idx = codeBlocks.length;
    codeBlocks.push(body.replace(/^\n/, ""));
    return `\u0000CODEBLOCK${idx}\u0000`;
  });

  // 2. 转义
  src = esc(src);

  // 2.5 对白标记。必须在转义之后、所有行内规则之前：
  //     此刻文本里已经没有裸的 < > &，插标签是安全的。
  if (dialogue) src = src.replace(SAY_RE, '<span class="say">$1</span>');

  // 3. 行内代码
  src = src.replace(/`([^`\n]+)`/g, (_m, code) => `<code>${code}</code>`);

  // 4. 粗体 / 斜体
  src = src.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  src = src.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  src = src.replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, "$1<em>$2</em>");

  // 5. 引用块（连续 > 行合并）
  src = src.replace(/(?:^|\n)((?:&gt;\s?.*\n?)+)/g, (_m, block) => {
    const inner = block
      .split("\n")
      .filter(l => l.trim())
      .map(l => l.replace(/^&gt;\s?/, ""))
      .join("<br>");
    return `\n<blockquote>${inner}</blockquote>\n`;
  });

  // 6. 列表
  src = src.replace(/(?:^|\n)((?:[-*]\s+.+\n?)+)/g, (_m, block) => {
    const items = block
      .split("\n")
      .filter(l => l.trim())
      .map(l => `<li>${l.replace(/^[-*]\s+/, "")}</li>`)
      .join("");
    return `\n<ul>${items}</ul>\n`;
  });

  // 7. 换行
  if (breaks) {
    src = src.replace(/\n/g, "<br>");
    // 清掉块级元素里被误加的 <br>
    src = src
      .replace(/<br>\s*<\/li>/g, "</li>")
      .replace(/<ul><br>/g, "<ul>")
      .replace(/<\/ul><br>/g, "</ul>")
      .replace(/<blockquote><br>/g, "<blockquote>")
      .replace(/<\/blockquote><br>/g, "</blockquote>");
  }

  // 8. 还原代码块
  src = src.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_m, i) => {
    const body = codeBlocks[Number(i)] ?? "";
    return `<pre><code>${esc(body)}</code></pre>`;
  });

  return src;
}

/** 渲染成纯文本（剥掉标记）——用于摘要、复制等场景。 */
export function stripMarkdown(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, "").trim())
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^[-*]\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .trim();
}

/**
 * 把纯文本安全地转成 HTML（保留换行）。
 * 消息渲染的默认路径——不做 Markdown 解析，避免误伤角色卡的原始格式。
 */
export function renderPlain(text) {
  return esc(text).replace(/\n/g, "<br>");
}

/**
 * 显示净化核心：剥掉提示词工程标记（计划 docs/plans/2026-10-01-opening-render-and-settings-filter）。
 *
 * 只用于 **UI 显示层**——模型收到的原文一字不动，净化不落盘。
 * 剥的清单（按序）：
 *   1. 完整 HTML 注释 <!-- … -->（非贪婪到最近的收尾，含 [Location Pool] 这类多行块）
 *   2. 未闭合的注释开头：HTML 语义里注释一直吃到 EOF，残片连同后面一起剥
 *   3. <opening> / </opening> 标签壳（壳之间的内容保留）
 *   4. 整行 // 注释（行首可空白，连换行一起删；行内的 https:// 不动——
 *      只删「除空白外整行都是注释」的行）
 *   5. 单独成行的箭头残片（<--- / <-->，注释块被部分消费后剩下的开头）
 *
 * 已知代价（计划「风险与开放问题」1）：正文里正当的整行 //（引用歌词那种）会被误删。
 * 缓解：只删整行，且只用于 opening / assistant 正文；误伤了再收。
 */
function stripPromptMarkers(text) {
  let s = String(text ?? "");
  // 1. 完整注释（非贪婪：就近配对，两个注释各吃各的）
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // 2. 未闭合注释到 EOF（HTML 语义：<!-- 之后全是注释体）
  s = s.replace(/<!--[\s\S]*$/g, "");
  // 3. opening 标签壳（带属性也认；壳之间的内容不动）
  s = s.replace(/<\/?opening(?:\s[^>]*)?>/gi, "");
  // 4. 整行 // 注释（连换行一起删，不留下空行）
  s = s.replace(/^[ \t]*\/\/.*(?:\n|$)/gm, "");
  // 5. 箭头残片：单独成行的 <--- / <--> / -->，注释块被半路消费后剩下的开头
  s = s.replace(/^[ \t]*<!?-{2,}>?[ \t]*(?:\n|$)/gm, "");
  s = s.replace(/^[ \t]*-{2,}>[ \t]*(?:\n|$)/gm, "");
  // 收尾：删干净后的注释洞叠一层（3+ 连续换行压成两行），首尾裁齐
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/**
 * 开场白渲染：净化 → esc → 换行转 <br>。
 * 空对话的「开场」预览走这条——first_mes 里的提示词工程标记不该给玩家看。
 */
export function renderOpening(text) {
  return renderPlain(stripPromptMarkers(text));
}

/**
 * 纯文本版净化：与 renderOpening 共用 stripPromptMarkers，不各自长一份正则
 * （两份正则迟早漂移）。供复制摘要等非 HTML 场景用。
 */
export function stripForDisplay(text) {
  return stripPromptMarkers(text);
}
