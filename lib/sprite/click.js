// lib/sprite/click.js — 立绘点击反应（第 5 期）
//
// 数据模型（挂在角色卡上 card.sprite_reactions）：
//   {
//     zones: [
//       { name: "头部", rect: [x0, y0, x1, y1],   // 百分比 0-100，[左上, 右下]
//         reactions: [{ expr: "害羞", text: "别、别摸头啦…", weight: 3 }] }
//     ],
//     at: "生成时间"
//   }
//
// 三条纪律：
//   · 热区是**百分比**不是像素——立绘换图后热区仍然有效（同一角色比例不变）。
//   · 反应按权重抽取（weight 缺省 1）。
//   · 生成走 LLM 一次成型：AI 只需要卡描述 + 立绘宽高比，不需要真图。

import { readConfig as readModelConfig, resolveTargetFor } from "../models/config.js";

/** 求值一个点击：返回命中的热区与抽中的反应。纯函数。 */
export function pickReaction(spriteReactions, xPercent, yPercent, rng = Math.random) {
  const zones = Array.isArray(spriteReactions?.zones) ? spriteReactions.zones : [];
  for (const z of zones) {
    const rect = Array.isArray(z.rect) ? z.rect : null;
    if (!rect || rect.length !== 4) continue;
    const [x0, y0, x1, y1] = rect;
    if (xPercent >= x0 && xPercent <= x1 && yPercent >= y0 && yPercent <= y1) {
      const list = Array.isArray(z.reactions) ? z.reactions.filter(r => r?.text) : [];
      if (list.length === 0) return { zone: z.name, reaction: null };
      const total = list.reduce((s, r) => s + Math.max(1, Number(r.weight) || 1), 0);
      let roll = rng() * total;
      for (const r of list) {
        roll -= Math.max(1, Number(r.weight) || 1);
        if (roll <= 0) return { zone: z.name, reaction: r };
      }
      return { zone: z.name, reaction: list[list.length - 1] };
    }
  }
  return null;
}

/** 校验生成结果。返回错误数组（空 = 通过）。 */
export function validateSpriteReactions(data) {
  const errors = [];
  if (!data || typeof data !== "object") return ["not an object"];
  if (!Array.isArray(data.zones) || data.zones.length === 0) return ["zones 为空"];
  data.zones.forEach((z, i) => {
    if (!z?.name) errors.push(`zones[${i}].name 缺失`);
    if (!Array.isArray(z.rect) || z.rect.length !== 4) {
      errors.push(`zones[${i}].rect 必须是 [x0,y0,x1,y1]`);
      return;
    }
    const [x0, y0, x1, y1] = z.rect;
    if (x0 >= x1 || y0 >= y1) errors.push(`zones[${i}].rect 左上必须小于右下`);
    if (![x0, y0, x1, y1].every(v => v >= 0 && v <= 100)) errors.push(`zones[${i}].rect 超出 0-100`);
    if (!Array.isArray(z.reactions) || z.reactions.length === 0) {
      errors.push(`zones[${i}].reactions 为空`);
      return;
    }
    z.reactions.forEach((r, j) => {
      if (!r?.text) errors.push(`zones[${i}].reactions[${j}].text 缺失`);
    });
  });
  return errors;
}

/**
 * 构造生成热区+反应的 LLM 输入。
 * @param {object} card  角色卡（取 name/description/personality）
 * @param {{width?: number, height?: number}} [image]  立绘真实尺寸（拿不到就按 2:3 估）
 */
export function buildSpritePrompt(card, image = {}) {
  const name = String(card?.name || "角色");
  const desc = String(card?.description || "").slice(0, 800);
  const personality = String(card?.personality || "").slice(0, 300);
  // 像素尺寸约分成最简比（1024:1536 → 2:3）——给 AI 看比例比看像素清楚。
  let w = Number(image.width) || 2;
  let h = Number(image.height) || 3;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(Math.round(w), Math.round(h)) || 1;
  w = Math.round(w / g); h = Math.round(h / g);

  const systemPrompt = [
    "你是互动立绘设计师。为一个角色的立绘设计**点击热区**与对应反应。",
    `立绘宽高比 ${w}:${h}。用百分比坐标 [x0,y0,x1,y1]（左上 0,0 右下 100,100）划分 ${4}-6 个热区`,
    "（例如：头部、脸、胸口、手臂、手、腿部——按角色实际样子合理划分，互相不重叠，覆盖立绘主要区域）。",
    "每个热区 2-4 条反应，每条格式：{ \"expr\": \"表情\", \"text\": \"台词\", \"weight\": 数字 }。",
    "台词要符合角色性格（性格用第一人称口吻），长短一句到两句；weight 是相对权重（1-5）。",
    "只输出 JSON：{\"zones\":[{\"name\":\"...\",\"rect\":[..],\"reactions\":[...]}]}，不解释，不包代码块。"
  ].join("\n");

  return {
    systemPrompt,
    userPrompt: `角色：${name}\n${desc ? `描述：${desc}\n` : ""}${personality ? `性格：${personality}` : ""}`
  };
}

export default { pickReaction, validateSpriteReactions, buildSpritePrompt };
