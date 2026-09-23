// lib/macros/scope.js — 作用域宏预处理
//
// ST 支持块级语法：{{if cond}}内容{{/if}}、{{#setvar x}}多行{{/setvar}}
// 这类结构在扁平 tokenize 之前先处理掉，避免引擎复杂度失控。
//
// 关键：块标签的参数里可能含嵌套宏（{{if {{getvar::x}} }}），
//       所以找标签边界必须配平 {{ }}，不能简单用 [^}]*。

import { isFalsy } from "./registry.js";

/**
 * 扫描文本，找出所有块开始标签。
 * 返回 [{ start, end, preserveWs, name, argsRaw, args }]
 */
function findOpenTags(text) {
  const tags = [];
  let i = 0;

  while (i < text.length - 1) {
    if (text[i] !== "{" || text[i + 1] !== "{") {
      i++;
      continue;
    }

    // 找配平的结束位置
    let depth = 0;
    let j = i;
    let end = -1;
    while (j < text.length - 1) {
      if (text[j] === "{" && text[j + 1] === "{") {
        depth++;
        j += 2;
        continue;
      }
      if (text[j] === "}" && text[j + 1] === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
        j += 2;
        continue;
      }
      j++;
    }

    if (end === -1) break;

    const inner = text.slice(i + 2, end);
    const parsed = parseOpenTag(inner);

    if (parsed) {
      tags.push({ start: i, end: end + 2, ...parsed });
    }

    i = end + 2;
  }

  return tags;
}

/** 判断文本里是否有顶层的分隔符（不在嵌套 {{...}} 内）。 */
function hasTopLevelSeparator(text, sep) {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "{" && text[i + 1] === "{") { depth++; i += 2; continue; }
    if (text[i] === "}" && text[i + 1] === "}") { depth--; i += 2; continue; }
    if (depth === 0 && text.startsWith(sep, i)) return true;
    i++;
  }
  return false;
}

/** 解析开始标签内容。返回 null 表示不是块开始。 */
function parseOpenTag(inner) {
  // 跳过注释
  if (inner.trimStart().startsWith("//")) return null;

  let s = inner.trim();
  if (!s) return null;

  // 闭标签
  if (s.startsWith("/")) return null;

  // flags
  let preserveWs = false;
  s = s.replace(/^\s*([#]+)\s*/, () => {
    preserveWs = true;
    return "";
  });
  // 其他 flags 忽略
  s = s.replace(/^\s*[!/?~>]+\s*/, "");

  // 含顶层 :: 的是内联形式，不是块（嵌套宏里的 :: 不算）
  if (hasTopLevelSeparator(s, "::")) return null;

  const sp = s.search(/\s/);
  const name = sp === -1 ? s : s.slice(0, sp);
  const argsRaw = sp === -1 ? "" : s.slice(sp + 1).trim();

  if (!/^[A-Za-z][\w-]*$/.test(name)) return null;

  return {
    preserveWs,
    name,
    argsRaw,
    args: argsRaw ? [argsRaw] : []
  };
}

/** 找 name 对应的闭标签（从 from 开始），返回 { start, end } 或 null。 */
function findCloseTag(text, name, from) {
  const re = new RegExp(`\\{\\{\\s*/\\s*${name}\\s*\\}\\}`, "g");
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

/**
 * 处理所有作用域块（由内向外）。
 *
 * @param {string} text
 * @param {(name, args, content, ctx) => string|undefined} evaluator
 * @param {object} ctx
 * @param {number} [depth]
 */
export function resolveScopedBlocks(text, evaluator, ctx, depth = 0) {
  if (typeof text !== "string" || !text.includes("{{")) return text;
  if (depth > 8) return text;

  const opens = findOpenTags(text);
  if (opens.length === 0) return text;

  // 为每个 open 找它的闭标签；取"区间最小"的那一对（最内层）
  let best = null;

  for (const open of opens) {
    const close = findCloseTag(text, open.name, open.end);
    if (!close) continue;

    const span = close.end - open.start;
    if (!best || span < best.span) {
      best = { open, close, span };
    }
  }

  if (!best) return text;

  const { open, close } = best;
  const content = open.preserveWs ? text.slice(open.end, close.start) : trimScoped(text.slice(open.end, close.start));

  const evaluated = evaluator(open.name.toLowerCase(), open.args, content, ctx);

  const replacement = evaluated === undefined
    ? text.slice(open.start, close.end) // 未识别 → 原样保留
    : String(evaluated);

  const out = text.slice(0, open.start) + replacement + text.slice(close.end);

  // 可能还有块，递归
  return out.includes("{{") ? resolveScopedBlocks(out, evaluator, ctx, depth + 1) : out;
}

/** ST 的作用域内容修剪：去掉首尾空白 + 统一去掉首行缩进。 */
export function trimScoped(content) {
  let s = content.replace(/^\n+/, "").replace(/\n+$/, "");
  const lines = s.split("\n");

  let indent = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(/^[ \t]*/);
    indent = m ? m[0] : "";
    break;
  }

  if (indent) {
    s = lines.map(line => (line.startsWith(indent) ? line.slice(indent.length) : line)).join("\n");
  }

  return s.trim();
}

/**
 * 默认的块求值器：处理 {{if}} / {{else}} / {{setvar}} 等块级形式。
 */
export function createScopeEvaluator(registry) {
  return (name, args, content, ctx) => {
    // {{if cond}}...{{else}}...{{/if}}
    if (name === "if") {
      // 条件本身可能含宏（{{if {{getvar::x}} }}），先解析再判断
      let cond = args[0] ?? "";
      if (typeof cond === "string" && cond.includes("{{")) {
        const entry = ctx.__render;
        cond = entry ? entry(cond, ctx) : cond;
      }

      const elseIdx = content.indexOf("{{else}}");
      if (elseIdx === -1) {
        return isFalsy(cond) ? "" : content;
      }
      const thenPart = content.slice(0, elseIdx);
      const elsePart = content.slice(elseIdx + "{{else}}".length);
      return isFalsy(cond) ? elsePart : thenPart;
    }

    // 注释块
    if (name === "//" || name === "comment") {
      return "";
    }

    // {{#setvar name}}多行内容{{/setvar}}
    if (name === "setvar" || name === "setglobalvar") {
      const varName = args[0];
      if (!varName) return "";
      const isGlobal = name === "setglobalvar";
      const store = isGlobal ? ctx.globalVariables : ctx.variables;
      if (store) {
        store[varName] = content;
        ctx.onVariableChange?.(varName, content, isGlobal);
      }
      return "";
    }

    // 其余块形式转发给注册表（如 {{reverse}}多行{{/reverse}}）
    const entry = registry.resolve(name);
    if (entry) {
      const v = entry.fn([...args, content], ctx, { name, flags: [], registry, render: () => content });
      return v === undefined ? undefined : String(v);
    }

    return undefined;
  };
}
