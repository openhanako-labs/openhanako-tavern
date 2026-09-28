#!/usr/bin/env node
/**
 * delete-dead-css.cjs — 精确删除 CSS 里的死规则块
 *
 * 策略：
 *   1. 先把注释替换成等长空格（保留位置），后续用 mask 判断是否在注释里
 *   2. 逐字符扫描，遇到 @-规则（@media/@keyframes/@supports 等）整块跳过
 *   3. 遇到普通规则的 {，往前找选择器开头（跳过空白和注释），定位选择器文本
 *   4. 如果选择器包含死规则类名（精确匹配：.name 后不能跟字母数字连字符），标记删除
 *   5. 从后往前删除，避免索引变化
 *   6. 清理多余空行，转回 CRLF
 *
 * 用法：node tools/delete-dead-css.cjs [--dry-run]
 */

const { readFileSync, writeFileSync } = require("fs");

const CSS_PATH = "ui/assets/characters.css";

// 死规则类名（72 条，2026-09-28 逐条核查）
// 分组说明：
//   - gen 系列 8 条：生成台旧版（gen-note/gen-notes/gen-progress/gen-sec/gen-sources/gen-src/gen-src-loading/gen-src-note）
//   - topnav 系列 2 条：旧顶栏（topnav/topnav-item）
//   - ctx-tab(s) 2 条：旧右栏标签条（ctx-tab/ctx-tabs）
//   - chat 消息 3 条：msg-act/msg-actions/usage-badge
//   - pe 系列 3 条：pe-block/pe-fl/pe-row-detail-open
//   - preset-card 1 条：旧版预设卡
//   - regex 系列 7 条：regex-card/rc-arrow/rc-empty/rc-head/rc-name/rc-order/rc-pattern
//   - regex chip 6 条：s-display/s-prompt/s-stored/scope-c/scope-g/scope-p
//   - tool-* 5 条 + t-* 8 条：旧工具列表
//   - 单点死 11 条：brand/card-avatar/char-list/checkbox-row/sb-expand/select/sm-desc/spin/stop-btn/tag-chip
//   - 组合子 5 条：body/desc/m/name/tx
//   - 其他 4 条：input/sidebar/sidebar-header/sys/tab/view
const DEAD_CLASSES = [
  "body", "brand", "card-avatar", "char-list", "chat", "checkbox-row",
  "ctx-cast-acts", "ctx-cast-note", "ctx-cast-now", "ctx-tab", "ctx-tabs",
  "desc", "gen-note", "gen-notes", "gen-progress", "gen-sec", "gen-sources",
  "gen-src", "gen-src-loading", "gen-src-note", "input", "m", "msg-act",
  "msg-actions", "name", "ok", "pe-block", "pe-fl", "pe-row-detail-open",
  "preset-card", "rc-arrow", "rc-empty", "rc-head", "rc-name", "rc-order",
  "rc-pattern", "regex-card", "s-display", "s-prompt", "s-stored", "sb-expand",
  "scope-c", "scope-g", "scope-p", "select", "sidebar", "sidebar-header",
  "sm-desc", "spin", "stop-btn", "sys", "t-be", "t-desc", "t-group", "t-hint",
  "t-k", "t-line", "t-name", "t-v", "tab", "tag-chip", "test-out", "toggle",
  "tool-group", "tool-groups", "tool-row", "tools", "topnav", "topnav-item",
  "tx", "usage-badge", "view"
];

const DRY_RUN = process.argv.includes("--dry-run");

let text = readFileSync(CSS_PATH, "utf8");
const isCRLF = text.includes("\r\n");
text = text.replace(/\r\n/g, "\n");

// ── 注释 mask：注释位置替换为空格，保留长度 ─────────
const mask = text.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));

/**
 * 从 i（{ 的位置）往前找选择器开头。
 * 跳过空白和注释，遇到 } 或 @ 停止。
 */
function findSelectorStart(i) {
  let p = i - 1;
  while (p >= 0) {
    const c = mask[p];
    if (c === " " || c === "\n" || c === "\t") {
      p--;
      continue;
    }
    if (c === "}" || c === "@") {
      return p + 1;
    }
    p--;
  }
  return 0;
}

/**
 * 找配对的 }（考虑嵌套 { }）
 */
function findMatchingBrace(openIdx) {
  let p = openIdx + 1;
  let depth = 1;
  while (p < text.length && depth > 0) {
    if (mask[p] === "{") depth++;
    else if (mask[p] === "}") depth--;
    p++;
  }
  return p;  // p 是 } 的下一个位置
}

// ── 扫描规则块 ─────────────────────────────
const toDelete = [];  // { start, end, selector }

let i = 0;
while (i < text.length) {
  const c = mask[i];
  // 跳过 @-规则块（@media/@keyframes/@supports/@font-face/@charset/@import/@namespace/@page/@use）
  if (c === "@") {
    const braceIdx = mask.indexOf("{", i);
    if (braceIdx < 0) break;
    const end = findMatchingBrace(braceIdx);
    i = end;
    continue;
  }
  // 普通规则
  if (c === "{") {
    const selectorStart = findSelectorStart(i);
    const selector = text.slice(selectorStart, i).trim();
    const end = findMatchingBrace(i);

    // 判断选择器是否包含死规则
    let matchedClass = null;
    for (const name of DEAD_CLASSES) {
      const re = new RegExp("\\." + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w-])");
      if (re.test(selector)) {
        matchedClass = name;
        break;
      }
    }
    if (matchedClass) {
      toDelete.push({ start: selectorStart, end, selector, matchedClass });
    }
    i = end;
    continue;
  }
  i++;
}

// ── 打印将要删除的块 ─────────────────────────────
console.log(`\n找到 ${toDelete.length} 个待删除块：\n`);
for (const d of toDelete) {
  const lineNo = text.slice(0, d.start).split("\n").length;
  const selPreview = d.selector.length > 70 ? d.selector.slice(0, 70) + "..." : d.selector;
  console.log(`  行 ${lineNo.toString().padStart(5)} [.${d.matchedClass.padEnd(18)}] ${selPreview}`);
}

if (DRY_RUN) {
  console.log("\n[dry-run] 未修改文件。");
  process.exit(0);
}

// ── 从后往前删除 ─────────────────────────────
toDelete.sort((a, b) => b.start - a.start);
for (const d of toDelete) {
  text = text.slice(0, d.start) + text.slice(d.end);
}

// 清理多余空行（3+ 个换行折叠成 2 个）
text = text.replace(/\n{3,}/g, "\n\n");

// 转回 CRLF
if (isCRLF) text = text.replace(/\n/g, "\r\n");

writeFileSync(CSS_PATH, text, "utf8");
console.log(`\n✓ 已删除 ${toDelete.length} 个规则块`);
console.log(`  文件：${CSS_PATH}`);
console.log(`  新大小：${Buffer.byteLength(text)} 字节`);
