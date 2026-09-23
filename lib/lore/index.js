// lib/lore/index.js — 世界书引擎对外接口
//
// 把 matcher / budget / trace 串成一次完整调用：
//   构建索引 → 匹配（含递归）→ 分组竞争 → 预算裁剪 → 追踪
//
// 用法：
//   import { activate } from "./lib/lore/index.js";
//   const result = activate(settings, scanText, { budget: 2000 });
//   // result.entries   最终注入的条目（已按顺序排好）
//   // result.trace     激活报告

import { KeywordMatcher } from "./matcher.js";
import { applyBudget, applyTokenBudget, compareEntries, entrySortKey } from "./budget.js";
import { buildActivationTrace, formatTrace } from "./trace.js";

export { KeywordMatcher, compareSortKeys } from "./matcher.js";
export {
  MAX_RECURSIVE_DEPTH,
  MAX_RECURSION_STEPS,
  MAX_ACTIVATED_ENTRIES,
  MIN_BUDGET_CANDIDATES,
  BUDGET_CANDIDATE_SLACK
} from "./matcher.js";
export * from "./activation.js";
export * from "./budget.js";
export { buildActivationTrace, formatTrace } from "./trace.js";

/**
 * 一次性激活：从设定列表算出该注入哪些条目。
 *
 * @param {object[]} settings - 设定条目（含 keywords / secondaryKeys / selectiveLogic / ...）
 * @param {string} scanText - 扫描文本（通常是最近的对话）
 * @param {object} [opts]
 * @param {number|null} [opts.budget] - 字符预算；null = 不限
 * @param {number|null} [opts.tokenBudget] - token 预算（与 budget 二选一）
 * @param {Map<string,object>} [opts.timedState] - 定时状态
 * @param {(entry) => boolean} [opts.isVisible]
 * @param {number|null} [opts.currentTick]
 * @param {boolean} [opts.includeTrace] - 是否附激活报告
 * @param {() => number} [opts.rng] - 随机源（测试时可注入固定值）
 * @returns {{ entries: object[], trace: object|null, used: number, omitted: string[] }}
 */
export function activate(settings, scanText, opts = {}) {
  const {
    budget = null,
    tokenBudget = null,
    timedState = null,
    isVisible = null,
    isCandidate = null,
    extraCandidates = null,
    currentTick = null,
    maxSteps = null,
    maxActivated = null,
    includeTrace = true,
    rng = Math.random
  } = opts;

  const list = Array.isArray(settings) ? settings : [];

  // 1. 建索引（只对启用的条目建，省一轮判断）
  const matcher = new KeywordMatcher({ rng });
  matcher.build(list.filter(s => s && s.enabled !== false));

  // 2. 匹配 + 递归
  const matchOpts = {
    timedState, isVisible, isCandidate, extraCandidates, currentTick
  };
  if (maxSteps !== null && maxSteps !== undefined) matchOpts.maxSteps = maxSteps;
  if (maxActivated !== null && maxActivated !== undefined) matchOpts.maxActivated = maxActivated;
  const matched = matcher.match(scanText, matchOpts);

  // 3. 预算裁剪
  const effectiveBudget = tokenBudget !== null && tokenBudget !== undefined
    ? null   // token 预算走另一条路径
    : budget;

  let included, omitted, used;

  if (tokenBudget !== null && tokenBudget !== undefined) {
    const r = applyTokenBudget(matched, tokenBudget);
    included = r.included;
    omitted = r.omitted;
    used = r.used;
  } else {
    const r = applyBudget(matched, effectiveBudget);
    included = r.included;
    omitted = r.omitted;
    used = r.used;
  }

  // 4. 最终顺序：
  //    有预算时 applyBudget 已按 compareEntries 排过；
  //    无预算时保留 matcher 的 tier 顺序（core < background < archived）。
  //    这里不能再排一次——那会把 tier 顺序冲掉。

  // 5. 追踪
  let trace = null;
  if (includeTrace) {
    const byId = new Map(list.map(s => [s.id, s]));
    trace = buildActivationTrace(matcher, included, {
      entriesById: byId,
      budgetInfo: { used, omitted }
    });
  }

  return { entries: included, trace, used, omitted, matcher };
}

/**
 * 把激活的条目拼成注入文本。
 *
 * @param {object[]} entries
 * @param {{ header?: string, separator?: string, withName?: boolean }} [opts]
 */
export function renderEntries(entries, opts = {}) {
  const {
    header = "",
    separator = "\n\n",
    withName = false
  } = opts;

  if (!Array.isArray(entries) || entries.length === 0) return "";

  const body = entries
    .map(e => {
      const content = String(e.content ?? "");
      if (!withName) return content;
      return `[${e.name || "设定"}]\n${content}`;
    })
    .join(separator);

  return header ? `${header}\n${body}` : body;
}

/**
 * 按 anchor 把条目分组（供 prompt 组装阶段按位置注入）。
 *
 * anchor 取值（ST position 映射而来）：
 *   before_char / after_char / an_top / an_bottom / at_depth / example_before / example_after / outlet
 *   未映射的条目归入 "unspecified"
 */
export function groupByAnchor(entries) {
  const groups = {
    before_char: [],
    after_char: [],
    an_top: [],
    an_bottom: [],
    at_depth: [],
    example_before: [],
    example_after: [],
    outlet: [],
    unspecified: []
  };

  for (const e of entries || []) {
    const anchor = e.anchor && groups[e.anchor] ? e.anchor : "unspecified";
    groups[anchor].push(e);
  }

  return groups;
}
