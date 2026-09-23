// lib/settings/model.js — 设定库数据模型

import crypto from "node:crypto";

// 设定条目类型
export const SettingType = {
  CHARACTER: "character",      // 角色设定
  LOCATION: "location",        // 场景设定
  OBJECT: "object",            // 物品设定
  EVENT: "event",              // 事件设定
  CUSTOM: "custom"             // 自定义
};

// 触发条件类型
export const TriggerType = {
  KEYWORD: "keyword",          // 关键词匹配
  REGEX: "regex",              // 正则匹配
  ALWAYS: "always",            // 始终触发
  NEVER: "never"               // 从不触发
};

// 条件运算符
export const ConditionOp = {
  CONTAINS: "contains",        // 包含
  STARTS_WITH: "starts_with",  // 开头匹配
  ENDS_WITH: "ends_with",      // 结尾匹配
  EQUALS: "equals",            // 等于
  MATCHES: "matches"           // 正则匹配
};

// 创建设定条目
export function createSetting(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    name: "",
    type: SettingType.CUSTOM,
    description: "",
    content: "",
    keywords: [],
    trigger: {
      type: TriggerType.KEYWORD,
      keywords: []
    },
    conditions: [],
    priority: 100,             // 优先级，数字越小越优先
    order: 1,                  // 显示顺序
    enabled: true,

    // ── ST 世界书兼容字段（由 lib/settings/import.js 写入） ──
    secondaryKeys: [],         // 副键（ST keysecondary）
    selectiveLogic: "and_any", // 副键逻辑：and_any | not_all | not_any | and_all
    selective: true,           // 是否启用副键过滤
    position: null,            // ST 原始 position 数字
    anchor: null,              // 映射后的插入位置名
    probability: 100,          // 激活概率（%）
    excludeRecursion: false,   // 不参与递归激活
    preventRecursion: false,   // 自身激活后不继续传播
    delayUntilRecursion: false,
    recursionLevel: 0,
    matchWholeWords: false,
    caseSensitive: false,
    scanDepth: 0,              // 扫描深度（0=用全局默认）
    sticky: 0,
    cooldown: 0,
    delay: 0,
    source: "native",          // native | sillytavern | character_book
    externalId: "",

    // ── 归属（世界书分级） ──
    // characterId 为空 = 全局条目，任何对话都能用；
    // 非空 = 只在该角色卡的对话里参与激活。
    // 没有这层，导入 10 张卡后 A 卡的世界书会在 B 卡的对话里乱触发。
    characterId: "",
    // ST 独立世界书的角色过滤（{names, tags, isExclude}），仅对全局条目生效
    characterFilter: null,

    extensions: {},

    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

// 创建触发条件
export function createTrigger(overrides = {}) {
  return {
    type: TriggerType.KEYWORD,
    keywords: [],
    caseSensitive: false,
    ...overrides
  };
}

// 创建条件
export function createCondition(overrides = {}) {
  return {
    field: "",
    operator: ConditionOp.CONTAINS,
    value: "",
    ...overrides
  };
}

// 检查设定是否应该触发
export function shouldTrigger(setting, context) {
  if (!setting.enabled) return false;
  
  const trigger = setting.trigger || {};
  
  switch (trigger.type) {
    case TriggerType.ALWAYS:
      return true;
    
    case TriggerType.NEVER:
      return false;
    
    case TriggerType.KEYWORD:
      if (!trigger.keywords || trigger.keywords.length === 0) return false;
      
      const searchText = (context.text || "").toLowerCase();
      const isCaseSensitive = trigger.caseSensitive || false;
      
      for (const keyword of trigger.keywords) {
        if (isCaseSensitive) {
          if (searchText.includes(keyword)) return true;
        } else {
          if (searchText.includes(keyword.toLowerCase())) return true;
        }
      }
      return false;
    
    case TriggerType.REGEX:
      if (!trigger.regex) return false;
      
      try {
        const flags = trigger.caseSensitive ? "" : "i";
        const regex = new RegExp(trigger.regex, flags);
        return regex.test(context.text || "");
      } catch (e) {
        return false;
      }
    
    default:
      return false;
  }
}

// 检查条件是否满足
export function checkConditions(conditions, variables) {
  if (!conditions || conditions.length === 0) return true;
  
  for (const cond of conditions) {
    const value = variables?.[cond.field];
    
    if (value === undefined || value === null) {
      return false;
    }
    
    const condValue = String(value).toLowerCase();
    const targetValue = String(cond.value).toLowerCase();
    
    switch (cond.operator) {
      case ConditionOp.CONTAINS:
        if (!condValue.includes(targetValue)) return false;
        break;
      case ConditionOp.STARTS_WITH:
        if (!condValue.startsWith(targetValue)) return false;
        break;
      case ConditionOp.ENDS_WITH:
        if (!condValue.endsWith(targetValue)) return false;
        break;
      case ConditionOp.EQUALS:
        if (condValue !== targetValue) return false;
        break;
      case ConditionOp.MATCHES:
        try {
          const regex = new RegExp(cond.value, "i");
          if (!regex.test(condValue)) return false;
        } catch (e) {
          return false;
        }
        break;
    }
  }
  
  return true;
}

// 获取活跃设定（基于上下文和变量）
export function getActiveSettings(settings, context, variables) {
  const active = [];
  
  for (const setting of settings) {
    if (!setting.enabled) continue;
    
    // 检查触发条件
    if (!shouldTrigger(setting, context)) continue;
    
    // 检查条件
    if (!checkConditions(setting.conditions, variables)) continue;
    
    active.push(setting);
  }
  
  // 按优先级和顺序排序
  active.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.order - b.order;
  });
  
  return active;
}

/**
 * 判断一条**全局**条目是否被 characterFilter 允许进入该角色的对话。
 *
 * ST 的 characterFilter 语义：names/tags 命中即“属于这个角色”；
 * isExclude=true 时反过来（命中即排除）。两个列表都空 = 不过滤。
 */
export function matchesCharacterFilter(setting, opts = {}) {
  const f = setting?.characterFilter
    || setting?.extensions?.characterFilter
    || setting?.extensions?._raw?.characterFilter
    || null;
  if (!f || typeof f !== "object") return true;

  const names = Array.isArray(f.names) ? f.names.map(v => String(v).toLowerCase()) : [];
  const tags = Array.isArray(f.tags) ? f.tags.map(v => String(v).toLowerCase()) : [];
  if (names.length === 0 && tags.length === 0) return true;

  const name = opts.characterName ? String(opts.characterName).toLowerCase() : "";
  const ownTags = (Array.isArray(opts.characterTags) ? opts.characterTags : [])
    .map(v => String(v).toLowerCase());

  const hit = (!!name && names.includes(name)) || ownTags.some(t => tags.includes(t));
  return f.isExclude === true ? !hit : hit;
}

/**
 * 按角色筛出本次对话可用的设定条目。
 *
 * 规则（不可想当然）：
 *   1. 显式绑定 characterId 的条目：只对同一角色生效（绑定优先于 filter）
 *   2. 未绑定的条目：全局，但仍受 characterFilter 约束
 *
 * @param {object[]} settings
 * @param {{characterId?: string|null, characterName?: string|null, characterTags?: string[]}} [opts]
 */
export function filterForCharacter(settings, opts = {}) {
  const list = Array.isArray(settings) ? settings : [];
  const want = opts.characterId ? String(opts.characterId) : "";

  return list.filter(s => {
    if (!s) return false;

    const bound = typeof s.characterId === "string" ? s.characterId.trim() : "";
    if (bound) return bound === want;

    return matchesCharacterFilter(s, opts);
  });
}


/**
 * 把「这一轮生效的设定」拼进系统提示。
 *
 * @param {string} systemPrompt - 原系统提示
 * @param {Array<object>} active - getActiveSettings() 选出的条目
 * @returns {string}
 */
export function injectSettings(systemPrompt, active) {
  const base = typeof systemPrompt === "string" ? systemPrompt.trim() : "";
  const list = Array.isArray(active) ? active : [];
  if (list.length === 0) return base;

  const parts = list
    .filter(s => s && s.enabled !== false)
    .map(s => {
      const name = (s.comment || s.name || "").trim();
      const body = (s.content || "").trim();
      if (!body) return null;
      return name ? `【${name}】
${body}` : body;
    })
    .filter(Boolean);

  if (parts.length === 0) return base;

  const block = parts.join("\n\n");
  return base ? base + "\n\n" + block : block;
}
