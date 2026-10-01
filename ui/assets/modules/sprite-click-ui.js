// ui/assets/modules/sprite-click-ui.js — 立绘点击反应的 UI（第 5 期）
//
// 职责两件：
//   1. attachSpriteClick(img, card)：卡上有 sprite_reactions 时接管点击——
//      命中热区 → 按权重抽反应 → 立绘旁气泡显示台词。
//      没有数据时不动（点开大图的原行为保留）。
//   2. generateSpriteReactions(card, imageSize)：调 LLM 生成热区+反应（档案面板按钮用）。
//
// 求值在前端本地做（同一套权重逻辑的服务端镜像在 lib/sprite/click.js，
// 测试只测 lib 版；前端这份为了避免 Node 依赖，是照同一算法写的浏览器版——
// 两者漂移的风险由 regression 测试锁住算法不变量来兜底）。

import { apiFetch, unwrap, toast, friendlyError } from "./core.js";

/** 权重抽取（与 lib/sprite/click.js pickReaction 同算法）。 */
function pickLocal(zones, xPercent, yPercent) {
  for (const z of zones) {
    const rect = Array.isArray(z.rect) ? z.rect : null;
    if (!rect || rect.length !== 4) continue;
    const [x0, y0, x1, y1] = rect;
    if (xPercent >= x0 && xPercent <= x1 && yPercent >= y0 && yPercent <= y1) {
      const list = (Array.isArray(z.reactions) ? z.reactions : []).filter(r => r?.text);
      if (list.length === 0) return { zone: z.name, reaction: null };
      const total = list.reduce((s, r) => s + Math.max(1, Number(r.weight) || 1), 0);
      let roll = Math.random() * total;
      for (const r of list) {
        roll -= Math.max(1, Number(r.weight) || 1);
        if (roll <= 0) return { zone: z.name, reaction: r };
      }
      return { zone: z.name, reaction: list[list.length - 1] };
    }
  }
  return null;
}

/** 在立绘旁显示一个气泡，几秒后淡出。 */
function showBubble(img, text) {
  const wrap = img.parentElement;
  if (!wrap) return;
  wrap.style.position = "relative";
  const old = wrap.querySelector(".sprite-bubble");
  if (old) old.remove();

  const b = document.createElement("div");
  b.className = "sprite-bubble";
  b.textContent = text;
  wrap.appendChild(b);
  // 强制回流后加显示类，触发过渡
  void b.offsetWidth;
  b.classList.add("show");
  setTimeout(() => {
    b.classList.remove("show");
    setTimeout(() => b.remove(), 300);
  }, 2600);
}

/**
 * 给立绘 <img> 挂点击反应。
 * @param {HTMLImageElement} img
 * @param {object} card  角色卡（读 card.sprite_reactions 与 card.id）
 */
export function attachSpriteClick(img, card) {
  const zones = card?.sprite_reactions?.zones;
  if (!Array.isArray(zones) || zones.length === 0) return;

  img.classList.add("sprite-clickable");
  img.title = "点一点她/他（有反应热区）";
  img.addEventListener("click", (e) => {
    const rect = img.getBoundingClientRect();
    const xPercent = ((e.clientX - rect.left) / rect.width) * 100;
    const yPercent = ((e.clientY - rect.top) / rect.height) * 100;
    const hit = pickLocal(zones, xPercent, yPercent);
    if (hit?.reaction?.text) {
      showBubble(img, `${hit.reaction.expr ? `（${hit.reaction.expr}）` : ""}${hit.reaction.text}`);
    } else if (hit) {
      showBubble(img, "……");
    }
    // 未命中热区：什么都不做（不打扰）
  });
}

/**
 * 生成热区+反应（档案面板按钮用）。
 * @param {object} card
 * @param {{width?: number, height?: number}} [imageSize]  立绘真实尺寸（可选）
 * @returns {Promise<object>} 生成并已存卡的 sprite_reactions
 */
export async function generateSpriteReactions(card, imageSize = {}) {
  const env = await apiFetch(`characters/${encodeURIComponent(card.id)}/sprite-reactions/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ width: imageSize.width || undefined, height: imageSize.height || undefined })
  });
  const d = unwrap(env) || {};
  if (!d.sprite_reactions) throw new Error("生成结果为空");
  return d.sprite_reactions;
}

export default { attachSpriteClick, generateSpriteReactions };
