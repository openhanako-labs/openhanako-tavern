// lib/illustration/prompt.js — 场景插图的提示词拼装（第 2 批 2.3）
//
// 与 lib/media/prompt.js 的分工：
//   · media/prompt.js 的 portraitPrompt 只管"这张脸是谁"——只吃卡里已有字段，
//     不编外貌。
//   · 本文件只管"这一句话画什么"——卡字段是底色，场景描述是主角。
//
// 纪律（与 portraitPrompt 一脉相承）：
//   · 不编外貌。卡里没写的绝不写。
//   · 场景描述原样带进 prompt（模型写了什么就用什么，不做同义改写）。
//   · 风格默认给一个"跟立绘同一路"的样式，让插图和立绘放一起不打架。

const STYLE = "宽画幅，低饱和暖纸色调，扁平水彩质感，线条利落，安静留白";

/*
 * 画面上不要出现字。
 *
 * 2026-09-27 真机两跑：
 *   ① 第一版（没这句）：城门洞那张，模型自己补了两个对话框，里面是假字
 *   ② 加上「不要文字、字母、对话框、分镜框或水印」：构图与色调明显变好，
 *      但**还是留了一个气泡**（里面是拉丁乱码）
 *
 * 为何没断根：提示词里的卡字段自带「习惯用「」引述对话」——
 * 图模型读到“对话”就顺手补个气泡，而它写不出真字，只会画出一堆乱码。
 * 所以这版把话说到“不是漫画页”上，并点名“对话气泡”（真机出错的就是它）。
 *
 * 这不是风格偏好，是**缺陷**：用户要的是“那一幕”，不是一页看不懂的漫画。
 * 所以它跟着风格一起进 prompt，用户自定义风格时也照样带上。
 *
 * 注：它只是**降低概率**，不是硬约束——图模型没有“不许画字”这个开关。
 */
const NO_TEXT = "画面内不出现任何文字、字母、对话气泡、分镜框或水印（这是插画，不是漫画页）";

function clean(s, max = 200) {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * 拼场景插图的出图提示词。
 *
 * @param {object}   card        角色卡（走 portraitPrompt 的口径，只吃已有字段）
 * @param {object}   [opts]
 * @param {string}   [opts.scene]     模型给的 [场景] 描述
 * @param {string}   [opts.speaker]   说话人名字（可选；不传就用卡的名字）
 * @param {string}   [opts.style]     覆盖默认风格
 * @returns {{prompt: string, parts: string[], scene: string|null, card: {parts: string[], hasCharacter: boolean}}}
 *
 * 拼装顺序：
 *   角色名字（必现）→ [说话人 ≠ 卡名时才写"说话人"] → 画面 → 卡字段 → 风格
 *
 * 说话人 = 卡名字的场景（单人对话最常见）不出现两次同名：名字只写在开头，
 * "说话人"那一段只在说话人 ≠ 卡名时才追加。
 */
export function sceneIllustrationPrompt(card, opts = {}) {
  const c = card && typeof card === "object" ? card : {};

  // 卡字段的底色（沿用 portraitPrompt 的取值口径，但不复用它的拼装）
  const cardParts = [];
  let cardSubstantive = 0;

  const name = clean(c.name, 60);
  if (name) cardParts.push(name);

  const desc = clean(c.description, 200);
  if (desc) { cardParts.push(desc); cardSubstantive++; }

  const pers = clean(c.personality, 80);
  if (pers) { cardParts.push(`性格：${pers}`); cardSubstantive++; }

  // 说话人：模型给了就用，没给就用卡名字
  const speaker = clean(opts.speaker, 60) || name;
  const scene = clean(opts.scene, 200);
  const style = clean(opts.style, 160) || STYLE;

  const parts = [];

  // 名字必现：没有名字时 prompt 就完全空了，那没有意义
  if (name) parts.push(`角色「${name}」`);
  else if (speaker) parts.push(`角色「${speaker}」`);

  // 说话人与卡名字不同时，额外说一句谁在说
  if (speaker && name && speaker !== name) {
    parts.push(`说话人「${speaker}」`);
  }

  if (scene) {
    parts.push(`画面：${scene}`);
  } else if (name || speaker) {
    // 没有场景描述：退化成半身像，但**不编外貌**
    parts.push("半身像，安静背景");
  }

  // 卡字段作为底色追加（名字已在开头出现，不重复）
  for (const p of cardParts) {
    if (p === name) continue;
    parts.push(p);
  }

  parts.push(style);
  parts.push(NO_TEXT);

  return {
    prompt: parts.join("；"),
    parts,
    scene: scene || null,
    card: { parts: cardParts, hasCharacter: cardSubstantive > 0 }
  };
}
