// lib/lore/trace.js — 激活追踪
//
// "为什么这条被激活 / 为什么没被激活"——诊断世界书行为的唯一手段。
// 规格来源：DiceFrame src/lorebook/trace.py 的理念
//
// 关键：trace 的原因必须来自**实际执行的判定**，不能事后重算。
// 因此 matcher 在判定时就把结果写进 lastDecisions，本模块只做汇总呈现。

/** 原因码 → 人话。 */
const REASON_TEXT = {
  disabled: "已停用",
  hidden: "不可见",
  vector_channel: "通道不符（仅向量）",
  cooldown: "冷却中",
  delay: "未到 delay 回合",
  delay_until_recursion: "仅递归阶段激活",
  non_recursable: "不允许被递归到达",
  recursion_level: "未达 recursionLevel",
  scan_depth: "超出 scanDepth",
  probability_rejected: "概率未通过",
  group_lost: "分组竞争落选",
  keyword: "关键词命中",
  constant: "常量条目",
  sticky: "sticky 保持",
  semantic: "语义召回",
  recursive: "递归激活"
};

/**
 * 从 matcher 的判定快照生成可读的激活报告。
 *
 * @param {KeywordMatcher} matcher
 * @param {object[]} activated - matcher.match() 的返回
 * @param {object} [opts]
 * @returns {object}
 */
export function buildActivationTrace(matcher, activated, opts = {}) {
  const { entriesById = null, budgetInfo = null } = opts;

  const decisions = matcher?.lastDecisions || new Map();

  const activatedList = [];
  const blockedList = [];

  for (const [id, d] of decisions) {
    const entry = entriesById?.get?.(id) || null;
    const isActivated = d.outcome === "activated";
    const code = d.reasonCode || "";
    const row = {
      id,
      name: entry?.name ?? "",
      activated: isActivated,
      reason: REASON_TEXT[code] || code || (isActivated ? "激活" : "未激活"),
      reasonCode: code,
      channel: d.channel || "",
      depth: d.depth ?? 0,
      parent: d.parent || "",
      probability: d.probability || null,
      group: d.group || null,
      timed: d.timed || null,
      directMatch: d.depth === 0
    };

    if (isActivated) activatedList.push(row);
    else blockedList.push(row);
  }

  // 激活但没进最终结果的（被预算裁掉）
  const cutByBudget = [];
  if (budgetInfo?.omitted?.length) {
    for (const id of budgetInfo.omitted) {
      const entry = entriesById?.get?.(id) || null;
      cutByBudget.push({ id, name: entry?.name ?? "", reason: "超出预算" });
    }
  }

  return {
    summary: {
      scanned: decisions.size,
      activated: activatedList.length,
      blocked: blockedList.length,
      finalCount: (activated || []).length,
      cutoff: matcher?.lastCutoff || "",
      budget: budgetInfo ? { used: budgetInfo.used, omitted: budgetInfo.omitted.length } : null
    },
    activated: activatedList,
    blocked: blockedList,
    cutByBudget
  };
}

/** 把 trace 渲染成人读的文本。 */
export function formatTrace(trace) {
  if (!trace) return "";
  const lines = [];
  const s = trace.summary;

  lines.push(`扫描 ${s.scanned} 条 · 激活 ${s.activated} · 拦截 ${s.blocked} · 最终 ${s.finalCount}`);
  if (s.cutoff) lines.push(`⚠ 递归被截断: ${s.cutoff}`);
  if (s.budget) lines.push(`预算: 已用 ${s.budget.used} 字符, 裁掉 ${s.budget.omitted} 条`);

  if (trace.activated.length) {
    lines.push("\n已激活:");
    for (const r of trace.activated) {
      lines.push(`  ✓ ${r.name || r.id}  [${r.reason}]${r.depth ? ` depth=${r.depth}` : ""}`);
    }
  }

  if (trace.blocked.length) {
    lines.push("\n未激活:");
    for (const r of trace.blocked) {
      lines.push(`  ✗ ${r.name || r.id}  [${r.reason}]`);
    }
  }

  if (trace.cutByBudget.length) {
    lines.push("\n因预算裁剪:");
    for (const r of trace.cutByBudget) {
      lines.push(`  ⊘ ${r.name || r.id}`);
    }
  }

  return lines.join("\n");
}
