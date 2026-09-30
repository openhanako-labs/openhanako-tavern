// lib/codex/model.js — 图鉴（C1）三张表：人物 / 地点 / 势力
//
// 三张表共用「寿命两级」的存储规矩（world / chat），字段各自成表。
// 与 board 的差异：
//   · board 是「此刻」，图鉴是「累计」——所以图鉴没有开关，没有激活条件
//   · board 的可见性有三层（public / user / char:*），图鉴是读者的世界 Wiki，
//     没有分角色可见——一张表读的人只有一个：玩家（读者）
//
// 三条硬规矩（都写在 data-model.md 里）：
//   1. **图鉴 ≠ 角色卡**：`characterId` 只是引用，不嵌套卡的内容
//   2. **notes 追加制**：图鉴的价值在时间纵深，覆写等于失忆
//   3. **affinity 可空**：未知就是未知，不编 0
//
// source 字段：manual / extract / import 三个枚举。
// pending：C1-2 二期开的口子——从正文抽出来的候选一律 pending=true，
//   UI 黄点提示，用户点头（删掉 pending）才转正；绝不自动转正（模型会编，
//   编一条假人物进图鉴比没有更糟——与摘要那三条防编红线同源）。

import crypto from "node:crypto";

/** 寿命两级：world = 跨对话共享；chat = 只在这场。 */
export const CodexLifespan = {
  WORLD: "world",
  CHAT: "chat"
};

/** 三条写入来源（本仓库只写 "manual"，其余为占位——二期 extract 那批进来时开）。 */
export const CodexSource = {
  MANUAL: "manual",
  EXTRACT: "extract",
  IMPORT: "import"
};

const LIFESPANS = new Set(Object.values(CodexLifespan));
const SOURCES = new Set(Object.values(CodexSource));

// 好感度上下限（-100 ~ 100）。数值型字段直接判数值，字符串数字也收。
function affinityOrEmpty(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || Number.isNaN(n)) return null;
  return Math.min(100, Math.max(-100, Math.round(n)));
}

/** 追加制列表：只收 {at, convId, text}，坏条目跳过。 */
function normalizeNotes(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter(n => n && typeof n === "object" && typeof n.text === "string" && n.text.trim())
    .map(n => ({
      at: typeof n.at === "string" ? n.at : new Date().toISOString(),
      convId: typeof n.convId === "string" && n.convId ? n.convId : null,
      text: String(n.text)
    }));
}

/** 字符串数组：只留非空字符串。 */
function strArr(v) {
  if (!Array.isArray(v)) return [];
  return v.map(x => String(x ?? "").trim()).filter(Boolean);
}

/** 首次见面：null 或 {convId, at}。缺 at 就补当前时间。 */
function normalizeFirstMet(v) {
  if (!v || typeof v !== "object") return null;
  const out = {
    convId: typeof v.convId === "string" && v.convId ? v.convId : null,
    at: typeof v.at === "string" && v.at ? v.at : new Date().toISOString()
  };
  return out;
}

// ── persons ──────────────────────────────────────────

/** 新建一个人物条目。id 由外部生成，这里补默认字段。 */
export function createPerson(overrides = {}) {
  return normalizePerson({
    id: crypto.randomUUID(),
    name: "",
    lifespan: CodexLifespan.WORLD,
    aliases: [],
    characterId: null,
    firstMet: null,
    attitude: "",
    status: "",
    affinity: null,
    tags: [],
    notes: [],
    source: CodexSource.MANUAL,
    pending: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  });
}

export function normalizePerson(p) {
  if (!p || typeof p !== "object") return p;
  const out = { ...p };

  out.id = typeof out.id === "string" && out.id ? out.id : crypto.randomUUID();
  out.name = typeof out.name === "string" ? out.name : "";
  out.lifespan = LIFESPANS.has(out.lifespan) ? out.lifespan : CodexLifespan.WORLD;

  out.aliases = strArr(out.aliases);
  out.characterId = typeof out.characterId === "string" && out.characterId ? out.characterId : null;
  out.firstMet = normalizeFirstMet(out.firstMet);

  out.attitude = typeof out.attitude === "string" ? out.attitude : "";
  out.status = typeof out.status === "string" ? out.status : "";
  out.affinity = affinityOrEmpty(out.affinity);
  out.tags = strArr(out.tags);
  out.notes = normalizeNotes(out.notes);

  out.source = SOURCES.has(out.source) ? out.source : CodexSource.MANUAL;
  // pending 只认真值："true" / 1 / "yes" 都当 false——防 extract 侧偷懒写字符串。
  out.pending = out.pending === true;
  out.createdAt = typeof out.createdAt === "string" ? out.createdAt : new Date().toISOString();
  out.updatedAt = typeof out.updatedAt === "string" ? out.updatedAt : new Date().toISOString();

  return out;
}

// ── places ───────────────────────────────────────────

export function createPlace(overrides = {}) {
  return normalizePlace({
    id: crypto.randomUUID(),
    name: "",
    lifespan: CodexLifespan.WORLD,
    parentId: null,
    description: "",
    situation: "",
    tendency: "",
    source: CodexSource.MANUAL,
    pending: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  });
}

export function normalizePlace(p) {
  if (!p || typeof p !== "object") return p;
  const out = { ...p };

  out.id = typeof out.id === "string" && out.id ? out.id : crypto.randomUUID();
  out.name = typeof out.name === "string" ? out.name : "";
  out.lifespan = LIFESPANS.has(out.lifespan) ? out.lifespan : CodexLifespan.WORLD;
  out.parentId = typeof out.parentId === "string" && out.parentId ? out.parentId : null;

  // description（静态描述）与 situation（当前局势）分两格——局势每轮可能变，描述不该跟着抖。
  out.description = typeof out.description === "string" ? out.description : "";
  out.situation = typeof out.situation === "string" ? out.situation : "";
  out.tendency = typeof out.tendency === "string" ? out.tendency : "";

  out.source = SOURCES.has(out.source) ? out.source : CodexSource.MANUAL;
  out.pending = out.pending === true;
  out.createdAt = typeof out.createdAt === "string" ? out.createdAt : new Date().toISOString();
  out.updatedAt = typeof out.updatedAt === "string" ? out.updatedAt : new Date().toISOString();

  return out;
}

// ── factions ─────────────────────────────────────────

/** 势力：轻表——四格（id / name / description / tags）。 */
export function createFaction(overrides = {}) {
  return normalizeFaction({
    id: crypto.randomUUID(),
    name: "",
    lifespan: CodexLifespan.WORLD,
    description: "",
    tags: [],
    source: CodexSource.MANUAL,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  });
}

export function normalizeFaction(f) {
  if (!f || typeof f !== "object") return f;
  const out = { ...f };

  out.id = typeof out.id === "string" && out.id ? out.id : crypto.randomUUID();
  out.name = typeof out.name === "string" ? out.name : "";
  out.lifespan = LIFESPANS.has(out.lifespan) ? out.lifespan : CodexLifespan.WORLD;
  out.description = typeof out.description === "string" ? out.description : "";
  out.tags = strArr(out.tags);

  out.source = SOURCES.has(out.source) ? out.source : CodexSource.MANUAL;
  out.createdAt = typeof out.createdAt === "string" ? out.createdAt : new Date().toISOString();
  out.updatedAt = typeof out.updatedAt === "string" ? out.updatedAt : new Date().toISOString();

  return out;
}

// ── relations ───────────────────────────────
//
// 关系边表。from/to 都是带前缀的 id（p_/pl_/f_）：
//   p_   → 人物（persons 表里的 entry）
//   pl_  → 地点（places 表里的 entry）
//   f_   → 势力（factions 表里的 entry）
// 前缀不硬验——关系图可能连不存在的实体（待建、已删），
// 验了会误拦“写下来先，人后补”的场景。
//
// kind 不做死枚举：师徒 / 宿敌 / 同盟 / 隶属……写自由。
// strength 可空：有些关系只是“存在”，强弱未定。

/** 关系边 id 前缀。 */
export const RelationIdPrefix = {
  PERSON: "p_",
  PLACE: "pl_",
  FACTION: "f_"
};

export function createRelation(overrides = {}) {
  return normalizeRelation({
    id: crypto.randomUUID(),
    lifespan: CodexLifespan.WORLD,
    from: "",
    to: "",
    kind: "",
    direction: "undirected",
    strength: null,
    note: "",
    source: CodexSource.MANUAL,
    pending: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  });
}

export function normalizeRelation(r) {
  if (!r || typeof r !== "object") return r;
  const out = { ...r };

  out.id = typeof out.id === "string" && out.id ? out.id : crypto.randomUUID();
  out.lifespan = LIFESPANS.has(out.lifespan) ? out.lifespan : CodexLifespan.WORLD;

  out.from = typeof out.from === "string" ? out.from : "";
  out.to = typeof out.to === "string" ? out.to : "";
  out.kind = typeof out.kind === "string" ? out.kind : "";

  // direction 三枚举：单向（from→to）/反向（to→from 的弱引用）/双向（无向）。默认无向。
  if (!out.direction || !["directed", "reverse", "undirected"].includes(out.direction)) {
    out.direction = "undirected";
  }

  // strength: -100 ~ 100，允许 null（未知）
  out.strength = affinityOrEmpty(out.strength);

  out.note = typeof out.note === "string" ? out.note : "";

  out.source = SOURCES.has(out.source) ? out.source : CodexSource.MANUAL;
  out.pending = out.pending === true;
  out.createdAt = typeof out.createdAt === "string" ? out.createdAt : new Date().toISOString();
  out.updatedAt = typeof out.updatedAt === "string" ? out.updatedAt : new Date().toISOString();

  return out;
}

// ── powers ───────────────────────────────────
//
// 力量体系：一张表，一行一条“某人某体系的评分”。
// personId 可空——体系可能先存下、人后建（同关系图那个理）。
// system 是“什么体系”，自由文本（魔法 / 武技 / 信仰……）。
// dimensions 是这一体系里有哪些轴（数组），axis 是“当前评到哪根轴”。
// value 可空：未知不编 0（雷达图缺轴就留空——红线）。

export function createPower(overrides = {}) {
  return normalizePower({
    id: crypto.randomUUID(),
    lifespan: CodexLifespan.WORLD,
    personId: null,
    system: "",
    axis: "",
    value: null,
    max: null,
    note: "",
    source: CodexSource.MANUAL,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  });
}

/** 数值归一：只收 number/number-string，其它回 null（不夹到 0）。
 *  注意：Number("") === 0，所以要先拦空串 —— 否则传 "" 会被当成 0。 */
function numOrEmpty(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

export function normalizePower(p) {
  if (!p || typeof p !== "object") return p;
  const out = { ...p };

  out.id = typeof out.id === "string" && out.id ? out.id : crypto.randomUUID();
  out.lifespan = LIFESPANS.has(out.lifespan) ? out.lifespan : CodexLifespan.WORLD;

  out.personId = typeof out.personId === "string" && out.personId ? out.personId : null;
  out.system = typeof out.system === "string" ? out.system : "";
  out.axis = typeof out.axis === "string" ? out.axis : "";

  out.value = numOrEmpty(out.value);
  out.max = numOrEmpty(out.max);

  out.note = typeof out.note === "string" ? out.note : "";

  out.source = SOURCES.has(out.source) ? out.source : CodexSource.MANUAL;
  out.createdAt = typeof out.createdAt === "string" ? out.createdAt : new Date().toISOString();
  out.updatedAt = typeof out.updatedAt === "string" ? out.updatedAt : new Date().toISOString();

  return out;
}

// ── 排序（渲染稳定用） ─────────────────────────────

/** 按 name 升序（localeCompare）；同名同 lifespan 按 id 稳定。 */
export function sortByName(list) {
  return [...(list || [])].sort((a, b) => {
    const r = String(a?.name || "").localeCompare(String(b?.name || ""));
    return r !== 0 ? r : String(a?.id || "").localeCompare(String(b?.id || ""));
  });
}
