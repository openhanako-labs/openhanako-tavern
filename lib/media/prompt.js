// lib/media/prompt.js — 把角色卡变成一段出图提示词（纯函数）
//
// 为什么要单独一层：提示词是这功能的"质量旋钮"，它得能被看、被改、被单测。
// 埋在路由里的话，改动就只能靠试。
//
// 两条取舍：
//   · 只用卡里**已有**的字段（名字、描述、性格、场景、标签），不自己加戏——
//     模型替角色编外貌，出来的立绘跟卡里写的那个人不着边。
//   · 外貌细节卡里没写就不写。宁可给一句朴素的提示词，也不编"银色长发"这种
//     卡里根本不存在的东西：图会跟卡打架，而用户以为是自己写漏了。

const STYLE = "半身像，干净背景，低饱和暖纸色调，扁平水彩质感，线条利落";

function clean(s, max = 200) {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * @param {object} card 角色卡
 * @param {{extra?: string, style?: string}} [opts]
 * @returns {{prompt: string, parts: string[], cardParts: number, hasCharacter: boolean}}
 *   parts 是为了让界面/测试能看清提示词由什么拼成；
 *   hasCharacter 是为了让调用方知道“这段提示词里到底有没有这个人的东西”——
 *   没有就得先告诉用户，而不是等几十秒后交一张不像她的图。
 */
export function portraitPrompt(card, opts = {}) {
  const c = card && typeof card === "object" ? card : {};
  const parts = [];
  let cardParts = 0;

  const name = clean(c.name, 60);
  if (name) { parts.push(`角色「${name}」的半身立绘`); cardParts++; }

  // 名字不算“这个人”——光有名字，模型手里几乎没有可用信息。
  // 所以下面四项（描述/性格/场景/标签）才是“有角色特征”的判据。
  let substantive = 0;

  const desc = clean(c.description, 200);
  if (desc) { parts.push(desc); cardParts++; substantive++; }

  const pers = clean(c.personality, 80);
  if (pers) { parts.push(`性格：${pers}`); cardParts++; substantive++; }

  const scene = clean(c.scenario, 80);
  if (scene) { parts.push(`场景：${scene}`); cardParts++; substantive++; }

  const tags = (Array.isArray(c.tags) ? c.tags : [])
    .map((t) => clean(t, 16))
    .filter(Boolean)
    .slice(0, 6);
  if (tags.length) { parts.push(`标签：${tags.join("、")}`); cardParts++; substantive++; }

  const extra = clean(opts.extra, 300);
  if (extra) parts.push(extra);

  parts.push(clean(opts.style, 160) || STYLE);

  return { prompt: parts.join("；"), parts, cardParts, hasCharacter: substantive > 0 };
}
