// lib/conversations/summary-llm.js — 用模型重写「前情提要」（独立一次调用）
//
// 为什么是**手动触发**而不是自动：
//   机械摘要（lib/llm/history.js 的 buildSummary）零成本、永远算得出来；
//   真摘要要额外一次模型调用，而折叠可能每轮都发生。
//   自动化那笔账就成了"用户不知道花了钱"。所以默认手动，界面上一个按钮。
//
// 三条约束**写死在提示词里**，每一条都有它防的东西：
//   ① 只许压缩、不许新增 —— 模型顺手编一个没发生过的事件，
//      会被当成事实进入之后每一轮，而且没人能察觉。
//   ② 不许写成对话口吻 —— 这段文字会被放在 prompt 最前面。
//      写成"我们继续吧"就等于往输入里插了一句**用户指令**。
//   ③ 长度上限 —— 它每轮都在 prompt 里占位，写长了等于把省下的又还回去。
//
// 关于"谁来判断它有没有编"：没有裁判，也不假装有。
// 能做的只有三件事：原文一条不删、摘要可读可改、并且**标明这是模型写的**。

export const SUMMARY_MAX_CHARS = 500;

/**
 * 默认提示词模板。
 *
 * 两条模板变量：{maxChars} / {characterName}。
 * 写错了或漏了 {maxChars} 会直接看到字面量——宁可见面也不静默。
 *
 * 三条防编约束写在这里，用户覆盖 summaryPrompt 之后由用户自己负责——
 * 面板会把这默认模板展示出来，让人看见改掉了什么。
 */
const DEFAULT_SUMMARY_PROMPT_TEMPLATE = [
  "你是剧情压缩器。把给定的旧对话压成一段「前情提要」。",
  "要求：",
  "· 只保留**之后还需要知道**的信息：发生了什么、谁做了什么决定、留下什么后果、关系有什么改变",
  "· **只许压缩，不许新增**：不得出现原文没有的事件、人名、地点、数字或情绪判断",
  "· **不要写成对话**，不要用「我们」「接下来」「继续」这类口吻——",
  "  这段文字会被当作背景资料放在对话最前面，不是一句话",
  "· 按时间顺序写成一段连续文字；不要分点、不要标题、不要用引号包起来",
  "· 不超过 {maxChars} 字",
  "{characterLine}"
].join("\n");

/** 把模板变量填上。只处理 {maxChars} / {characterName}——其他大括号保留原样。 */
function fillTemplate(tpl, { maxChars, characterName }) {
  let s = String(tpl ?? "");
  s = s.replace(/\{maxChars\}/g, String(maxChars));
  s = s.replace(/\{characterName\}/g, characterName ? characterName : "（未知角色）");
  // {characterLine} 是一个可整行删除的占位符（没角色名时直接删掉）
  s = characterName ? s.replace(/\{characterLine\}/g, `· 故事里的角色是「${characterName}」`) : s.replace(/\{characterLine\}/g, "");
  return s.replace(/\n\s*\n(?=\n|$)/g, "\n").trim();
}

export { DEFAULT_SUMMARY_PROMPT_TEMPLATE };

/**
 * 组装"重写前情提要"那一次调用。
 *
 * 被折的那批历史**合并成一条 user 消息**发过去 —— 不拆成多轮。
 * 拆成多轮的话模型会顺着往下写（它以为在继续对话），那就变成①和②的双重犯规。
 *
 * @param {object|null} character
 * @param {object[]} droppedMessages
 * @param {{maxChars?: number, summaryPrompt?: string}} [opts]
 * @returns {{systemPrompt: string, messages: object[], count: number, maxChars: number, customPrompt: boolean}}
 */
export function buildSummaryInput(character, droppedMessages, opts = {}) {
  const maxChars = Number(opts.maxChars) || SUMMARY_MAX_CHARS;
  const rows = (Array.isArray(droppedMessages) ? droppedMessages : [])
    .map(m => ({ role: m.role, content: String(m.content ?? "") }))
    .filter(m => m.content.length > 0);

  const custom = typeof opts.summaryPrompt === "string" && opts.summaryPrompt.trim();
  const template = custom || DEFAULT_SUMMARY_PROMPT_TEMPLATE;
  const systemPrompt = fillTemplate(template, {
    maxChars,
    characterName: character?.name || ""
  });

  return {
    systemPrompt,
    messages: [
      {
        role: "user",
        content: rows.map(m => `${m.role === "user" ? "玩家" : "角色"}：${m.content}`).join("\n")
      }
    ],
    count: rows.length,
    maxChars,
    customPrompt: !!custom
  };
}

/**
 * 清洗模型回话。**空手就空手**——宁可让用户看到"没写出来"，
 * 也不把半截解释、代码块或一句"好的"当成摘要存进去。
 *
 * @returns {{text: string|null, why: string}}
 */
export function parseSummary(raw, opts = {}) {
  const maxChars = Number(opts.maxChars) || SUMMARY_MAX_CHARS;
  let t = String(raw ?? "").trim();
  if (!t) return { text: null, why: "模型没给内容" };

  // 代码围栏（模型爱包一层）
  t = t.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
  // 整体被引号 / 书名号裹住
  t = t.replace(/^["'「『]+/, "").replace(/["'」』]+$/, "").trim();
  // 开头的寒暄（“好的，下面是…”）
  t = t.replace(/^(?:好的|好|嗯|明白)[，,、:：]?\s*/, "").trim();
  // “前情提要：”这类标签
  t = t.replace(/^(?:前情提要|摘要|总结|压缩结果)\s*[:：]\s*/, "").trim();

  if (!t) return { text: null, why: "清洗之后是空的" };
  if (t.length > maxChars) {
    t = t.slice(0, maxChars).replace(/[\s，。、；：,.]*$/, "") + "…";
  }
  return { text: t, why: "" };
}
