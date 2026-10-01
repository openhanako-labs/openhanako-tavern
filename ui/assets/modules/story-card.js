// ui/assets/modules/story-card.js — 剧情卡渲染（杂志分栏式）
//
// 消费 lib/story/protocol.js 的解析结果（挂在 msg.story 上）。
// 方案④：左栏对话与旁白 + 效果 chips，右栏场景数据 + 新增 + 选项按钮。
// 窄于 520px 右栏折到底部（纯 CSS flex-wrap 管，见 characters.css）。
//
// 纪律：
//   · 不解析原文——所有内容来自 msg.story（服务端已解析），前端只排版。
//   · 一切用户可见文本过 escapeHtml；不注入原始 HTML。
//   · 选项点击 = 填进输入框（不是直接发）——与 suggest-chip 同一条哲学。

import { escapeHtml } from "./core.js";

/** 【剧情】头：类型徽章 + 标题。head 是解析结果里嵌套的 story.story。 */
function headHtml(head) {
  const type = String(head?.type || "").trim();
  const title = String(head?.title || "").trim();
  if (!type && !title) return "";
  return `<div class="sc-head">
    ${type ? `<span class="sc-type">${escapeHtml(type)}</span>` : ""}
    ${title ? `<span class="sc-title">${escapeHtml(title)}</span>` : ""}
  </div>`;
}

/** 对话与旁白：说话行名字橙色前缀，旁白淡色。 */
function dialogueHtml(dialogue) {
  const rows = (Array.isArray(dialogue) ? dialogue : [])
    .map(d => {
      const text = String(d?.text || "").trim();
      if (!text) return "";
      if (d.isNarration) return `<div class="sc-narr">${escapeHtml(text)}</div>`;
      const name = String(d?.speaker || "").trim();
      const mood = String(d?.mood || "").trim();
      const namePart = name
        ? `<span class="sc-who">${escapeHtml(name)}${mood ? `<span class="sc-emo">·${escapeHtml(mood)}</span>` : ""}</span>`
        : "";
      return `<div class="sc-line">${namePart}<span class="sc-say">${escapeHtml(text)}</span></div>`;
    })
    .join("");
  return rows;
}

/** 效果 chips：up 绿 / down 红 / set 灰。与现有 var-chip 同一套视觉语义。 */
function effectsHtml(effects) {
  const chips = (Array.isArray(effects) ? effects : [])
    .map(e => {
      const name = String(e?.name || "").trim();
      if (!name) return "";
      const op = e?.op;
      const cls = op === "+" ? "up" : op === "-" ? "down" : "set";
      const sign = op === "+" ? "+" : op === "-" ? "−" : "=";
      return `<span class="sc-fx ${cls}">${escapeHtml(name)} ${sign}${escapeHtml(String(e?.value ?? ""))}</span>`;
    })
    .filter(Boolean)
    .join("");
  return chips;
}

/** 右栏「新增」区：场景更新的人物/物品/移除。 */
function sceneUpdatesHtml(sceneUpdates) {
  const list = (Array.isArray(sceneUpdates) ? sceneUpdates : [])
    .map(u => {
      const name = String(u?.name || "").trim();
      if (!name) return "";
      const kind = u?.kind === "person" ? "人物" : u?.kind === "item" ? "物品" : u?.kind === "remove" ? "移除" : "";
      const tags = [u?.gender, u?.mood, u?.role].map(x => String(x || "").trim()).filter(Boolean).join(" · ");
      const desc = String(u?.description || "").trim();
      const sub = [tags, desc].filter(Boolean).join("，");
      return `<div class="sc-upd"><span class="sc-upd-k">${escapeHtml(kind)}</span><span class="sc-upd-n">${escapeHtml(name)}</span>${sub ? `<div class="sc-upd-d">${escapeHtml(sub)}</div>` : ""}</div>`;
    })
    .filter(Boolean)
    .join("");
  return list;
}

/**
 * 渲染一张剧情卡。
 *
 * @param {object} story  msg.story（lib/story/protocol.js 的解析结果）
 * @param {object} [opts]
 * @param {boolean} [opts.hasVarDetail]  是否显示「明细 ›」（有 varDiff 时）
 * @returns {string} HTML
 */
export function renderStoryCard(story, opts = {}) {
  if (!story || typeof story !== "object") return "";

  const dialogue = dialogueHtml(story.dialogue);
  const effects = effectsHtml(story.effects);
  const updates = sceneUpdatesHtml(story.sceneUpdates);
  // 嵌套结构：类型/标题/场景在 story.story 里（解析结果的 shape 如此）。
  const head = story.story || {};
  const scene = String(head.scene || "").trim();

  const choices = (Array.isArray(story.choices) ? story.choices : [])
    .map(c => {
      const text = String(c?.text || "").trim();
      if (!text) return "";
      const letter = String(c?.letter || "").trim();
      return `<button type="button" class="sc-choice" data-choice="${escapeHtml(text)}">${letter ? `<span class="sc-key">${escapeHtml(letter)}.</span>` : ""}${escapeHtml(text)}</button>`;
    })
    .filter(Boolean)
    .join("");

  // 左栏正文：对话优先；没有对话但有效果也画（块可缺）。
  const leftBody = dialogue || "";
  const fxRow = effects
    ? `<div class="sc-fxrow">${effects}${opts.hasVarDetail ? `<button type="button" class="mini vars-detail" data-act="vars-detail" title="这一轮变量变化">明细 ›</button>` : ""}</div>`
    : "";

  if (!leftBody && !fxRow && !choices && !updates && !scene) return "";

  return `<div class="story-card">
    ${headHtml(head)}
    <div class="sc-cols">
      <div class="sc-main">
        ${leftBody}
        ${fxRow}
      </div>
      <div class="sc-side">
        ${scene ? `<div class="sc-sec"><b>场景</b><span>${escapeHtml(scene)}</span></div>` : ""}
        ${updates ? `<div class="sc-sec"><b>新增</b>${updates}</div>` : ""}
        ${choices ? `<div class="sc-sec"><b>行动</b><div class="sc-choices">${choices}</div></div>` : ""}
      </div>
    </div>
  </div>`;
}

export default { renderStoryCard };
