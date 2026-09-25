// lib/variables/model.js — 变量数据模型

import crypto from "node:crypto";

// 变量类型
export const VariableType = {
  TEXT: "text",
  NUMBER: "number",
  BOOLEAN: "boolean",
  OBJECT: "object"
};

// 变量作用域
export const VariableScope = {
  GLOBAL: "global",       // 全局变量，所有对话共享
  CONVERSATION: "conversation", // 对话变量，每个对话独立
  CHARACTER: "character"  // 角色变量，角色卡级别
};

// 展示形式：变量在界面上怎么长出来
//   text   纯文本
//   number 数字
//   bar    带上下限的条（生命、能量）
//   grid   属性格（力量 18 那种小方块）
export const DisplayKind = {
  TEXT: "text",
  NUMBER: "number",
  BAR: "bar",
  GRID: "grid"
};

// 展示元数据的默认值。
// 这一层管的是"怎么显示"，不是"值是多少"——值和类型归 type / defaultValue 管。
export const DISPLAY_DEFAULTS = {
  min: null,
  max: null,
  kind: DisplayKind.TEXT,
  group: "",
  order: 0
};

const DISPLAY_KINDS = new Set(Object.values(DisplayKind));

/**
 * 补齐展示元数据。
 *
 * 老的定义文件里没有这五项。读取时补默认值、**不改盘上文件**——这是读侧兜底，
 * 不是迁移：用户没动过的变量不该被悄悄改写。
 *
 * 两条纠偏规则，都是为了让界面上画不出坏东西：
 *   - kind 不认识 → 退回 text
 *   - bar 缺上下限 → 退回 number（否则画出来是一根没有刻度的条）
 */
export function normalizeVariableDefinition(def) {
  if (!def || typeof def !== "object") return def;

  const out = { ...def };
  for (const [key, fallback] of Object.entries(DISPLAY_DEFAULTS)) {
    if (out[key] === undefined) out[key] = fallback;
  }

  if (!DISPLAY_KINDS.has(out.kind)) out.kind = DisplayKind.TEXT;

  // 0 是合法边界值，不能用真值判断
  out.min = Number.isFinite(out.min) ? out.min : null;
  out.max = Number.isFinite(out.max) ? out.max : null;
  out.order = Number.isFinite(Number(out.order)) ? Number(out.order) : 0;
  if (typeof out.group !== "string") out.group = "";

  if (out.kind === DisplayKind.BAR && !(out.min !== null && out.max !== null)) {
    out.kind = DisplayKind.NUMBER;
  }

  return out;
}

// 创建变量定义
export function createVariableDefinition(overrides = {}) {
  // 创建即归一：新定义不允许带着画不出来的展示形式进库
  return normalizeVariableDefinition({
    id: crypto.randomUUID(),
    name: "",
    label: "",
    type: VariableType.TEXT,
    scope: VariableScope.CONVERSATION,
    defaultValue: "",
    description: "",
    visible: true,       // 是否显示在 UI
    editable: true,      // 用户是否可编辑
    ...DISPLAY_DEFAULTS, // min / max / kind / group / order
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  });
}

// 创建变量状态
export function createVariableState(definition, value = null) {
  return {
    variableId: definition.id,
    name: definition.name,
    value: value ?? definition.defaultValue,
    updatedAt: new Date().toISOString()
  };
}

// 变量名的字符集。
//
// **不能只写 \w。** `\w` 等于 `[A-Za-z0-9_]`，不认中文——
// 而我们的定义仓允许中文名、宏引擎也认（`{{setvar::好感::7}}` 一直是能用的），
// 于是就会出现「变量确实存在、面板上写着『支持 {{variable}}』，
// 但 {{好感}} 既不展开也不算引用」这种自相矛盾的场面。
//
// 口径：除了空白、花括号、冒号（中英文）之外都算名字的组成部分。
// 冒号要排除——`{{roll::1d6}}` / `{{getvar::好感}}` 是**宏**不是变量引用。
const VAR_NAME = "[^\\s{}:：]+";
const VAR_REF_RE = new RegExp(`\\{\\{(${VAR_NAME}(?:\\.${VAR_NAME})*)\\}\\}`, "g");

// 解析变量引用（{{variable}} 语法）
export function parseVariableReferences(text) {
  if (!text) return [];
  
  const refs = [];
  const regex = new RegExp(VAR_REF_RE.source, "g");
  let match;
  
  while ((match = regex.exec(text)) !== null) {
    refs.push({
      name: match[1],
      full: match[0],
      index: match.index
    });
  }
  
  return refs;
}

// 替换变量引用
export function replaceVariables(text, variables) {
  if (!text || !variables) return text;
  
  return text.replace(new RegExp(VAR_REF_RE.source, "g"), (match, name) => {
    // 支持嵌套属性：user.name
    if (name.includes(".")) {
      const parts = name.split(".");
      let value = variables;
      for (const part of parts) {
        if (value && typeof value === "object" && part in value) {
          value = value[part];
        } else {
          return match; // 找不到就保留原样
        }
      }
      return value !== null && value !== undefined ? String(value) : match;
    }
    
    if (name in variables) {
      const value = variables[name];
      return value !== null && value !== undefined ? String(value) : match;
    }
    
    return match; // 找不到就保留原样
  });
}

// 合并变量定义和状态
export function mergeVariablesWithState(definitions, states) {
  const stateMap = new Map();
  if (states) {
    for (const s of states) {
      stateMap.set(s.variableId || s.name, s);
    }
  }
  
  return definitions.map(def => {
    const state = stateMap.get(def.id) || stateMap.get(def.name);
    return {
      ...def,
      currentValue: state?.value ?? def.defaultValue
    };
  });
}
