// lib/variables/patch.js — 变量补丁校验与归一化
//
// 问题：模型会输出格式不规范的变量更新（类型错、值越界、字段名拼错）。
// 直接写入会让后续逻辑读到脏数据。
//
// 策略：所有变量写入都过一道校验管线：
//   1. 类型检查（按定义声明的 type）
//   2. 范围检查（min/max）
//   3. 枚举检查（choices）
//   4. 未知变量处理（按策略：忽略 / 放行 / 报错）
//   5. 冲突检测（同一批里对同一变量多次赋值）
//
// 与 MVU 的关系：MVU 的补丁格式与这里不同，compatibility 层负责转换。

import { VariableType } from "./model.js";

/** 补丁处理策略。 */
export const PatchPolicy = {
  /** 未知变量直接忽略（最保守） */
  STRICT: "strict",
  /** 未知变量原样放行（最宽松，适合自由变量） */
  LENIENT: "lenient",
  /** 未知变量自动注册（按值的类型推断） */
  AUTO_REGISTER: "auto_register"
};

/**
 * 校验单个值是否符合变量定义。
 *
 * @returns {{ ok: boolean, value?: any, error?: string, coerced?: boolean }}
 */
export function validateValue(definition, rawValue) {
  if (!definition) {
    return { ok: false, error: "no definition" };
  }

  const type = definition.type || VariableType.TEXT;
  let value = rawValue;
  let coerced = false;

  switch (type) {
    case VariableType.NUMBER: {
      if (typeof value === "string" && value.trim() !== "") {
        const n = Number(value);
        if (Number.isFinite(n)) {
          value = n;
          coerced = true;
        } else {
          return { ok: false, error: `not a number: ${JSON.stringify(rawValue)}` };
        }
      } else if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, error: `expected number, got ${typeof rawValue}` };
      }

      // 范围
      if (definition.min !== undefined && value < Number(definition.min)) {
        return { ok: false, error: `below min ${definition.min}: ${value}` };
      }
      if (definition.max !== undefined && value > Number(definition.max)) {
        return { ok: false, error: `above max ${definition.max}: ${value}` };
      }
      break;
    }

    case VariableType.BOOLEAN: {
      if (typeof value === "boolean") break;
      if (value === "true" || value === 1 || value === "1") { value = true; coerced = true; }
      else if (value === "false" || value === 0 || value === "0") { value = false; coerced = true; }
      else return { ok: false, error: `not a boolean: ${JSON.stringify(rawValue)}` };
      break;
    }

    case VariableType.OBJECT: {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, error: `expected object, got ${Array.isArray(value) ? "array" : typeof rawValue}` };
      }
      break;
    }

    case VariableType.TEXT:
    default: {
      if (value === null || value === undefined) {
        return { ok: false, error: "value is null/undefined" };
      }
      if (typeof value !== "string") {
        value = String(value);
        coerced = true;
      }
      break;
    }
  }

  // 枚举检查
  if (Array.isArray(definition.choices) && definition.choices.length > 0) {
    if (!definition.choices.includes(value)) {
      return { ok: false, error: `not in choices: ${JSON.stringify(value)}` };
    }
  }

  return { ok: true, value, coerced };
}

/** 按值推断类型（AUTO_REGISTER 用）。 */
export function inferType(value) {
  if (typeof value === "number") return VariableType.NUMBER;
  if (typeof value === "boolean") return VariableType.BOOLEAN;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return VariableType.OBJECT;
  return VariableType.TEXT;
}

/**
 * 校验一批变量补丁。
 *
 * @param {object} patch - { varName: value, ... }
 * @param {object[]} definitions - 变量定义列表
 * @param {object} [opts]
 * @param {string} [opts.policy] - PatchPolicy
 * @param {boolean} [opts.checkConflicts] - 是否检测批内冲突（patch 是对象时天然无冲突）
 * @returns {{
 *   accepted: object,
 *   rejected: Array<{name, value, reason}>,
 *   coerced: Array<{name, from, to}>,
 *   unknown: string[]
 * }}
 */
export function validatePatch(patch, definitions, opts = {}) {
  const { policy = PatchPolicy.STRICT } = opts;

  const result = {
    accepted: {},
    rejected: [],
    coerced: [],
    unknown: []
  };

  if (!patch || typeof patch !== "object") return result;

  const defMap = new Map();
  for (const d of definitions || []) {
    if (d?.name) defMap.set(d.name, d);
  }

  for (const [name, rawValue] of Object.entries(patch)) {
    const def = defMap.get(name);

    // 未知变量
    if (!def) {
      result.unknown.push(name);

      if (policy === PatchPolicy.LENIENT) {
        result.accepted[name] = rawValue;
      } else if (policy === PatchPolicy.AUTO_REGISTER) {
        result.accepted[name] = rawValue;
      }
      // STRICT: 不写入
      continue;
    }

    const v = validateValue(def, rawValue);

    if (!v.ok) {
      result.rejected.push({ name, value: rawValue, reason: v.error });
      continue;
    }

    if (v.coerced) {
      result.coerced.push({ name, from: rawValue, to: v.value });
    }

    result.accepted[name] = v.value;
  }

  return result;
}

/**
 * 合并变量状态（带冲突检测）。
 *
 * 用途：同一轮里可能有多个来源改同一个变量（模型输出 + 用户手动），
 * 后写的覆盖先写的，但要记录冲突以便排查。
 *
 * @param {object} current - 当前状态
 * @param {object} patch - 要应用的补丁
 * @returns {{ state: object, conflicts: Array<{name, oldValue, newValue}> }}
 */
export function mergeState(current, patch) {
  const state = { ...(current || {}) };
  const conflicts = [];

  for (const [name, value] of Object.entries(patch || {})) {
    if (name in state && state[name] !== value) {
      conflicts.push({ name, oldValue: state[name], newValue: value });
    }
    state[name] = value;
  }

  return { state, conflicts };
}

/**
 * 从模型输出里提取变量更新。
 *
 * 支持两种常见格式：
 *   1. ```json { "hp": 10 } ```
 *   2. <var name="hp">10</var>
 *
 * 提取失败返回空对象——不抛异常，因为模型输出不可控。
 */
export function extractPatch(text) {
  if (typeof text !== "string" || !text) return {};

  // 1. 围栏 JSON
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) {
    try {
      const parsed = JSON.parse(fence[1].trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch { /* 继续尝试下一种 */ }
  }

  // 2. <var name="x">value</var>
  const tags = [...text.matchAll(/<var\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/var>/g)];
  if (tags.length > 0) {
    const out = {};
    for (const [, name, raw] of tags) {
      const v = raw.trim();
      // 尝试解析成 JSON 值，失败则当字符串
      try {
        out[name] = JSON.parse(v);
      } catch {
        out[name] = v;
      }
    }
    return out;
  }

  return {};
}

/**
 * 归一化：把补丁应用到定义列表，产出更新后的定义（含 currentValue）。
 */
export function applyPatchToDefinitions(definitions, patch, opts = {}) {
  const validation = validatePatch(patch, definitions, opts);
  const out = (definitions || []).map(d => {
    if (d.name in validation.accepted) {
      return { ...d, currentValue: validation.accepted[d.name] };
    }
    return d;
  });
  return { definitions: out, ...validation };
}
