// lib/lore/budget.js — 世界书预算与排序
//
// 规格来源：DiceFrame src/lorebook/budget.py
//
// 两级预算：
//   per-book token_budget → 估算 token（CHARS_PER_TOKEN 字符 ≈ 1 token）
//   overall lore budget   → 字符，由调用方传入
//
// 关键：预算的数值不由本模块推导（那是 provider 的 authority），
//       本模块只负责"按给定预算裁剪"。

/** 默认估算口径：4 字符 ≈ 1 token。 */
export const CHARS_PER_TOKEN = 4;

/** 估算条目 token 数。 */
export function estimateEntryTokens(entry) {
  return Math.max(1, Math.floor(String(entry?.content ?? "").length / CHARS_PER_TOKEN));
}

/** 估算条目字符数。 */
export function estimateEntryChars(entry) {
  return Math.max(1, String(entry?.content ?? "").length);
}

/**
 * 确定性排序键。
 *
 * 顺序（照搬 DiceFrame entry_sort_key）：
 *   1. 常量优先（is_constant）
 *   2. 直接匹配优先于递归匹配
 *   3. priority 降序（大的先）
 *   4. order 升序
 *   5. 非递归优先
 *   6. 非 semantic-only 优先
 *   7. id 兜底（保证全序，同分也有稳定结果）
 */
export function entrySortKey(entry, { recursive = null, semanticOnly = null } = {}) {
  const isRecursive = recursive !== null ? recursive : !!entry?._recursive;
  const isSemantic = semanticOnly !== null ? semanticOnly : !!entry?._semanticOnly;

  return [
    entry?._isConstant || entry?.trigger?.type === "always" || entry?.isConstant ? 0 : 1,
    entry?._directMatch ? 0 : 1,
    -Number(entry?.priority ?? 0),
    Number(entry?.order ?? 100),
    isRecursive ? 1 : 0,
    isSemantic ? 1 : 0,
    String(entry?.id ?? "")
  ];
}

/** 比较两个排序键。 */
export function compareEntries(a, b) {
  const ka = entrySortKey(a);
  const kb = entrySortKey(b);
  const len = Math.max(ka.length, kb.length);
  for (let i = 0; i < len; i++) {
    const x = ka[i], y = kb[i];
    if (x === y) continue;
    if (typeof x === "string" || typeof y === "string") {
      return String(x) < String(y) ? -1 : 1;
    }
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 预算最多能容纳多少条目（按最便宜的排，故为上界）。
 *
 * 用途：给递归一个确定性的候选上限。超过这个数量的激活无论如何都进不了
 * 最终预算，因此可以不再展开——而不是"先无限展开、最后才裁"。
 *
 * @returns {number|null} null 表示无预算约束
 */
export function maxEntriesWithinBudget(entries, budget, estimate = estimateEntryChars) {
  if (budget === null || budget === undefined || budget <= 0) return null;

  const costs = entries.map(e => estimate(e)).sort((a, b) => a - b);
  let used = 0;
  let count = 0;
  for (const cost of costs) {
    if (used + cost > budget) break;
    used += cost;
    count++;
  }
  return count;
}

/**
 * 按预算裁剪。
 *
 * @param {object[]} entries
 * @param {number|null} budget - 字符预算
 * @param {Function} [estimate]
 * @returns {{ included: object[], omitted: string[], used: number }}
 */
export function applyBudget(entries, budget, estimate = estimateEntryChars) {
  if (budget === null || budget === undefined || budget <= 0) {
    return { included: [...entries], omitted: [], used: 0 };
  }

  const sorted = [...entries].sort(compareEntries);
  const included = [];
  const omitted = [];
  let used = 0;

  for (const entry of sorted) {
    const cost = Number(estimate(entry));
    if (used + cost <= budget) {
      included.push(entry);
      used += cost;
    } else {
      omitted.push(String(entry?.id ?? ""));
    }
  }

  return { included, omitted, used };
}

/**
 * 按 token 预算裁剪（内部按 CHARS_PER_TOKEN 换算）。
 */
export function applyTokenBudget(entries, tokenBudget) {
  return applyBudget(entries, tokenBudget, estimateEntryTokens);
}
