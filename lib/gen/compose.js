// lib/gen/compose.js — 调用二：事实清单 → 卡 + 世界书
//
// 喂的是**清单**不是原文（签名上就没有 docs 这个参数）。
// 出了这一步，模型写的每句话都应该能在清单里找到——找不到的交给
// verify.js 删掉。所以这里只做"形状规范化"，不做判断。

import { composePrompt, parseJsonStrict, CARD_FIELDS } from "./prompt.js";

const STRING_FIELDS = CARD_FIELDS.filter((f) => f !== "tags");

/** tags 收数组或逗号分隔的字符串；非字符串一律丢（模型爱塞数字）。 */
function normalizeTags(v) {
  const arr = Array.isArray(v) ? v : String(v ?? "").split(/[,，]/);
  return arr
    .filter((x) => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * 只留白名单字段。
 *
 * 这一层是兼容性铁律的落点：原酒馆卡里还有 system_prompt /
 * post_history_instructions 之类，我们**不生成也不碰**它们——
 * 生成端一旦能写它们，就等于给了模型一条改提示词的暗道。
 */
export function normalizeCard(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const f of STRING_FIELDS) out[f] = String(c[f] ?? "").trim();
  out.tags = normalizeTags(c.tags);
  return out;
}

/** 世界书条目：keys 空或 content 空的丢掉（它们进提示词只会占位）。 */
export function normalizeBook(raw) {
  const entries = Array.isArray(raw?.entries) ? raw.entries : [];
  const out = [];
  let droppedEntries = 0;

  for (const e of entries) {
    const keys = (Array.isArray(e?.keys) ? e.keys : [])
      .map((k) => String(k ?? "").trim())
      .filter(Boolean);
    const content = String(e?.content ?? "").trim();
    if (keys.length === 0 || !content) {
      droppedEntries++;
      continue;
    }
    /*
     * name 不是装饰，是**必需**的。
     *
     * 设定库导入时按 `name::characterId` 去重（lib/settings/repo.js）：
     * 没有 name 的条目全都叫「（无名称）」，于是第二条起会被静默跳过——
     * 生成十条世界书，进库只剩一条，而且哪一步都不报错。
     * 原酒馆的 character_book 条目本来就有 name 字段，是这里先丢的。
     */
    const name = String(e?.name ?? "").trim() || keys[0];
    out.push({
      name,
      keys,
      content,
      position: typeof e?.position === "string" && e.position ? e.position : "before_char"
    });
  }
  return { entries: out, droppedEntries };
}

/**
 * @param {{query: string, facts: object[], llm: object}} args
 * @returns {Promise<{card: object, book: object, droppedEntries: number, raw: string}>}
 */
export async function compose({ query, facts, llm }) {
  if (!llm || typeof llm.generate !== "function") throw new Error("模型服务未就绪");

  const { systemPrompt, messages } = composePrompt({ query, facts });
  const r = await llm.generate(messages, { systemPrompt });
  const raw = r?.content ?? "";
  const parsed = parseJsonStrict(raw, { expect: "object", what: "组装结果" });

  const card = normalizeCard(parsed.card);
  const book = normalizeBook(parsed.book);
  return { card, book, droppedEntries: book.droppedEntries, raw };
}
