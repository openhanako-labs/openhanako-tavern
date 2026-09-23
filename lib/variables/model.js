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

// 创建变量定义
export function createVariableDefinition(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    name: "",
    label: "",
    type: VariableType.TEXT,
    scope: VariableScope.CONVERSATION,
    defaultValue: "",
    description: "",
    visible: true,       // 是否显示在 UI
    editable: true,      // 用户是否可编辑
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
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

// 解析变量引用（{{variable}} 语法）
export function parseVariableReferences(text) {
  if (!text) return [];
  
  const refs = [];
  const regex = /\{\{(\w+(?:\.\w+)*)\}\}/g;
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
  
  return text.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, name) => {
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
