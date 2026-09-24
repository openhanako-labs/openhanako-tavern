// lib/conversations/suggestions.js — 行动候选项（独立一次生成）
//
// 为什么单独一个模块、单独一次调用：
//
//   1. **候选项不进正文 prompt。** 它是「这一轮之后能做什么」，属于界面，
//      不属于模型的输入。混进正文 prompt 就等于每轮前面多一段会变的东西，
//      前缀缓存全废——同类项目（dsh-tavern）把它做成后台任务，
//      就是为了让正文那条路径上不干别的活。
//   2. 这个 prompt 自己短且稳（底子 + 最近几条 + 固定要求），
//      这样它**自己的**缓存才可能命中。
//   3. 不改对话、不写历史。它是一次「看」，不是「说」。
//
// 关于「用工具调用提交结构」：同类项目走的是工具契约（candidate_submit_choices），
// 那是更稳的办法——结构由 schema 保证，模型没法把工具调用写成普通文字。
// 我们的 llm 服务目前**不暴露 tools**（见 lib/llm/service.js 的 generate/
// streamEvents，只有 systemPrompt/maxTokens/temperature）。
// 所以退一步：**严格文本契约 + 容错解析**。解析失败就是失败——
// 宁可空手回来，也不把半截 JSON 或一段解释塞给界面。

export const SUGGESTION_LIMIT = 4;
const PER_ITEM_MAX = 80;

/**
 * 组装候选项那一次调用。
 *
 * 只看最近几条：候选项是「此刻的岔路」，不需要整部历史。
 * 这也是它能和正文那条长 prompt 分开缓存的原因。
 */
export function buildSuggestionInput(character, conv, opts = {}) {
  const window = Math.max(2, Number(opts.window) || 8);
  const recent = (conv?.messages || []).slice(-window);

  const systemPrompt = [
    "你是剧情行动候选项生成器。",
    `读完上面的剧情，给出 ${SUGGESTION_LIMIT} 个**各不相同的下一步行动**，供玩家挑选。`,
    "要求：",
    "· 每行一条，写成「- 行动」，不要编号、不要空行、不要别的话",
    "· 每条 15~40 字，是**玩家能做的事**，不是旁白、不是心理描写",
    "· 四条倾向要各异：至少一条推进剧情、一条试探观察、",
    "  一条转向某个角色、一条风险更高或更出格的",
    `· 最多 ${SUGGESTION_LIMIT} 条；宁可少，也不要凑数`,
    "· 不要输出 JSON、不要解释、不要复述上文",
    character?.name ? `· 视角是玩家，不是「${character.name}」自己` : ""
  ].filter(Boolean).join("\n");

  const messages = recent
    .map(m => ({ role: m.role, content: String(m.content ?? "") }))
    .filter(m => m.content.length > 0);

  return { systemPrompt, messages };
}

/** 去掉「行动：」这类前缀、去引号、压空白。 */
export function normalizeSuggestionText(text) {
  return String(text ?? "")
    .replace(/^\s*(?:行动|选项|选择|建议|action)\s*[:：]\s*/i, "")
    .replace(/^["'「『]+|["'」』]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 解析模型的返回。
 *
 * 判据故意**严**：只认列表项，别的一律进 `dropped` 并带上理由。
 * 宽松解析的代价是把旁白、解释、半截 JSON 当成"选项"塞给用户，
 * 而那比空手更坏——用户会以为那是真的建议。
 *
 * @returns {{items: {text:string}[], dropped: {line:string, why:string}[], note:string}}
 */
export function parseSuggestions(text) {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return { items: [], dropped: [{ line: "(空)", why: "模型没给内容" }], note: "模型返回空" };
  }

  // 一眼看出不是行动清单的：直接判失败，不猜。
  if (/^[[{]/.test(raw) || raw.includes("```")) {
    return {
      items: [],
      dropped: [{ line: raw.slice(0, 80), why: "看起来是 JSON / 代码块，不是行动清单" }],
      note: "格式不对：给的是结构化文本，不是列表"
    };
  }

  const items = [];
  const dropped = [];
  const seen = new Set();

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;

    const m = t.match(/^(?:[-*•·]|\d+[.)、])\s*(.+)$/);
    if (!m) {
      // 没有项目符号的行，通常就是模型多写的一句解释。丢掉并记下——不猜。
      if (items.length > 0 || dropped.length < 6) {
        dropped.push({ line: t.slice(0, 60), why: "不是列表项（没有 `- ` 前缀）" });
      }
      continue;
    }

    const clean = normalizeSuggestionText(m[1]);
    if (clean.length < 2) { dropped.push({ line: t.slice(0, 60), why: "太短" }); continue; }

    const key = clean.replace(/[\s，。、！？,.!?~～]/g, "");
    if (seen.has(key)) { dropped.push({ line: t.slice(0, 60), why: "与前面重复" }); continue; }
    if (items.length >= SUGGESTION_LIMIT) { dropped.push({ line: t.slice(0, 60), why: `超出上限 ${SUGGESTION_LIMIT} 条` }); continue; }

    seen.add(key);
    items.push({ text: clean.slice(0, PER_ITEM_MAX) });
  }

  let note = "";
  if (items.length === 0) note = "一条可用的选项都没有";
  else if (items.length < SUGGESTION_LIMIT) note = `只给到 ${items.length} 条（要的是 ${SUGGESTION_LIMIT} 条）`;

  return { items, dropped, note };
}
