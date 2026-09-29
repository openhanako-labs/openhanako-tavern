// var-diff-modal.js — 「本轮发生了什么」面板（S1）
//
// 入口：消息 var-chip 行末尾的「明细 ›」按钮。
// 内容：这条 assistant 消息上的 varDiff，按 add / set / remove 三组展示。
//       不截断——chips 里 24 字截断的规矩只留给 chips，面板要看的是完整值。
//
// 与 chips 速览的分工：
//   chips（消息下方）  ：一眼速览，一行小字，24 字截断，靠 describeVarDiff 的 text
//   面板（这个）        ：完整读，按 change 分组，直接看 diff 对象的 from/to
// 一份 varDiff 两种渲染，但**账只有一份**——都是从消息上的 varDiff 读。
//
// 「修改本轮变量」不在面板里做编辑器——跳去变量抽屉。一处编辑入口，不养双胞胎。

import { escapeHtml } from "./core.js";
import { state } from "./state.js";

const $ = (id) => document.getElementById(id);

/** 消息 id → 消息对象。只从当前对话里找。 */
export function findMessage(id) {
  const msgs = state.currentConv?.messages || [];
  return msgs.find(m => String(m.id) === String(id)) || null;
}

/**
 * 值到「空」的判定：null / undefined / "" 都算空。
 * 与 lib/variables/diff.js 的 describeVarDiff 里那份保持一致——
 * 面板展示与 chips 展示用同一个语义。
 */
function isEmpty(v) {
  return v === null || v === undefined || v === "";
}

/**
 * 面板展示用的值：字符串原样，空值显示成「空」占位。
 * **不截断**——面板要看得见完整值（长文本用 white-space:pre-wrap 折行）。
 */
function showValue(v) {
  if (isEmpty(v)) return "空";
  return String(v);
}

/**
 * 一行 diff：变量名 + 从→到。
 *
 * remove 没有 `to`（值被清掉），所以走不同的排版：只标旧值 + 「已移除」标签。
 */
function renderRow(d) {
  const name = escapeHtml(d.name || "?");
  // cls 只作判断：真正拼进 class 的字符串在下方字面量里。
  // 不能把 cls 直接拼到 `class="vd-row ${cls}"` —— 扫描器拿不到「字面量 + 插值」里的真名字。
  if (d.change === "remove") {
    return `<div class="vd-row vd-chg-remove">
      <div class="vd-name">${name}</div>
      <div class="vd-vals">
        <span class="vd-from">${escapeHtml(showValue(d.from))}</span>
        <span class="vd-arrow">→</span>
        <span class="vd-to empty">—</span>
      </div>
    </div>`;
  }
  if (d.change === "add") {
    return `<div class="vd-row vd-chg-add">
      <div class="vd-name">${name}</div>
      <div class="vd-vals">
        <span class="vd-from">${escapeHtml(showValue(d.from))}</span>
        <span class="vd-arrow">→</span>
        <span class="vd-to">${escapeHtml(showValue(d.to))}</span>
      </div>
    </div>`;
  }
  return `<div class="vd-row vd-chg-set">
    <div class="vd-name">${name}</div>
    <div class="vd-vals">
      <span class="vd-from">${escapeHtml(showValue(d.from))}</span>
      <span class="vd-arrow">→</span>
      <span class="vd-to">${escapeHtml(showValue(d.to))}</span>
    </div>
  </div>`;
}

/** 组头。count 为 0 时不显示这一组（保持面板紧凑，不摆空标题）。 */
function renderGroup(title, items) {
  if (!items.length) return "";
  return `<section class="vd-group">
    <div class="vd-group-hd"><b>${title}</b><span class="vd-group-count">${items.length}</span></div>
    <div class="vd-group-body">${items.map(renderRow).join("")}</div>
  </section>`;
}

/**
 * 打开面板。msg 缺 varDiff 或为空时不弹（chips 行本来就不出现，也不会点到按钮；
 * 但防住直接调用时收到坏消息——fail closed 而不是弹个空面板）。
 */
export function open(msg) {
  const modal = $("var-diff-modal");
  if (!modal) return;

  const diff = Array.isArray(msg?.varDiff) ? msg.varDiff : [];
  if (diff.length === 0) return;

  const adds = diff.filter(d => d.change === "add");
  const sets = diff.filter(d => d.change === "set");
  const removes = diff.filter(d => d.change === "remove");

  // 组头汇总：三组条数一行，方便一眼看总账
  const summary = `新增 ${adds.length} · 变更 ${sets.length} · 移除 ${removes.length}`;
  const body = $("var-diff-body");
  if (body) {
    body.innerHTML = `<div class="vd-summary">${escapeHtml(summary)}</div>`
      + renderGroup("新增", adds)
      + renderGroup("变更", sets)
      + renderGroup("移除", removes);
  }

  // 记住是哪条消息：改完之后可能想刷一次
  modal.dataset.msgId = String(msg?.id || "");
  modal.classList.remove("hidden");
}

export function close() {
  $("var-diff-modal")?.classList.add("hidden");
}

/**
 * 「修改本轮变量」：跳去变量抽屉。
 *
 * 不在面板里嵌编辑器——一处编辑入口，不养双胞胎。
 * 变量抽屉由 shell.openDrawer("variables") 打开，loadVariables 会自动拉一遍。
 */
export async function gotoVariables() {
  try {
    const { openDrawer } = await import("./shell.js");
    await openDrawer("variables");
  } catch (e) {
    console.error("[var-diff-modal] openDrawer('variables') failed:", e);
  }
}

/** 幂等绑定：面板的关闭按钮 + 遮罩点击 + 修改按钮。 */
export function bind() {
  const modal = $("var-diff-modal");
  if (!modal || modal.dataset.bound === "1") return;
  modal.dataset.bound = "1";

  modal.addEventListener("click", (e) => {
    // 点遮罩自身才关：点内容区不动
    if (e.target === modal) close();
  });
  $("var-diff-close")?.addEventListener("click", close);
  $("var-diff-edit")?.addEventListener("click", gotoVariables);
}
