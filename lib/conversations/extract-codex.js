// lib/conversations/extract-codex.js — C1 二期：正文 → 图鉴待确认区
//
// 每轮正文返回后，异步（fire-and-forget）跑一次抽取，把候选实体推进
// 图鉴的**待确认区**——pending: true + source: "extract"。
//
// 三条红线（与 summary-llm 同根）：
//   ① 抽取 prompt 写死「只许从正文提取，不许新增正文没有的人物/地点/关系」
//   ② 抽出来的条目**绝不自动转正**——用户点头（删掉 pending）才进图鉴主表
//   ③ 抽取失败静默（记 console.warn），不影响正文链路；不重试
//
// 幂等：同一名称已存在（不管 pending 与否）→ 不造新条目。
//   · 已存在 + pending → 更新 updatedAt 与本次提到的字段（不改用户已填的值）
//   · 已存在 + 非 pending → 完全跳过
//
// 关系抽取的两端**用名字**（不是 id）——后端做名字→id 联表；解析不到就丢弃。
//   这样模型不必理解我们的 id 前缀（p_/pl_/f_），也不会因为猜错前缀把关系挂到
//   一个不存在的实体上。
//
// 用途：走 summary 那一路模型（短、稳、便宜，与前情提要是同一种"抽取"性质）。

import { codexExtractPrompt, parseCodexExtract } from "../gen/prompt.js";
import { CodexSource } from "../codex/model.js";

/** 一次抽取的上限：正文太长的话先截——图鉴抽取看的是"这一刻新增了什么"，不看全文。 */
const MAX_BODY_CHARS = 4000;

/**
 * 把名字做**匹配用**的归一（大小写、全角空格、常见空白）。
 *
 * 与"显示用"的名字分离——图鉴里存原名，匹配时才归一。
 */
function normName(s) {
  return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** 抽出现有实体的名字（用于回填 prompt 的「已收录名单」）。 */
function existingNames(rows, key = "name") {
  return (Array.isArray(rows) ? rows : [])
    .map(r => String(r?.[key] || "").trim())
    .filter(Boolean);
}

/** 关系边的可读标签：`A —kind→ B`。 */
function relationLabel(r) {
  const dir = r?.direction === "directed" ? "→" : r?.direction === "reverse" ? "←" : "—";
  return `${r?.from || "?"} ${dir} ${r?.to || "?"}（${r?.kind || "未定"}）`;
}

/**
 * 主入口：抽取一次 → 落图鉴 → 静默失败。
 *
 * 全部包一层 try/catch：任何一步（LLM 调用、解析、写入）失败都只记 console，
 * 不抛给调用方——正文链路已经发出去了，抽取失败不该让"这一轮"变成红色的。
 *
 * @param {{llm: object, text: string, codexRepo: object, conversationId: string, characterName?: string, modelTarget?: object|null}} args
 */
export async function extractCodexEntities({ llm, text, codexRepo, conversationId, characterName = "", modelTarget = null }) {
  if (!llm || typeof llm.generate !== "function") return { skipped: "llm not ready" };
  if (!codexRepo) return { skipped: "no codexRepo" };
  if (!text || typeof text !== "string") return { skipped: "empty text" };

  const body = text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) + "…" : text;

  try {
    // 1. 拉现有名单（世界级 + 对话级），用于「已收录」清单与幂等比对
    const persons = await codexRepo.list("persons", conversationId).catch(() => []);
    const places = await codexRepo.list("places", conversationId).catch(() => []);
    const relations = await codexRepo.list("relations", conversationId).catch(() => []);

    // 2. 构造 prompt
    const { systemPrompt, messages } = codexExtractPrompt({
      text: body,
      characterName,
      existing: {
        persons: existingNames(persons),
        places: existingNames(places),
        relations: (Array.isArray(relations) ? relations : []).map(relationLabel)
      }
    });

    // 3. 调模型（走 summary 那一档：短、稳、便宜）
    const r = await llm.generate(messages, { systemPrompt, maxTokens: 1500, temperature: 0, target: modelTarget || null });
    const raw = r?.content ?? "";

    // 4. 严格解析
    const parsed = parseCodexExtract(raw);

    // 5. 幂等落盘
    const created = await commitParsed(parsed, codexRepo, conversationId);

    return { ok: true, created, raw: raw.length > 400 ? `${raw.slice(0, 400)}…` : raw };
  } catch (e) {
    // 静默：console 记一行，正文链路不受影响
    console.warn(`[extract-codex] 本轮抽取失败 conv=${conversationId}: ${e?.message || e}`);
    return { ok: false, why: e?.message || String(e) };
  }
}

/**
 * 把解析结果落进图鉴。**幂等**：同名不重复。
 *
 * 顺序：先落 persons / places，把新 id 收集成 name→id 映射；
 *       再拿这份映射去解析 relations 的两端。任一端解不到 → 丢这条边。
 *
 * @returns {Promise<{persons: number, places: number, relations: number, skippedRelations: number}>}
 */
async function commitParsed(parsed, codexRepo, conversationId) {
  const stats = { persons: 0, places: 0, relations: 0, skippedRelations: 0 };

  // ── 人物 ───────────────────────────────────
  const personNameToId = new Map();   // normName → id
  for (const p of await codexRepo.list("persons", conversationId)) {
    if (p?.name) personNameToId.set(normName(p.name), p.id);
  }

  for (const c of (parsed?.persons || [])) {
    const name = typeof c?.name === "string" ? c.name.trim() : "";
    if (!name) continue;
    const key = normName(name);

    const existing = [...personNameToId.entries()].find(([k]) => k === key);
    if (existing) {
      // 已存在 → 跳过（不覆盖用户可能已填的字段；确认/丢弃由 UI 走）
      continue;
    }

    const created = await codexRepo.create("persons", {
      name,
      lifespan: "chat",
      attitude: typeof c.attitude === "string" ? c.attitude.trim() : "",
      status: typeof c.status === "string" ? c.status.trim() : "",
      tags: Array.isArray(c.tags) ? c.tags.map(x => String(x).trim()).filter(Boolean) : [],
      source: CodexSource.EXTRACT,
      pending: true
    }, conversationId);
    if (created?.id) {
      personNameToId.set(key, created.id);
      stats.persons++;
    }
  }

  // ── 地点 ───────────────────────────────────
  const placeNameToId = new Map();
  for (const p of await codexRepo.list("places", conversationId)) {
    if (p?.name) placeNameToId.set(normName(p.name), p.id);
  }

  for (const c of (parsed?.places || [])) {
    const name = typeof c?.name === "string" ? c.name.trim() : "";
    if (!name) continue;
    const key = normName(name);

    const existing = [...placeNameToId.entries()].find(([k]) => k === key);
    if (existing) continue;

    const created = await codexRepo.create("places", {
      name,
      lifespan: "chat",
      description: typeof c.description === "string" ? c.description.trim() : "",
      situation: typeof c.situation === "string" ? c.situation.trim() : "",
      tendency: typeof c.tendency === "string" ? c.tendency.trim() : "",
      source: CodexSource.EXTRACT,
      pending: true
    }, conversationId);
    if (created?.id) {
      placeNameToId.set(key, created.id);
      stats.places++;
    }
  }

  // ── 关系 ───────────────────────────────────
  // 名字 → 前缀 id：人物优先（p_），其次地点（pl_），势力（f_）暂时不抽。
  const nameToPrefixed = new Map();
  for (const [k, id] of personNameToId) nameToPrefixed.set(k, `p_${id}`);
  for (const [k, id] of placeNameToId) {
    if (!nameToPrefixed.has(k)) nameToPrefixed.set(k, `pl_${id}`);
  }

  // 已有关系（防止同一 A→B→kind 重复）
  const existingRelKeys = new Set();
  for (const r of await codexRepo.list("relations", conversationId)) {
    existingRelKeys.add(`${normName(r?.from)}\u0000${normName(r?.to)}\u0000${normName(r?.kind)}`);
  }

  for (const c of (parsed?.relations || [])) {
    const fromName = typeof c?.from === "string" ? c.from.trim() : "";
    const toName = typeof c?.to === "string" ? c.to.trim() : "";
    if (!fromName || !toName) { stats.skippedRelations++; continue; }

    const fromKey = normName(fromName);
    const toKey = normName(toName);
    if (fromKey === toKey) { stats.skippedRelations++; continue; }   // 不建自环

    const fromId = nameToPrefixed.get(fromKey);
    const toId = nameToPrefixed.get(toKey);
    if (!fromId || !toId) {
      // 一端名字解不到实体 → 丢这条边（宁可少，不要编 id）
      stats.skippedRelations++;
      continue;
    }

    const kind = typeof c.kind === "string" ? c.kind.trim() : "";
    const note = typeof c.note === "string" ? c.note.trim() : "";
    const direction = ["directed", "reverse", "undirected"].includes(c.direction) ? c.direction : "undirected";

    const dedupeKey = `${fromKey}\u0000${toKey}\u0000${normName(kind)}`;
    if (existingRelKeys.has(dedupeKey)) continue;

    const created = await codexRepo.create("relations", {
      lifespan: "chat",
      from: fromId,
      to: toId,
      kind,
      direction,
      note,
      source: CodexSource.EXTRACT,
      pending: true
    }, conversationId);
    if (created?.id) {
      existingRelKeys.add(dedupeKey);
      stats.relations++;
    }
  }

  return stats;
}
