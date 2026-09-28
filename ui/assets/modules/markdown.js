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
