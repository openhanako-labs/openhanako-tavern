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
