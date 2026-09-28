#!/usr/bin/env node
/**
 * append-naked-css.cjs — 在 CSS 末尾追加 26 条裸类的样式
 *
 * 这些类在 HTML/JS 里已经用上了，但 CSS 里一条规则都没有。
 * 补样式而不是删类——它们是活的功能，缺的是视觉定义。
 * 全部使用既有 token，不给控件上实底，hover 才出操作态。
 */

const { readFileSync, writeFileSync } = require("fs");

const CSS_PATH = "ui/assets/characters.css";

let text = readFileSync(CSS_PATH, "utf8");
const isCRLF = text.includes("\r\n");
if (isCRLF) text = text.replace(/\r\n/g, "\n");

const APPEND = `

/* ══════════════════════════════════════════════════════════════════
   2026-09-28 CSS 接线核查：补上 26 条裸类
   ══════════════════════════════════════════════════════════════════
   这些类在 HTML/JS 里已经用上了，但 CSS 里一条规则都没有。
   补样式而不是删类——它们是活的功能，缺的是视觉定义。
   全部使用既有 token（--fg-muted / --border / --accent / --surface），
   不给控件上实底（--surface 比米底亮），hover 才出操作态。
   ══════════════════════════════════════════════════════════════════ */

/* ── 布局骨架 ───────────────────────────────────── */

/* 主舞台：顶栏 + 主区 */
.stage {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* 顶栏：品牌 + 对话标题 + 弹性占位 */
.topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  height: 40px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
}

/* 品牌名：顶栏左端的小牌 */
.bname {
  font-size: 14px;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: -0.01em;
  white-space: nowrap;
}

/* 弹性占位：把后面元素推到右边 */
.spacer { flex: 1; }
.sp { flex: 1; }

/* 侧栏弹性：让侧栏内容撑满高度 */
.rail-grow { flex: 1 1 auto; min-height: 0; }

/* 面板头：抽屉/侧栏的标题栏 */
.panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
}

/* 面板标题 */
.panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 页脚：右下角的版权/状态行 */
.foot {
  padding: 12px 0;
  color: var(--fg-muted);
  font-size: 11px;
  text-align: center;
  flex-shrink: 0;
}

/* ── 空状态 ───────────────────────────────────── */

/* 空状态标题：列表为空时的提示文字 */
.empty-title {
  color: var(--fg-muted);
  font-size: 13px;
  padding: 24px 0;
  text-align: center;
}

/* ── 抽屉控件 ───────────────────────────────────── */

/* 抽屉关闭按钮：右上角 ✕ */
.drawer-close {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  border-radius: var(--r-sm);
  font-size: 14px;
  padding: 0;
  flex-shrink: 0;
}
.drawer-close:hover {
  background: var(--surface-2);
  color: var(--fg);
}

/* 抽屉计数徽章：显示条目数量 */
.drawer-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: 9px;
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
}

/* 抽屉过滤栏：搜索框 + 排序下拉 */
.drawer-filter {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
}

/* ── 背景图控件 ───────────────────────────────────── */

/* 背景图拖放区：点击或拖入图片 */
.bg-drop {
  border: 1px dashed var(--border);
  border-radius: var(--r-sm);
  padding: 16px;
  text-align: center;
  cursor: pointer;
  transition: border-color var(--t) var(--ease), background var(--t) var(--ease);
}
.bg-drop:hover {
  border-color: var(--accent-line);
  background: var(--surface-2);
}

/* 背景图预览：缩略图 */
.bg-preview {
  width: 100%;
  height: 80px;
  object-fit: cover;
  border-radius: var(--r-sm);
  margin-bottom: 8px;
  display: block;
}

/* 背景滑条行：标签 + 滑条 + 数值 */
.bg-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
}

/* 背景数值：滑条右侧的数字 */
.bg-val {
  min-width: 40px;
  text-align: right;
  color: var(--fg-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

/* ── 命令面板 ───────────────────────────────────── */

/* 命令面板输入栏 */
.cmd-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
}

/* 命令面板内容区 */
.cmd-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  max-height: 320px;
}

/* ESC 提示：键盘快捷键标签 */
.cmd-esc {
  font-size: 10px;
  color: var(--fg-muted);
  padding: 1px 5px;
  background: var(--surface-2);
  border-radius: var(--r-sm);
  font-family: monospace;
  flex-shrink: 0;
}

/* 命令列表：可滚动 */
.cmd-list {
  max-height: 320px;
  overflow-y: auto;
  padding: 4px 0;
}

/* ── 设置控件 ───────────────────────────────────── */

/* 批量操作栏：选中后的操作按钮 */
.settings-batch-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
}

/* 分页器：上/下页 */
.settings-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

/* ── 对话标题 ───────────────────────────────────── */

/* 对话名：顶栏里的当前对话标题 */
.cname {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* ── Director 容器 ───────────────────────────────────── */

/* Director 绑定容器：配方管理 */
.dir-bound {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
}

/* ── 更多菜单 ───────────────────────────────────── */

/* 更多按钮：⋯ 菜单触发 */
.more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 6px;
  border: none;
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  border-radius: var(--r-sm);
  font-size: 14px;
  line-height: 1;
  flex-shrink: 0;
}
.more:hover {
  background: var(--surface-2);
  color: var(--fg);
}

/* 更多菜单：弹出层 */
.moremenu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 140px;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  box-shadow: var(--sh-3);
  padding: 4px;
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

/* ── Markdown 注释 ───────────────────────────────────── */

/* 元注释：消息里的引用块说明 */
.mnote {
  font-size: 11px;
  color: var(--fg-muted);
  font-style: italic;
  margin-top: 4px;
}

/* ── 主区 ───────────────────────────────────── */

/* 主内容区：聊天/角色/设置 */
.main {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
`;

// 追加到文件末尾
text = text.replace(/\s*$/, "") + "\n" + APPEND.trimEnd() + "\n";

// 转回 CRLF
if (isCRLF) text = text.replace(/\n/g, "\r\n");

writeFileSync(CSS_PATH, text, "utf8");
console.log(`✓ 已追加 26 条裸类样式`);
console.log(`  文件：${CSS_PATH}`);
console.log(`  新大小：${Buffer.byteLength(text)} 字节`);
