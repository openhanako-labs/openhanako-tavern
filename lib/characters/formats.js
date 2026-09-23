// lib/characters/formats.js — 角色卡格式检测与转换
//
// 支持 SillyTavern V2/V3 格式与原生格式。

/**
 * 检测角色卡格式
 * @param {object} card - 角色卡对象
 * @returns {string} 格式类型：'st-v2' | 'st-v3' | 'native' | 'unknown'
 */
export function detectCardFormat(card) {
  if (!card || typeof card !== "object") return "unknown";

  // SillyTavern V3 格式
  if (card.spec === "chara_card_v3" && card.ccv3) return "st-v3";

  // SillyTavern V2 格式（有 chara 字段）
  if (card.spec === "chara_card_v2" && card.data) return "st-v2";
  if (card.chara && typeof card.chara === "object" && card.chara.name) return "st-v2";

  // 裸字段（无 spec）
  if (card.name && card.description && card.first_mes) return "native";

  // ccv3 裸字段
  if (card.ccv3 && typeof card.ccv3 === "object" && card.ccv3.name) return "st-v3";

  return "unknown";
}

/**
 * 转换 SillyTavern V2 格式为内部格式
 * @param {object} card - ST V2 格式卡
 * @returns {object} 内部格式卡
 */
export function convertStV2Card(card) {
  const chara = card.chara || card.data || card;

  return {
    name: chara.name || "",
    description: chara.description || "",
    personality: chara.personality || "",
    scenario: chara.scenario || "",
    first_mes: chara.first_mes || "",
    mes_example: chara.mes_example || "",
    system_prompt: chara.system_prompt || "",
    post_history_instructions: chara.post_history_instructions || "",
    creator: chara.creator || "",
    creator_notes: chara.creator_notes || "",
    character_version: chara.character_version || "1.0",
    tags: chara.tags || [],
    alternate_greetings: chara.alternate_greetings || [],
    character_book: chara.character_book || null,
    extensions: chara.extensions || {},
    scene: chara.scene || null,
    system_prompt_enabled: chara.system_prompt_enabled !== false
  };
}

/**
 * 转换 SillyTavern V3 格式为内部格式
 * @param {object} card - ST V3 格式卡
 * @returns {object} 内部格式卡
 */
export function convertStV3Card(card) {
  const ccv3 = card.ccv3 || card;

  return {
    name: ccv3.name || "",
    description: ccv3.description || "",
    personality: ccv3.personality || "",
    scenario: ccv3.scenario || "",
    first_mes: ccv3.first_mes || "",
    mes_example: ccv3.mes_example || "",
    system_prompt: ccv3.system_prompt || "",
    post_history_instructions: ccv3.post_history_instructions || "",
    creator: ccv3.creator || "",
    creator_notes: ccv3.creator_notes || "",
    character_version: ccv3.character_version || "1.0",
    tags: ccv3.tags || [],
    alternate_greetings: ccv3.alternate_greetings || [],
    character_book: ccv3.character_book || null,
    extensions: ccv3.extensions || {},
    scene: ccv3.scene || null,
    system_prompt_enabled: ccv3.system_prompt_enabled !== false
  };
}

/**
 * 内部格式转换为 SillyTavern V2 格式
 * @param {object} card - 内部格式卡
 * @returns {object} ST V2 格式卡
 */
export function toStV2Card(card) {
  return {
    spec: "chara_card_v2",
    spec_version: "2",
    data: {
      name: card.name,
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      first_mes: card.first_mes,
      mes_example: card.mes_example,
      system_prompt: card.system_prompt,
      post_history_instructions: card.post_history_instructions,
      creator: card.creator,
      creator_notes: card.creator_notes,
      character_version: card.character_version,
      tags: card.tags,
      alternate_greetings: card.alternate_greetings,
      character_book: card.character_book,
      extensions: card.extensions,
      scene: card.scene,
      system_prompt_enabled: card.system_prompt_enabled
    }
  };
}

/**
 * 内部格式转换为 SillyTavern V3 格式
 * @param {object} card - 内部格式卡
 * @returns {object} ST V3 格式卡
 */
export function toStV3Card(card) {
  return {
    spec: "chara_card_v3",
    spec_version: "3",
    ccv3: {
      name: card.name,
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      first_mes: card.first_mes,
      mes_example: card.mes_example,
      system_prompt: card.system_prompt,
      post_history_instructions: card.post_history_instructions,
      creator: card.creator,
      creator_notes: card.creator_notes,
      character_version: card.character_version,
      tags: card.tags,
      alternate_greetings: card.alternate_greetings,
      character_book: card.character_book,
      extensions: card.extensions,
      scene: card.scene,
      system_prompt_enabled: card.system_prompt_enabled
    }
  };
}

/**
 * 通用转换：自动检测格式并转换
 * @param {object} card - 任意格式卡
 * @returns {object} 内部格式卡
 */
export function normalizeCard(card) {
  const format = detectCardFormat(card);

  switch (format) {
    case "st-v2":
      return convertStV2Card(card);
    case "st-v3":
      return convertStV3Card(card);
    case "native":
      return { ...card };
    default:
      return convertStV2Card(card); // 兜底按 V2 处理
  }
}
