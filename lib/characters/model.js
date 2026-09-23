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

// 必填字段
export const RequiredFields = ["name", "description", "first_mes"];

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
export function validateCharacter(card) {
  const errors = [];
  for (const field of RequiredFields) {
    if (!card[field] || card[field].trim() === "") {
      errors.push(`${field} is required`);
    }
  }
  return errors;
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
