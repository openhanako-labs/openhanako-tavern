/**
 * 抽屉的三种状态 —— 纯函数，产出 HTML 字符串，不碰 DOM。
 *
 * 为什么要有这个文件：
 *   七个抽屉的空容器原来都写着「加载中…」。数据回来了但确实没有，
 *   也说“加载中”，用户会一直等。三态必须分开，因为它们的
 *   **下一步不一样**：
 *     · 加载中 → 什么都别做，等一下
 *     · 空     → 这里确实没有，而且多半是因为你还没建
 *     · 错误   → 出事了，先分清是谁的错
 *
 * 形态说明见 docs/spec-drawer.md 第四节。
 * 类名是 d- 前缀（d-skel / d-state / d-err），样式在 characters.css 末尾。
 */

/** 转义。这里自带一份，避免和 core.js 的 DOM 实现产生循环依赖。 */
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/**
 * 加载态：骨架条。
 *
 * 不用转圈——转圈只说明“我在忙”，骨架条还告诉你
 * “将要出现的是两条带副标题的东西”。
 *
 * @param {number} rows 画几条
 */
export function skelHtml(rows = 3) {
  const one = `<div class="d-skel"><div class="d-skel-bar w46"></div><div class="d-skel-bar w82"></div><div class="d-skel-bar w64"></div></div>`;
  return one.repeat(Math.max(1, rows));
}

/**
 * 空态：图标 / 标题 / 解释 / 动作。
 *
 * 空态是用户第一次打开时**唯一的说明书**，
 * 所以写“这个功能是干什么的”，不是“暂无数据”。
 *
 * @param {object} o
 * @param {string} o.title   没有的是什么（“还没有正则规则”）
 * @param {string} o.desc    这个功能是干什么的（教一次用法）
 * @param {string} [o.ico]   图标字符
 * @param {string} [o.action] 动作按钮文案（“+ 新建一条”）
 * @param {string} [o.act]   动作标识，写进 data-act，供调用方绑事件
 */
export function emptyHtml({ title, desc = "", ico = "", action = "", act = "" }) {
  return `<div class="d-state">
    ${ico ? `<div class="d-state-ico">${esc(ico)}</div>` : ""}
    <div class="d-state-title">${esc(title)}</div>
    ${desc ? `<div class="d-state-desc">${esc(desc)}</div>` : ""}
    ${action ? `<button type="button" class="d-state-go"${act ? ` data-act="${esc(act)}"` : ""}>${esc(action)}</button>` : ""}
  </div>`;
}

/**
 * 错误态：标题 / 原因。
 *
 * 分清是“谁”出的事。“读不到数据”和“数据坏了”是两个完全不同的坏消息，
 * 前者重试就行，后者要去翻备份。
 *
 * @param {string} title 哪一步坏了（“没能读到设定库”）
 * @param {string} body  为什么、是谁的错
 */
export function errHtml(title, body = "") {
  return `<div class="d-err"><b>${esc(title)}</b>${esc(body)}</div>`;
}

/**
 * 一个抽屉的加载失败兜底：错误态 + 重试按钮。
 *
 * @param {string} title 哪一步坏了
 * @param {string} body  为什么
 * @param {string} [act] 重试按钮的 data-act
 */
export function errWithRetry(title, body, act = "retry") {
  return errHtml(title, body)
    + emptyHtml({ title: "", desc: "", action: "重试", act });
}
