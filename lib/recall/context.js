// lib/recall/context.js — 召回账本（一次性 ReAct 会话的状态）
//
// 骨架照抄 Sirchmunk 的 SearchContext（src/sirchmunk/schema/search_context.py）：
//   · token 预算扣减（LLM 使用量，来自 API usage，非估算）
//   · 循环计数（ReAct 迭代次数）
//   · 条目去重（已完整读过的条目不再重复读）
//   · 检索日志（诊断用，不入预算）
//
// 与记忆面板（lib/memory/config.js）的边界：
//   · 那个是 App 级偏好（配置），这是**这一轮**的账。
//   · 每次发消息 = 一个新的 RecallContext，用完即弃。
//
// 为什么单独一个类、不塞进 index.js：
//   账本的生命周期跟倒排索引不一样。索引可能常驻，账本跟着一次会话走。
//   混在一起会让"这个 session 用了多少预算"变得含糊。

export const DEFAULTS = {
  maxTokenBudget: 8000,
  maxLoops: 3
};

export class RecallContext {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxTokenBudget=8000] LLM token 预算上限
   * @param {number} [opts.maxLoops=3]          ReAct 循环上限
   */
  constructor({ maxTokenBudget, maxLoops } = {}) {
    this.maxTokenBudget = Number(maxTokenBudget) > 0
      ? Math.floor(Number(maxTokenBudget))
      : DEFAULTS.maxTokenBudget;
    this.maxLoops = Number(maxLoops) > 0
      ? Math.floor(Number(maxLoops))
      : DEFAULTS.maxLoops;

    this.totalLLMTokens = 0;
    this.llmUsages = [];
    this.readEntryIds = new Set();
    this.retrievalLogs = [];
    this.searchHistory = [];
    this.loopCount = 0;
    this.startTime = Date.now();
    this.telemetry = {};
  }

  // ── token 记账 ───────────────────────────────────────

  /** 累加一次 LLM 调用的 token 数。usage 可选。 */
  addLLMTokens(tokens, usage) {
    const n = Math.max(0, Number(tokens) || 0);
    this.totalLLMTokens += n;
    if (usage && typeof usage === "object") {
      this.llmUsages.push(usage);
    }
  }

  /** 预算是否已超。注意是**大于**，不是等于。 */
  isBudgetExceeded() {
    return this.totalLLMTokens > this.maxTokenBudget;
  }

  /** 剩余预算；不为负。 */
  get budgetRemaining() {
    return Math.max(0, this.maxTokenBudget - this.totalLLMTokens);
  }

  // ── 条目去重 ────────────────────────────────────────

  markEntryRead(id) {
    this.readEntryIds.add(String(id));
  }

  isEntryRead(id) {
    return this.readEntryIds.has(String(id));
  }

  // ── 日志 ────────────────────────────────────────────

  /** 记录一次工具调用（诊断用，不影响预算）。 */
  addLog(toolName, tokens = 0, metadata = {}) {
    this.retrievalLogs.push({
      toolName: String(toolName || ""),
      tokens: Number(tokens) || 0,
      metadata: metadata && typeof metadata === "object" ? metadata : {},
      ts: new Date().toISOString()
    });
  }

  addSearch(query) {
    this.searchHistory.push(String(query ?? ""));
  }

  // ── 循环 ────────────────────────────────────────────

  incrementLoop() { this.loopCount += 1; }

  isLoopLimitReached() { return this.loopCount >= this.maxLoops; }

  /** 一行摘要（诊断用）。 */
  summary() {
    return `loops=${this.loopCount}/${this.maxLoops} `
      + `tokens=${this.totalLLMTokens}/${this.maxTokenBudget} `
      + `reads=${this.readEntryIds.size} `
      + `searches=${this.searchHistory.length}`;
  }
}

export default RecallContext;
