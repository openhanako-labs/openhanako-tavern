// lib/characters/model.js — 角色卡数据模型
//
// 定义角色卡字段、创建空卡、验证逻辑。
// 兼容 SillyTavern V2/V3 格式。

import crypto from "node:crypto";

export const CharacterFields = {
  id: "id",
  name: "name",
  description: "description",
  personality: "personality",
  scenario: "scenario",
  first_mes: "first_mes",
  mes_example: "mes_example",
  system_prompt: "system_prompt",
  post_history_instructions: "post_history_instructions",
  creator: "creator",
  creator_notes: "creator_notes",
  character_version: "character_version",
  tags: "tags",
  alternate_greetings: "alternate_greetings",
  character_book: "character_book",
  extensions: "extensions",
  scene: "scene",
  system_prompt_enabled: "system_prompt_enabled",
  created_at: "created_at",
  updated_at: "updated_at"
};

// 硬性必填：只有这一条会拦住导入/保存。
//
// 2026-09-27 从 ["name","description","first_mes"] 放宽到只剩 name：
// 真实的 ST 卡经常不写 description（有名字、有世界书，就是没描述），
// 用必填硬拒等于把「导入别人的卡」这个入口废掉。缺字段的后果不是
//「卡不成立」，是「卡用起来会干」——那是提示该干的活，不是拒绝。
export const RequiredFields = ["name"];

// 推荐字段：缺了不拦，但要在导入预览里说清代价。
export const RecommendedFields = ["description", "first_mes"];

// 创建空角色卡
export function createEmptyCharacter(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    name: "",
    description: "",
    personality: "",
    scenario: "",
    first_mes: "",
    mes_example: "",
    system_prompt: "",
    post_history_instructions: "",
    creator: "eleckoi-tavern",
    creator_notes: "",
    character_version: "1.0",
    tags: [],
    alternate_greetings: [],
    character_book: null,
    extensions: {},
    scene: null,
    system_prompt_enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides
  };
}

// 验证角色卡字段
//
// 只查硬性必填。推荐字段的去向见 missingRecommended。
export function validateCharacter(card) {
  const errors = [];
  for (const field of RequiredFields) {
    if (!card[field] || card[field].trim() === "") {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

/**
 * 列出缺失的推荐字段。
 *
 * 与 validateCharacter 分开，是因为两件事的后果不同：
 * 缺 name 是「这张卡不成立」，缺 description 是「这张卡能用，但会很干」。
 * 前者拦，后者提示。混成一句 error，用户就分不清哪一条真该修。
 *
 * @param {object} card
 * @returns {string[]} 缺失的推荐字段名
 */
export function missingRecommended(card) {
  const out = [];
  for (const field of RecommendedFields) {
    const v = card?.[field];
    if (!v || String(v).trim() === "") out.push(field);
  }
  return out;
}

// 获取角色卡摘要（用于列表显示）
export function getCharacterSummary(card) {
  return {
    id: card.id,
    name: card.name,
    description: card.description?.slice(0, 100) || "",
    tags: card.tags || [],
    created_at: card.created_at,
    updated_at: card.updated_at
  };
}

// ── profile（C3 角色百科·八区块）─────────────────
//
// 八区块里只有「职业与专精 / 势力身份 / 装备与圣物 / 能力维度」
// 是 ST 卡不天然带的。其他四块（身份 / 基础资料 / 标签 / 简介）
// 直接从卡上取。
//
// 为什么不开新表：profile 是“一张卡自己的补充面”，卡存哪儿它存哪儿；
// 开新表会把“读一张卡”拆成两行网络请求。ST 导入不会碰它，
// 因为 extensions 里预留了 profile 这个子块。

/** 能力维度轴（雷达图轴）：{ name, value, max } */
export function normalizeAbilityAxis(a) {
  if (!a || typeof a !== "object") return null;
  const name = typeof a.name === "string" ? a.name.trim() : "";
  if (!name) return null;
  const value = a.value === null || a.value === undefined || a.value === "" ? null : Number(a.value);
  const max = a.max === null || a.max === undefined || a.max === "" ? null : Number(a.max);
  return {
    name,
    value: Number.isFinite(value) ? value : null,
    max: Number.isFinite(max) ? max : null
  };
}

/** 装备条目：{ name, type, note } */
export function normalizeGearItem(g) {
  if (!g || typeof g !== "object") return null;
  const name = typeof g.name === "string" ? g.name.trim() : "";
  if (!name) return null;
  return {
    name,
    type: typeof g.type === "string" ? g.type.trim() : "",
    note: typeof g.note === "string" ? g.note.trim() : ""
  };
}

/**
 * 归一化角色 profile。缺字段回默认；坏数组项跳过。
 * 不会修改卡上的其它字段——只对 profile 本身做。
 */
export function normalizeProfile(p) {
  const src = (p && typeof p === "object") ? p : {};
  return {
    profession: typeof src.profession === "string" ? src.profession : "",
    specialty: typeof src.specialty === "string" ? src.specialty : "",
    factionId: typeof src.factionId === "string" ? src.factionId : null,
    bio: typeof src.bio === "string" ? src.bio : "",
    // 基础资料里的四格：年龄 / 性别 / 种族 / 身高
    age: typeof src.age === "string" ? src.age : "",
    gender: typeof src.gender === "string" ? src.gender : "",
    race: typeof src.race === "string" ? src.race : "",
    height: typeof src.height === "string" ? src.height : "",
    gear: Array.isArray(src.gear)
      ? src.gear.map(normalizeGearItem).filter(Boolean)
      : [],
    abilityAxes: Array.isArray(src.abilityAxes)
      ? src.abilityAxes.map(normalizeAbilityAxis).filter(Boolean)
      : []
  };
}

/** 把 profile 挂到卡上（不删其它字段）。 */
export function attachProfile(card, profile) {
  const out = { ...card };
  out.extensions = { ...(out.extensions || {}) };
  out.extensions.profile = normalizeProfile(profile);
  return out;
}
