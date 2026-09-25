// lib/gen/extract.js — 调用一：原文 → 事实清单
//
// 这一步唯一的纪律是 **fail closed**：挂不上出处的事实一律丢掉。
// 留一条没出处的事实，整个"可复核"的承诺就作废了——用户没法再信
// 剩下的条目，因为分不清哪条有据、哪条是模型顺手写的。

import { extractPrompt, parseJsonStrict } from "./prompt.js";

const TIERS = new Set(["encyclopedia", "official", "community"]);

/**
 * 规范化一条事实。不合形状就返回 null（调用方计数后丢弃）。
 * 导出是为了单测能单独钉形状规则。
 */
export function normalizeFact(item) {
  if (!item || typeof item !== "object") return null;
  const fact = String(item.fact ?? "").trim();
  if (!fact) return null;

  const src = item.source && typeof item.source === "object" ? item.source : {};
  const url = String(src.url ?? "").trim();
  if (!url) return null;                       // 没出处 → 丢

  return {
    fact,
    source: {
      url,
      title: String(src.title ?? "").trim(),
      tier: TIERS.has(src.tier) ? src.tier : "community"
    }
  };
}

/**
 * @param {{query: string, docs: object[], llm: object}} args
 * @returns {Promise<{facts: object[], dropped: number, raw: string}>}
 */
export async function extractFacts({ query, docs, llm }) {
  if (!llm || typeof llm.generate !== "function") throw new Error("模型服务未就绪");

  const { systemPrompt, messages } = extractPrompt({ query, docs });
  const r = await llm.generate(messages, { systemPrompt });
  const raw = r?.content ?? "";
  const arr = parseJsonStrict(raw, { expect: "array", what: "抽取结果" });

  const facts = [];
  let dropped = 0;
  for (const item of arr) {
    const f = normalizeFact(item);
    if (f) facts.push(f);
    else dropped++;
  }
  return { facts, dropped, raw };
}
