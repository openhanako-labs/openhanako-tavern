// lib/bond/core.js — 羁绊系统（第 6 期）
//
// 羁绊 = 一场特殊的**多角色对话**（conv.mode = "bond"）：
//   · characterIds 2+ 位角色，玩家不参与发言（消息只有 assistant）
//   · 玩家点「推进羁绊」→ AI 生成角色之间的日常互动（一段）
//   · 每段落盘后推进 conv.bondStage（关系演进账），AI 下一轮能看见关系史
//
// 为什么寄生在对话而不是独立实体：
//   白得 var-diff / 三层归档 / 剧情卡协议 / 预设全套能力——独立实体这些全要重写。
//   「玩家不在场」的语义由生成侧保证：buildGenerationInput 时玩家消息为空、
//   systemPrompt 声明"这是角色间的私下互动，玩家不在场"。
//
// 关系记忆：conv.bondStage = { stage: "初识|熟络|亲密|…", history: [每段摘要] }。
//   AI 每轮看见 stage 与最近几段 history——关系是有方向的演化，不是每轮重新开始。

/** 羁绊对话的默认标题。 */
export function bondTitle(cardNames = []) {
  return `羁绊 · ${cardNames.slice(0, 2).join(" × ")}`;
}

/** 组装一次羁绊推进的生成输入（systemPrompt 附件部分）。 */
export function bondSystemBlock({ names = [], stage = "", history = [] } = {}) {
  const historyText = history.slice(-3)
    .map((h, i) => `${i + 1}. ${h}`)
    .join("\n");

  return [
    "## 羁绊小剧场",
    `这是角色之间的私下互动，玩家「${"{user}"}」不在场，不要给玩家安排台词或行动。`,
    `参与者：${names.join("、")}。`,
    stage ? `当前关系阶段：${stage}。` : "当前关系阶段：初识。",
    historyText ? `他们之间的互动历史（越靠后越近）：\n${historyText}` : "这是他们的第一次私下互动。",
    "",
    "写一段他们之间的日常互动（200-400 字），要有来有回、有性格碰撞；",
    "结尾用「关系阶段: X」一行收束（X 从当前阶段自然演进，如 初识→熟络）。"
  ].join("\n");
}

/** 从 AI 回复末尾解析「关系阶段: X」。没有就返回 null。 */
export function parseBondStage(text) {
  const m = String(text ?? "").match(/关系阶段\s*[:：]\s*(\S+)/);
  return m ? m[1] : null;
}

export default { bondTitle, bondSystemBlock, parseBondStage };
