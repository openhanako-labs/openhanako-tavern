// narration-plan.js — "连播这场"要读哪些、按什么顺序、读成什么
//
// 为什么把它单独抽出来：这是**一段纯逻辑**，而且是最容易出错的那部分
// （漏了一条、顺序乱了、把旁白当成对话、把 {{user}} 读成花括号）。
// 抽出来就能用 node 直接测，不必开浏览器。
//
// 三条取舍：
//   · **只读角色的台词**。把你自己的话也念一遍很怪——那是你说过的话，
//     不是这场戏里"别人说给你听"的东西。（要连旁白也可以，只是现在不做。）
//   · **宏先还原再剪符号**。{{user}} 该读成你的名字，不该读成花括号。
//   · **空的丢掉**。一条只有格式符号的消息，读出来是"（代码块）"或者一片静默。

/** 说话人是谁：群聊看 speakerId，单人对话就是这场的主角。 */
export function speakerOf(m, convCharacterId = "") {
  return String(m?.speakerId || convCharacterId || "");
}

/**
 * @param {Array<object>} messages 会话里的消息（按时间顺序）
 * @param {{characterId?: string, process?: (s: string) => string, onlyAssistant?: boolean, max?: number}} [opts]
 * @returns {Array<{id: string, speakerId: string, text: string, index: number}>}
 */
export function planNarration(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const onlyAssistant = opts.onlyAssistant !== false;
  const characterId = String(opts.characterId || "");
  const process = typeof opts.process === "function" ? opts.process : (s) => s;
  const max = Number(opts.max) > 0 ? Number(opts.max) : 0;

  const out = [];
  let index = 0;
  for (const m of list) {
    if (!m) continue;
    // 系统消息永远不读：它不是这场戏的一部分。
    // （“连你自己的话也读”可以。“把系统提示念出来”不行。）
    if (m.role === "system") continue;
    if (onlyAssistant && m.role !== "assistant") continue;

    const raw = String(m.content ?? "");
    const expanded = String(process(raw) ?? "");
    const text = expanded.replace(/\s+/g, " ").trim();
    if (!text) continue;              // 空的丢掉，不占一个位置

    out.push({
      id: String(m.id ?? `#${index}`),
      speakerId: speakerOf(m, characterId),
      text,
      index
    });
    index++;
    if (max && out.length >= max) break;
  }
  return out;
}

/** 进度文案：连播时顶上那条要能一眼看懂读到哪了。 */
export function progressText(done, total, name = "") {
  const n = Math.max(0, Number(done) || 0);
  const t = Math.max(0, Number(total) || 0);
  return `${name ? name + " · " : ""}${Math.min(n + 1, t)}/${t}`;
}
