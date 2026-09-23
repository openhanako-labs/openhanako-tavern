// lib/macros/engine.js — 宏替换引擎
//
// ST 宏规范（docs.sillytavern.app/usage/core-concepts/macros）：
//   - 语法 {{name}} / {{name arg}} / {{name::arg1::arg2}}
//   - 宏名大小写不敏感
//   - 支持嵌套：内层先解析（{{getvar::{{char}}_mood}}）
//   - 转义：\{\{notAMacro\}\} → 原样输出 {{notAMacro}}
//   - 空白：{{ macro :: arg }} 等价于紧凑形式
//   - 作用域宏：{{if cond}}...{{/if}}
//
// 本引擎只负责"解析与调度"，具体宏由注册表提供。

const MAX_DEPTH = 8; // 嵌套深度上限，防循环

/**
 * 把模板文本切成 token 序列。
 * 返回 [{ type: "text", value }, { type: "macro", name, args, flags, raw }]
 *
 * 关键：查找宏结束位置时必须配平嵌套的 {{ }}，
 * 否则 {{getvar::{{char}}_mood}} 会在内层 }} 处提前截断。
 */
export function tokenize(text) {
  const tokens = [];
  let i = 0;
  let buffer = "";

  while (i < text.length) {
    // 转义：\{\{ → 原样输出（不进入宏解析）
    if (text[i] === "\\" && text[i + 1] === "{" && text[i + 2] === "{") {
      buffer += "\u0000LBRACE\u0000";
      i += 3;
      continue;
    }
    if (text[i] === "\\" && text[i + 1] === "}" && text[i + 2] === "}") {
      buffer += "\u0000RBRACE\u0000";
      i += 3;
      continue;
    }

    // 宏开始
    if (text[i] === "{" && text[i + 1] === "{") {
      const end = findMacroEnd(text, i);
      if (end === -1) {
        // 未闭合，当普通文本
        buffer += text.slice(i);
        break;
      }

      const inner = text.slice(i + 2, end);
      const parsed = parseMacroInner(inner);

      if (parsed) {
        if (buffer) {
          tokens.push({ type: "text", value: buffer });
          buffer = "";
        }
        tokens.push(parsed);
      } else {
        // 不是合法宏，原样保留
        buffer += text.slice(i, end + 2);
      }

      i = end + 2;
      continue;
    }

    buffer += text[i];
    i++;
  }

  if (buffer) tokens.push({ type: "text", value: buffer });

  // 还原转义占位符
  return tokens.map(t =>
    t.type === "text"
      ? { ...t, value: t.value.replace(/\u0000LBRACE\u0000/g, "{{").replace(/\u0000RBRACE\u0000/g, "}}") }
      : t
  );
}

/**
 * 从 start（指向 "{{"）开始，找配平的结束位置（返回第二个 } 的索引）。
 * 处理嵌套：{{a {{b}} c}} → 最外层结束在最后一个 }}。
 */
function findMacroEnd(text, start) {
  let depth = 0;
  let i = start;
  while (i < text.length - 1) {
    if (text[i] === "{" && text[i + 1] === "{") {
      depth++;
      i += 2;
      continue;
    }
    if (text[i] === "}" && text[i + 1] === "}") {
      depth--;
      if (depth === 0) return i;
      i += 2;
      continue;
    }
    i++;
  }
  return -1;
}

/** 解析 {{...}} 内部内容。返回 null 表示不是宏。 */
function parseMacroInner(inner) {
  let s = inner;

  // 注释：{{// 内容}}
  if (s.trimStart().startsWith("//")) {
    return { type: "comment", raw: `{{${inner}}}` };
  }

  // 提取 flags（前缀符号）
  const flags = [];
  s = s.replace(/^\s*([!/#?~>]+)\s*/, (m, f) => {
    flags.push(...f.split(""));
    return "";
  });

  const trimmed = s.trim();
  if (!trimmed) return null;

  // 用 :: 分隔；无 :: 时用首个空格分隔宏名与单个参数
  let name;
  let args;

  if (trimmed.includes("::")) {
    const parts = splitTopLevel(trimmed, "::");
    name = parts[0].trim();
    args = parts.slice(1).map(p => p.trim());
  } else {
    const sp = trimmed.search(/\s/);
    if (sp === -1) {
      name = trimmed;
      args = [];
    } else {
      name = trimmed.slice(0, sp);
      args = [trimmed.slice(sp + 1).trim()];
    }
  }

  // 宏名合法性：字母开头（普通宏），或以 . / $ 开头（变量简写）
  const isShorthand = /^[.$][A-Za-z_][\w-]*$/.test(name);
  const isPlain = /^[A-Za-z][\w-]*$/.test(name);
  if (!isShorthand && !isPlain) return null;

  return {
    type: "macro",
    name: isShorthand ? name[0] : name,
    nameLower: (isShorthand ? name[0] : name).toLowerCase(),
    args: isShorthand ? [name.slice(1), ...args] : args,
    flags,
    raw: `{{${inner}}}`
  };
}

/** 按分隔符切分，但不切分嵌套的 {{...}} 内部。 */
function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0;
  let cur = "";
  let i = 0;

  while (i < text.length) {
    if (text[i] === "{" && text[i + 1] === "{") {
      depth++;
      cur += "{{";
      i += 2;
      continue;
    }
    if (text[i] === "}" && text[i + 1] === "}") {
      depth--;
      cur += "}}";
      i += 2;
      continue;
    }
    if (depth === 0 && text.startsWith(sep, i)) {
      parts.push(cur);
      cur = "";
      i += sep.length;
      continue;
    }
    cur += text[i];
    i++;
  }
  parts.push(cur);
  return parts;
}

/**
 * 宏注册表。
 * 每个宏：{ name, fn(args, ctx), aliases? }
 * fn 返回字符串（或 undefined 表示不处理，保留原样）
 */
export class MacroRegistry {
  constructor() {
    this._macros = new Map(); // lowerName → { fn, name }
  }

  /** 注册一个宏。 */
  define(name, fn, aliases = []) {
    const entry = { fn, name };
    this._macros.set(name.toLowerCase(), entry);
    for (const a of aliases) this._macros.set(a.toLowerCase(), entry);
    return this;
  }

  /** 批量注册。 */
  defineAll(defs) {
    for (const [name, fn] of Object.entries(defs)) {
      this.define(name, fn);
    }
    return this;
  }

  has(name) {
    return this._macros.has(String(name).toLowerCase());
  }

  resolve(name) {
    return this._macros.get(String(name).toLowerCase()) || null;
  }

  /** 已注册的宏名（用于诊断）。 */
  names() {
    return [...this._macros.keys()].sort();
  }
}

/**
 * 渲染文本：把所有宏替换成实际值。
 *
 * @param {string} text - 含宏的模板
 * @param {MacroRegistry} registry
 * @param {object} ctx - 上下文（char / user / persona / variables / 等）
 * @param {{ depth?: number, strict?: boolean }} [opts]
 * @returns {string}
 */
export function render(text, registry, ctx = {}, opts = {}) {
  const { depth = 0, strict = false } = opts;

  if (typeof text !== "string" || !text) return text || "";
  if (depth > MAX_DEPTH) return text; // 超深嵌套直接返回原文，防爆栈

  const tokens = tokenize(text);
  let out = "";

  for (const tok of tokens) {
    if (tok.type === "text") {
      out += tok.value;
      continue;
    }
    if (tok.type === "comment") {
      continue; // 注释不输出
    }

    // 宏：先解析参数里的嵌套宏
    const resolvedArgs = tok.args.map(a => render(a, registry, ctx, { depth: depth + 1, strict }));

    const entry = registry.resolve(tok.nameLower);
    if (!entry) {
      // 未注册的宏：strict 模式抛错，否则原样保留（保留 ST 兼容性）
      if (strict) throw new Error(`Unknown macro: {{${tok.name}}}`);
      out += tok.raw;
      continue;
    }

    let value;
    try {
      value = entry.fn(resolvedArgs, ctx, { name: tok.name, flags: tok.flags, registry, render });
    } catch (e) {
      // 单个宏失败不应毁掉整段文本
      if (strict) throw e;
      out += tok.raw;
      continue;
    }

    if (value === undefined || value === null) {
      out += tok.raw; // 宏自己表示"不处理"
      continue;
    }

    const str = String(value);
    // 宏产出的内容里若还有宏，继续解析（如 setvar 存了含宏的值）
    out += str.includes("{{") ? render(str, registry, ctx, { depth: depth + 1, strict }) : str;
  }

  return out;
}

/** 检查文本里是否含宏（用于跳过无宏文本的解析开销）。 */
export function hasMacros(text) {
  if (typeof text !== "string") return false;
  // 只含转义形式的 {{ 不算有宏
  return /(?<!\\)\{\{[^}]*\}\}/.test(text);
}

/** 列出文本里用到的宏名（诊断用）。 */
export function usedMacros(text) {
  if (!hasMacros(text)) return [];
  const names = new Set();
  for (const tok of tokenize(text)) {
    if (tok.type === "macro") names.add(tok.name);
  }
  return [...names].sort();
}
