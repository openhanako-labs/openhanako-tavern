// lib/regex/engine.js — 正则规则引擎
//
// 规格来源：SillyTavern 的 regex_scripts（三层 scope × 三个 surface）
//
// 三层 scope（作用范围，从小到大）：
//   character  仅对该角色生效
//   preset     该预设生效
//   global     全局生效
//
// 三个 surface（作用时机，这是最容易搞错的地方）：
//   Stored   存入聊天记录前（改的是存下来的内容）
//   Display  显示给用户前（只影响渲染，不改数据）
//   Prompt   发给模型前（只影响请求，不改数据）
//
// ⚠️ 关键语义（规划文档 C10 已记录）：
//   Display 的判定是 `!promptOnly`，不是"仅 displayOnly"。
//   也就是说，一条规则若没标记 promptOnly，它就会作用在 Display 上。
//   照搬这个语义，不"修正"它——修正会导致与 ST 行为不一致。

/** 三层作用范围。 */
export const RegexScope = {
  GLOBAL: "global",
  PRESET: "preset",
  CHARACTER: "character"
};

/** 三个作用面。 */
export const RegexSurface = {
  STORED: "stored",    // 存入前
  DISPLAY: "display",  // 显示前
  PROMPT: "prompt"     // 发请求前
};

/**
 * 创建一条正则规则。
 */
export function createRegexRule(overrides = {}) {
  return {
    id: overrides.id || `re-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: overrides.name || "",
    // 匹配
    pattern: overrides.pattern || "",
    flags: overrides.flags ?? "g",
    // 替换
    replacement: overrides.replacement ?? "",
    // 作用范围与面
    scope: overrides.scope || RegexScope.GLOBAL,
    scopeId: overrides.scopeId || null,      // character/preset 时指向具体 id
    // 哪些面生效（ST 用 promptOnly 等开关表达，这里存原始开关）
    promptOnly: overrides.promptOnly ?? false,
    markdownOnly: overrides.markdownOnly ?? false,
    // 其他
    disabled: overrides.disabled ?? false,
    runOnEdit: overrides.runOnEdit ?? false,
    order: overrides.order ?? 100,
    ...overrides
  };
}

/**
 * 编译规则为正则对象。失败返回 null（不让一条坏规则毁掉整条链路）。
 */
export function compileRule(rule) {
  if (!rule || !rule.pattern) return null;
  try {
    // 去掉 g 标志的重复（多次 replace 时 g 是必须的，这里统一补）
    let flags = String(rule.flags || "");
    if (!flags.includes("g")) flags += "g";
    return new RegExp(rule.pattern, flags);
  } catch {
    return null;
  }
}

/**
 * 判断规则是否作用于指定 surface。
 *
 * ⚠️ Display 的判定是 `!promptOnly`（ST 语义），不是"仅 displayOnly"。
 */
export function appliesToSurface(rule, surface) {
  if (!rule || rule.disabled) return false;

  switch (surface) {
    case RegexSurface.PROMPT:
      // Prompt 面：没被 markdownOnly 排除就生效
      return !rule.markdownOnly;

    case RegexSurface.DISPLAY:
      // 关键：不是 promptOnly 就作用于显示
      return !rule.promptOnly;

    case RegexSurface.STORED:
      // 存入前：默认不作用，除非显式开了 runOnEdit
      return !!rule.runOnEdit;

    default:
      return false;
  }
}

/**
 * 判断规则的作用范围是否匹配当前上下文。
 *
 * @param {object} rule
 * @param {{ characterId?: string, presetId?: string }} ctx
 */
export function scopeMatches(rule, ctx = {}) {
  switch (rule?.scope) {
    case RegexScope.GLOBAL:
      return true;
    case RegexScope.CHARACTER:
      return !!ctx.characterId && rule.scopeId === ctx.characterId;
    case RegexScope.PRESET:
      return !!ctx.presetId && rule.scopeId === ctx.presetId;
    default:
      return false;
  }
}

/**
 * 对文本应用一批规则。
 *
 * @param {string} text
 * @param {object[]} rules
 * @param {object} [opts]
 * @param {string} [opts.surface] - 目标 surface
 * @param {string} [opts.characterId]
 * @param {string} [opts.presetId]
 * @returns {{ text: string, applied: string[], failed: string[] }}
 */
export function applyRules(text, rules, opts = {}) {
  const {
    surface = RegexSurface.PROMPT,
    characterId = null,
    presetId = null
  } = opts;

  if (typeof text !== "string" || !text) {
    return { text: text ?? "", applied: [], failed: [] };
  }

  const list = Array.isArray(rules) ? rules : [];
  const ctx = { characterId, presetId };

  // 按 order 排序（小的先跑）
  const candidates = list
    .filter(r => appliesToSurface(r, surface) && scopeMatches(r, ctx))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

  let out = text;
  const applied = [];
  const failed = [];

  for (const rule of candidates) {
    const re = compileRule(rule);
    if (!re) {
      failed.push(rule.id || rule.name || "unknown");
      continue;
    }

    try {
      const before = out;
      out = out.replace(re, rule.replacement ?? "");
      if (out !== before) applied.push(rule.id || rule.name || "unknown");
    } catch {
      failed.push(rule.id || rule.name || "unknown");
    }
  }

  return { text: out, applied, failed };
}

/**
 * 从 ST 的 regex_scripts 格式导入规则。
 *
 * ST 字段名对照：
 *   scriptName → name
 *   findRegex → pattern
 *   replaceString → replacement
 *   placement → 决定哪些 surface（数字编码）
 *   disabled → disabled
 *   markdownOnly → markdownOnly
 *   promptOnly → promptOnly
 *   runOnEdit → runOnEdit
 *
 * ST 的 placement 数字编码（1-indexed）：
 *   1 = USER_INPUT（用户输入）
 *   2 = AI_OUTPUT（AI 输出）
 *   3 = SLASH_COMMAND
 *   4 = WORLD_INFO（世界书）
 *   5 = REASONING
 * 其中 1/2 决定它跑在"进"还是"出"的方向上，不直接对应我们的 surface。
 * 这里保守处理：把 placement 原样保留在 extensions，surface 用 promptOnly/markdownOnly 推导。
 */
export function fromStRegexScript(script, opts = {}) {
  if (!script || typeof script !== "object") {
    throw new Error("script must be an object");
  }

  const placement = Array.isArray(script.placement) ? script.placement : [];

  return createRegexRule({
    name: String(script.scriptName ?? script.name ?? ""),
    pattern: String(script.findRegex ?? script.pattern ?? ""),
    replacement: String(script.replaceString ?? script.replacement ?? ""),
    flags: String(script.flags ?? "g"),
    scope: opts.scope || RegexScope.CHARACTER,
    scopeId: opts.scopeId || null,
    promptOnly: !!script.promptOnly,
    markdownOnly: !!script.markdownOnly,
    runOnEdit: !!script.runOnEdit,
    disabled: !!script.disabled,
    order: Number(script.order ?? 100) || 100,
    extensions: {
      _preserved_placement: placement,
      _raw: script
    }
  });
}

/** 批量导入 ST regex_scripts。 */
export function fromStRegexScripts(scripts, opts = {}) {
  if (!Array.isArray(scripts)) return [];
  const out = [];
  for (const s of scripts) {
    try {
      out.push(fromStRegexScript(s, opts));
    } catch {
      // 单条坏数据不中断
    }
  }
  return out;
}

/** 导出为 ST 格式（便于回迁）。 */
export function toStRegexScript(rule) {
  const pattern = rule.pattern || "";
  const flags = rule.flags || "g";
  return {
    scriptName: rule.name || "",
    // ST 的 findRegex 是 "/pattern/flags" 整体；
    // 若 pattern 已自带斜杠则不重复包
    findRegex: pattern.startsWith("/") ? pattern : `/${pattern}/${flags}`,
    replaceString: rule.replacement ?? "",
    flags,
    placement: rule.extensions?._preserved_placement ?? [],
    disabled: !!rule.disabled,
    markdownOnly: !!rule.markdownOnly,
    promptOnly: !!rule.promptOnly,
    runOnEdit: !!rule.runOnEdit
  };
}
