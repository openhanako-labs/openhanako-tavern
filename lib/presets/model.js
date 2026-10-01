// lib/presets/model.js — 提示词预设数据模型
//
// 背景：原先 composeSystemPrompt 把拼接顺序写死在代码里，
// 用户能改「说什么」，改不了「怎么组织」。预设把顺序数据化。
//
// 一个预设 = 一组有序的提示块 + 采样参数。
// 每个块声明：从哪取内容、放哪个 role、开不开。

import crypto from "node:crypto";

/**
 * 块来源（source）。
 *
 * 字面量（直接写死内容）与角色卡字段引用（运行时求值）分开，
 * 这样预设可以跨角色卡复用。
 */
export const BlockSource = {
  LITERAL: "literal",           // content 字段直接作为文本
  MAIN: "main",                 // 主提示（预设级 system）
  DESCRIPTION: "description",   // 角色卡 description
  PERSONALITY: "personality",   // 角色卡 personality
  SCENARIO: "scenario",         // 角色卡 scenario
  EXAMPLES: "examples",         // 角色卡 mes_example
  SYSTEM_PROMPT: "system_prompt",              // 角色卡 system_prompt（覆盖主提示）
  POST_HISTORY: "post_history_instructions",   // 角色卡后置指令
  LORE: "lore",                 // 世界书（整体前置部分）
  PERSONA: "persona",           // 用户人设
  AUTHOR_NOTE: "author_note"    // 作者注释
};

/** 块放置位置。 */
export const BlockPosition = {
  SYSTEM: "system",     // 进 systemPrompt
  IN_CHAT: "in_chat"    // 进消息流（按 depth）
};

/** 内置默认预设：复现原先写死的拼接顺序。 */
export const DEFAULT_BLOCKS = [
  { id: "main",        source: BlockSource.MAIN,        position: BlockPosition.SYSTEM,  enabled: true,  order: 0 },
  { id: "description", source: BlockSource.DESCRIPTION, position: BlockPosition.SYSTEM,  enabled: true,  order: 10 },
  { id: "personality", source: BlockSource.PERSONALITY, position: BlockPosition.SYSTEM,  enabled: true,  order: 20 },
  { id: "scenario",    source: BlockSource.SCENARIO,    position: BlockPosition.SYSTEM,  enabled: true,  order: 30 },
  { id: "persona",     source: BlockSource.PERSONA,     position: BlockPosition.SYSTEM,  enabled: true,  order: 40 },
  { id: "lore",        source: BlockSource.LORE,        position: BlockPosition.SYSTEM,  enabled: true,  order: 50 },
  { id: "postHistory", source: BlockSource.POST_HISTORY,position: BlockPosition.SYSTEM,  enabled: true,  order: 60 }
];

/** 默认采样参数。 */
export const DEFAULT_SAMPLING = {
  temperature: 0.8,
  maxTokens: 1000
};

export function createEmptyPreset(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    name: "新预设",
    description: "",
    blocks: DEFAULT_BLOCKS.map(b => ({ ...b })),
    sampling: { ...DEFAULT_SAMPLING },
    builtin: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides
  };
}

/** 内置默认预设（不可删）。 */
export function createDefaultPreset() {
  return createEmptyPreset({
    id: "default",
    name: "默认",
    description: "复现基础拼接顺序：主提示 → 描述 → 性格 → 场景 → 世界书",
    builtin: true
  });
}

/**
 * 剧情卡协议说明（cwv1）。给 AI 看的输出格式约定——
 * 与 lib/story/protocol.js 的解析器成对：这里说不清，解析器就接不到。
 * 精简优先：这段进 system prompt，每个字都在烧 token。
 */
export const CWV1_INSTRUCTION = [
  "## 结构化输出协议（cwv1）",
  "尽量按下列标签块组织回复（标签只认行首）。不使用也可以——那就当普通回复显示。",
  "",
  "【剧情】",
  "类型: 主线|支线|日常",
  "标题: 一句话",
  "场景: 地点 · 时间 · 天气",
  "",
  "【对话】",
  "【角色名|心情】: 台词",
  "【旁白】: 动作或环境描写",
  "",
  "【效果】",
  "体力 -10",
  "角色.好感度 +2",
  "时间 = 深夜",
  "",
  "效果的值可以写公式：{变量}、d20/2d6 骰子、max/min/floor/abs 函数、+ - * / 括号。",
  "例：体力 -d6、金币 +{基础价}*2、先攻 = d20+{敏捷}",
  "",
  "【场景更新】",
  "新增人物: 名|性别|心情|重要性：描述",
  "新增物品: 名：描述",
  "",
  "【选项】",
  "A. 选项内容",
  "B. 选项内容",
  "",
  "【摘要】",
  "一段话，写进前情提要。"
].join("\n");

/**
 * 剧情卡协议预设（cwv1）：内置但**默认不挂**——用户在哪一场想用，
 * 就把它挂到那一场上。默认块照旧（否则挂了它反而丢了角色卡信息），
 * 只是在末尾追加一条 literal 块装协议说明。
 */
export function createStoryProtocolPreset() {
  return createEmptyPreset({
    id: "story-cwv1",
    name: "剧情卡协议 cwv1",
    description: "让 AI 按【剧情】【对话】【效果】【场景更新】【选项】【摘要】结构化输出，聊天区渲染成剧情卡",
    builtin: true,
    blocks: [
      ...DEFAULT_BLOCKS.map(b => ({ ...b })),
      {
        id: "cwv1",
        source: BlockSource.LITERAL,
        position: BlockPosition.SYSTEM,
        enabled: true,
        order: 70,
        content: CWV1_INSTRUCTION
      }
    ]
  });
}

const VALID_SOURCES = new Set(Object.values(BlockSource));
const VALID_POSITIONS = new Set(Object.values(BlockPosition));

/** 校验预设。返回错误数组（空 = 通过）。 */
export function validatePreset(preset) {
  const errors = [];
  if (!preset || typeof preset !== "object") {
    return ["preset must be an object"];
  }
  if (!preset.name || String(preset.name).trim() === "") {
    errors.push("name is required");
  }
  if (!Array.isArray(preset.blocks)) {
    errors.push("blocks must be an array");
  } else {
    for (const [i, b] of preset.blocks.entries()) {
      if (!b || typeof b !== "object") { errors.push(`blocks[${i}] must be an object`); continue; }
      if (!VALID_SOURCES.has(b.source)) errors.push(`blocks[${i}].source invalid: ${b.source}`);
      if (b.position && !VALID_POSITIONS.has(b.position)) {
        errors.push(`blocks[${i}].position invalid: ${b.position}`);
      }
      if (b.source === BlockSource.LITERAL && typeof b.content !== "string") {
        errors.push(`blocks[${i}] literal source requires string content`);
      }
      if (b.depth !== undefined && (!Number.isInteger(b.depth) || b.depth < 0)) {
        errors.push(`blocks[${i}].depth must be a non-negative integer`);
      }
    }
  }
  if (preset.sampling && typeof preset.sampling === "object") {
    const t = preset.sampling.temperature;
    if (t !== undefined && (typeof t !== "number" || t < 0 || t > 2)) {
      errors.push("sampling.temperature must be between 0 and 2");
    }
  }
  return errors;
}

/** 按 order 排序（稳定），返回启用中的块。 */
export function orderedBlocks(preset) {
  const blocks = Array.isArray(preset?.blocks) ? preset.blocks : DEFAULT_BLOCKS;
  return blocks
    .map((b, i) => ({ ...b, _i: i }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a._i - b._i);
}

/**
 * 从角色卡/上下文中求值一个块的文本。
 *
 * 这是「预设与角色卡解耦」的关键：块只说「取哪个字段」，
 * 具体值运行时才知道。
 */
export function resolveBlockText(block, ctx = {}) {
  const { character, mainPrompt, loreText, persona } = ctx;
  switch (block.source) {
    case BlockSource.LITERAL:
      return block.content || "";
    case BlockSource.MAIN:
      // 角色卡若带 system_prompt 且启用，优先于预设主提示
      if (character?.system_prompt && character?.system_prompt_enabled !== false) {
        return character.system_prompt;
      }
      return mainPrompt || "";
    case BlockSource.DESCRIPTION:
      return character?.description || "";
    case BlockSource.PERSONALITY:
      return character?.personality ? `性格：${character.personality}` : "";
    case BlockSource.SCENARIO:
      return character?.scenario ? `场景：${character.scenario}` : "";
    case BlockSource.EXAMPLES:
      return character?.mes_example || "";
    case BlockSource.SYSTEM_PROMPT:
      return character?.system_prompt || "";
    case BlockSource.POST_HISTORY:
      return character?.post_history_instructions || "";
    case BlockSource.LORE:
      return loreText || "";
    case BlockSource.PERSONA:
      return persona || "";
    case BlockSource.AUTHOR_NOTE:
      return ctx.authorNote || "";
    default:
      return "";
  }
}

/**
 * 按预设组装 systemPrompt。
 *
 * @returns {{ systemPrompt: string, inChatBlocks: object[], used: string[] }}
 */
export function composeFromPreset(preset, ctx = {}) {
  const blocks = orderedBlocks(preset);
  const systemParts = [];
  const inChatBlocks = [];
  const used = [];

  for (const b of blocks) {
    if (b.enabled === false) continue;
    const text = resolveBlockText(b, ctx);
    if (!text || !String(text).trim()) continue;

    const position = b.position || BlockPosition.SYSTEM;
    if (position === BlockPosition.IN_CHAT) {
      inChatBlocks.push({
        id: b.id,
        text: String(text),
        depth: Number.isInteger(b.depth) ? b.depth : 4,
        role: b.role || "system"
      });
    } else {
      // 世界书有专属小标题，保持可读性
      systemParts.push(b.source === BlockSource.LORE ? `## 世界设定\n${text}` : String(text));
    }
    used.push(b.id);
  }

  return { systemPrompt: systemParts.join("\n\n"), inChatBlocks, used };
}
