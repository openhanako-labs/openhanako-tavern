// lib/recall/index.js — 倒排索引 + 关键词抽取 + 预热召回 orchestrator
//
// 三层：
//   ① 索引层（InvertedIndex）：内存倒排，中文 bigram + 英文分词。
//      名字/标题字段权重高于正文（title 3.0 / name 2.5 / body 1.0）。
//   ② 构建层（buildIndex）：从 characterRepo / settingRepo / conversationRepo 建索引。
//      一次性快照——不跟随实时变更（本单不做增量）。
//   ③ 编排层（recall）：抽关键词 → 预热检索 → 高置信直注入 / 低置信进 ReAct 循环。
//
// 与记忆面板的边界：
//   · lib/memory/config.js 管 recallEnabled / recallBudget / recallMaxLoops 三格。
//   · 本文件读这些值跑召回，写不了任何配置。
//
// 静默降级契约：
//   recall() 的任何异常都返回 { injected: false }，**绝不抛**。
//   注入失败 = 现状，不能因为多这一步就阻断发消息。

import { RecallContext } from "./context.js";
import { runRecallLoop } from "./loop.js";

// ── 权重 ─────────────────────────────────────────────
export const FIELD_WEIGHTS = {
  title: 3.0,
  name: 2.5,
  body: 1.0
};

// 中英文停用词（够小就够，不要过度设计）
const EN_STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall", "should",
  "can", "could", "may", "might", "must",
  "i", "you", "he", "she", "it", "we", "they",
  "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their",
  "this", "that", "these", "those", "there", "here",
  "what", "which", "who", "whom", "whose", "when", "where", "why", "how",
  "all", "any", "both", "each", "few", "more", "most", "other", "some", "such",
  "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very",
  "just", "because", "but", "and", "or", "if", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "as", "about", "against", "between", "into",
  "through", "during", "before", "after", "above", "below", "up", "down",
  "out", "off", "over", "under", "again", "further", "then", "once", "also"
]);

const ZH_STOPWORDS = new Set([
  "的", "了", "是", "在", "我", "你", "他", "她", "它", "我们", "你们", "他们",
  "她们", "这", "那", "这", "那", "这个", "那个", "什么", "怎么", "为什么",
  "呢", "吗", "啊", "吧", "呀", "哦", "嗯", "不", "没有", "有", "和", "或",
  "被", "把", "让", "跟", "同", "给", "向", "从", "到", "对", "于", "之"
]);

// ── 分词 ─────────────────────────────────────────────

/**
 * 混合分词：CJK 用 bigram（单字也收），Latin 按 [a-z0-9_]{2,} 切。
 *
 * 为什么不用 trigram：bigram 已经能覆盖绝大多数中文词，
 * trigram 内存翻三倍，收益不匹配。
 *
 * 为什么 Latin 最小 2 字：单字符噪声太大，不值得。
 *
 * 返回**去重**后的数组，顺序无关。
 */
export function tokenize(text) {
  const s = String(text ?? "").toLowerCase();
  if (!s) return [];
  const out = new Set();

  // CJK runs（含中日韩统一表意 + 假名 + 谚文）
  const cjkRuns = s.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      out.add(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) {
        out.add(run.slice(i, i + 2));
      }
    }
  }

  // Latin words
  const latinWords = s.match(/[a-z0-9_]{2,}/g) || [];
  for (const w of latinWords) out.add(w);

  return [...out];
}

/** 去掉停用词。CJK 单字也一并去（除非它是唯一的词）。 */
export function dropStopwords(tokens) {
  const out = [];
  for (const t of tokens) {
    if (EN_STOPWORDS.has(t) || ZH_STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

/**
 * 从用户输入抽关键词。
 *
 * 策略：先 tokenize 再 drop stopwords，剩下的按长度降序（长词更独特，
 * 短词往往是虚词残片）。最多取前 maxWords 个。
 */
export function extractKeywords(text, { maxWords = 15 } = {}) {
  const raw = tokenize(text);
  const cleaned = dropStopwords(raw);
  // 按长度降序、字典序兜底
  const sorted = cleaned.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return sorted.slice(0, maxWords);
}

// ── 倒排索引 ─────────────────────────────────────────

export class InvertedIndex {
  constructor() {
    /** @type {Map<string, object>} */
    this.entries = new Map();
    /** @type {Map<string, Map<string, number>>} token -> (id -> weight) */
    this.posts = new Map();
  }

  get size() { return this.entries.size; }

  /**
   * 加一个条目。id 必须唯一。
   * @param {object} entry { id, title?, name?, body?, kind?, ...meta }
   */
  addEntry(entry) {
    const id = String(entry?.id ?? "");
    if (!id) return;
    const title = String(entry.title ?? "");
    const name = String(entry.name ?? "");
    const body = String(entry.body ?? "");
    const stored = {
      id,
      title,
      name,
      body,
      kind: String(entry.kind ?? "general"),
      sourceId: String(entry.sourceId ?? ""),
      characterId: entry.characterId != null ? String(entry.characterId) : null,
      // 存原始 meta 备查（不要存 body 以外的长字符串，避免爆内存）
      meta: entry.meta && typeof entry.meta === "object" ? entry.meta : {}
    };
    this.entries.set(id, stored);

    const fields = [
      { text: title, weight: FIELD_WEIGHTS.title },
      { text: name,  weight: FIELD_WEIGHTS.name },
      { text: body,  weight: FIELD_WEIGHTS.body }
    ];
    for (const f of fields) {
      if (!f.text) continue;
      for (const tok of tokenize(f.text)) {
        let mp = this.posts.get(tok);
        if (!mp) { mp = new Map(); this.posts.set(tok, mp); }
        mp.set(id, (mp.get(id) || 0) + f.weight);
      }
    }
  }

  /**
   * 检索。keywords 可以是数组或字符串。
   * 返回按 score 降序的候选条目数组，每项含 { id, score, ...entry }。
   */
  search(keywords, opts = {}) {
    const kws = Array.isArray(keywords) ? keywords : [keywords];
    const topK = Number(opts.topK) > 0 ? Math.floor(Number(opts.topK)) : 10;
    const characterId = opts.characterId != null ? String(opts.characterId) : null;

    const tokens = new Set();
    for (const kw of kws) {
      for (const t of tokenize(kw)) tokens.add(t);
    }
    if (tokens.size === 0) return [];

    const scores = new Map(); // id -> score
    for (const tok of tokens) {
      const mp = this.posts.get(tok);
      if (!mp) continue;
      for (const [id, w] of mp) {
        scores.set(id, (scores.get(id) || 0) + w);
      }
    }
    if (scores.size === 0) return [];

    const results = [];
    for (const [id, score] of scores) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      // 按 characterId 过滤（可选）
      if (characterId && entry.characterId && entry.characterId !== characterId) continue;
      results.push({ id, score, ...entry });
    }
    results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return results.slice(0, topK);
  }

  /** 取完整条目（供 read_entry 用）。 */
  getEntry(id) {
    return this.entries.get(String(id ?? "")) || null;
  }
}

/**
 * 从仓储对象构索引。缺一个 repo 就跳过那一路，不报错。
 *
 * @param {object} opts
 * @param {object} [opts.characterRepo]
 * @param {object} [opts.settingRepo]
 * @param {object} [opts.conversationRepo]
 * @param {number} [opts.messagesPerConv=50]   每段对话抽进索引的最末 N 条消息
 * @param {object[]} [opts.characters]          直接给列表（测试用）
 * @param {object[]} [opts.settings]            直接给列表（测试用）
 * @param {object[]} [opts.conversations]       直接给列表（测试用）
 */
export function buildIndex(opts = {}) {
  const idx = new InvertedIndex();
  const { characterRepo, settingRepo, conversationRepo } = opts;
  const messagesPerConv = Number(opts.messagesPerConv) > 0
    ? Math.floor(Number(opts.messagesPerConv)) : 50;

  // 角色卡
  const characters = opts.characters ?? (characterRepo ? characterRepo.list() : []);
  for (const c of Array.isArray(characters) ? characters : []) {
    let card;
    if (c && typeof c.get === "function") continue; // 只吃摘要，不用 repo
    // 注入模式：直接传完整卡（有 name 或 description 或 description 以外任一个）
    if (c && typeof c.id === "string" && (typeof c.name === "string" || typeof c.description === "string")) {
      card = c;
    } else if (characterRepo && c && typeof c.id === "string") {
      try { card = characterRepo.get ? characterRepo.get(c.id) : null; } catch { card = null; }
    }
    if (!card || typeof card !== "object") continue;
    idx.addEntry({
      id: `char:${card.id}`,
      title: card.name || "",
      name: card.name || "",
      body: [
        card.description, card.personality, card.scenario,
        card.first_mes, card.system_prompt, card.mes_example
      ].filter(Boolean).join("\n"),
      kind: "character",
      sourceId: card.id,
      characterId: card.id
    });
  }

  // 世界书（settings）
  const settings = opts.settings ?? (settingRepo ? settingRepo.list() : []);
  for (const s of Array.isArray(settings) ? settings : []) {
    if (!s || s.enabled === false) continue;
    if (typeof s.id !== "string" || !s.id) continue;
    const keys = [
      ...(Array.isArray(s.keywords) ? s.keywords : []),
      ...(Array.isArray(s.secondaryKeys) ? s.secondaryKeys : []),
      ...(Array.isArray(s.groupKeys) ? s.groupKeys : [])
    ].join(" ");
    idx.addEntry({
      id: `lore:${s.id}`,
      title: s.name || "",
      name: keys,
      body: String(s.content ?? ""),
      kind: "lore",
      sourceId: s.id,
      characterId: s.characterId != null ? String(s.characterId) : null
    });
  }

  // 对话历史
  const conversations = opts.conversations ?? (conversationRepo ? conversationRepo.list() : []);
  for (const c of Array.isArray(conversations) ? conversations : []) {
    let conv;
    if (c && typeof c.get === "function") continue;
    if (c && typeof c.messages === "object" && c.messages) {
      conv = c;
    } else if (conversationRepo && c && typeof c.id === "string") {
      try { conv = conversationRepo.get ? conversationRepo.get(c.id) : null; } catch { conv = null; }
    }
    if (!conv || typeof conv !== "object") continue;
    const msgs = Array.isArray(conv.messages) ? conv.messages.slice(-messagesPerConv) : [];
    const body = msgs
      .filter(m => m && typeof m.content === "string")
      .map(m => `${m.role}: ${m.content}`)
      .join("\n");
    idx.addEntry({
      id: `conv:${conv.id}`,
      title: conv.title || conv.characterName || "",
      body,
      kind: "conversation",
      sourceId: conv.id,
      characterId: conv.characterId != null ? String(conv.characterId) : null
    });
  }

  return idx;
}

// ── 编排：预热 → 高置信直注 / 低置信进循环 ─────────

/**
 * 把条目渲染成 system 消息的证据文本。
 */
function renderEvidence(entries) {
  if (!entries || entries.length === 0) return "";
  const parts = entries.map((e, i) => {
    const header = `[${i + 1}] ${e.kind || "entry"}${e.title ? " · " + e.title : ""} (score=${e.score})`;
    // 正文截到 1200 字符，太长就丢
    const body = String(e.body ?? "").slice(0, 1200);
    return `${header}\n${body || "(空)"}`;
  });
  return parts.join("\n\n");
}

/**
 * 判断是否高置信：最高分 >= threshold，且最高分 >= ratio × 次高分。
 * 只有一条结果时也认（次高分按 0 处理）。
 */
export function isHighConfidence(results, { threshold = 5, ratio = 2 } = {}) {
  if (!results || results.length === 0) return false;
  const top = Number(results[0].score) || 0;
  if (top < threshold) return false;
  const second = results.length > 1 ? (Number(results[1].score) || 0) : 0;
  return second === 0 || top >= ratio * second;
}

/**
 * 主入口：跑一次预热召回。
 *
 * @param {object} opts
 * @param {string} opts.input              用户输入原文
 * @param {object} [opts.characterId]      当前角色 id（用于过滤）
 * @param {object} [opts.llm]              LLM 服务（低置信路径需要）
 * @param {object} [opts.characterRepo]
 * @param {object} [opts.settingRepo]
 * @param {object} [opts.conversationRepo]
 * @param {object} [opts.characters]        直注列表（测试用）
 * @param {object} [opts.settings]          直注列表（测试用）
 * @param {object} [opts.conversations]     直注列表（测试用）
 * @param {number} [opts.messagesPerConv]
 * @param {boolean} [opts.enabled=true]     关掉时直接返回 { injected: false }
 * @param {number} [opts.budget=8000]       ReAct 预算
 * @param {number} [opts.maxLoops=3]        ReAct 循环上限
 * @param {number} [opts.confidenceRatio=2] 高置信判定：top >= ratio × second
 * @param {number} [opts.confidenceMin=5]   高置信判定的绝对阈值
 * @param {object} [opts.target]            LLM target
 * @returns {Promise<{injected: boolean, evidence?: string, mode?: "direct"|"loop"|"skip", meta?: object}>}
 */
export async function recall(opts = {}) {
  // 契约：任何错误都静默降级为"不注入"
  try {
    if (opts.enabled === false) {
      return { injected: false, mode: "skip" };
    }
    const input = String(opts.input ?? "");
    if (!input.trim()) return { injected: false, mode: "skip" };

    const idx = buildIndex(opts);
    if (idx.size === 0) return { injected: false, mode: "skip" };

    const keywords = extractKeywords(input);
    if (keywords.length === 0) return { injected: false, mode: "skip" };

    const confidenceRatio = Number(opts.confidenceRatio) > 0 ? Number(opts.confidenceRatio) : 2;
    const confidenceMin = Number(opts.confidenceMin) > 0 ? Number(opts.confidenceMin) : 5;

    const results = idx.search(keywords, {
      topK: 5,
      characterId: opts.characterId != null ? String(opts.characterId) : null
    });
    if (results.length === 0) return { injected: false, mode: "skip" };

    // 高置信：直注（不调 LLM）
    if (isHighConfidence(results, { ratio: confidenceRatio, threshold: confidenceMin })) {
      const evidence = renderEvidence(results.slice(0, 3));
      return {
        injected: true,
        mode: "direct",
        evidence,
        meta: {
          keywords,
          topScore: results[0].score,
          secondScore: results[1]?.score ?? 0,
          hits: results.length,
          injectedIds: results.slice(0, 3).map(r => r.id)
        }
      };
    }

    // 低置信：进 ReAct 循环
    if (!opts.llm || typeof opts.llm.generate !== "function") {
      // 没有 LLM 也注入预热候选——比什么都不给强
      const evidence = renderEvidence(results.slice(0, 3));
      return {
        injected: true,
        mode: "direct",
        evidence,
        meta: { keywords, hits: results.length, note: "no llm; using warmup only" }
      };
    }

    const budget = Number(opts.budget) > 0 ? Number(opts.budget) : 8000;
    const maxLoops = Number(opts.maxLoops) > 0 ? Number(opts.maxLoops) : 3;
    const ctx = new RecallContext({ maxTokenBudget: budget, maxLoops });

    const preloadedEvidence = renderEvidence(results.slice(0, 3));
    const { answer, ctx: finalCtx } = await runRecallLoop({
      llm: opts.llm,
      index: idx,
      ctx,
      query: input,
      initialKeywords: keywords,
      preloadedEvidence,
      target: opts.target || null
    });

    if (!answer || !answer.trim()) {
      // 循环没吐出来——回落到预热候选（还是比什么都不给强）
      return {
        injected: true,
        mode: "direct",
        evidence: preloadedEvidence,
        meta: {
          keywords,
          hits: results.length,
          loopSkipped: "empty answer",
          ctx: { summary: finalCtx.summary() }
        }
      };
    }

    return {
      injected: true,
      mode: "loop",
      evidence: answer,
      meta: {
        keywords,
        hits: results.length,
        ctx: {
          summary: finalCtx.summary(),
          budgetRemaining: finalCtx.budgetRemaining,
          loopCount: finalCtx.loopCount,
          telemetry: finalCtx.telemetry
        }
      }
    };
  } catch (e) {
    return {
      injected: false,
      mode: "skip",
      meta: { error: String(e?.message || e) }
    };
  }
}

export default InvertedIndex;
