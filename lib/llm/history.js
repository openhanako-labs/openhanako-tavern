// lib/llm/history.js — 对话历史预算与截断
//
// 问题：原来把全部消息塞进请求，长对话必然超限报错。
//
// 策略（滑动窗口 + 摘要锚点）：
//   1. 保留 system 之外最近的 N 条消息
//   2. 超出的部分不直接丢弃，而是压成一条"前情摘要"锚点放在最前
//   3. 摘要锚点本身也有预算上限
//
// 为什么不做真正的 LLM 摘要：那需要额外一次模型调用，成本和延迟都翻倍。
// 这里先做"结构化摘要"（角色+首句），够用且零成本；真正的 LLM 摘要留作后续。

/** 默认估算：非 CJK 部分 4 字符 ≈ 1 token。 */
export const CHARS_PER_TOKEN = 4;

/**
 * CJK 字符每字约 1 token。
 *
 * 旧实现一律按 4 字符/token 估，对中文严重低估（中文实际约 1–1.5 字/token），
 * 结果是中文对话容易超窗而代码浑然不知。
 */
export const CJK_TOKENS_PER_CHAR = 1;

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

/**
 * 估算文本 token，按字符类型加权。
 *
 * CJK 字按 1 token/字，其余按 4 字符/token。
 * 比单一系数更接近真实分词器，尤其是中英混排的对话。
 */
export function estimateTokens(text) {
  const s = String(text ?? "");
  if (!s) return 1;

  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (CJK_RE.test(ch)) cjk += 1;
    else other += 1;
  }

  const tokens = cjk * CJK_TOKENS_PER_CHAR + other / CHARS_PER_TOKEN;
  return Math.max(1, Math.ceil(tokens));
}

/** 估算单条消息的 token（含角色开销）。 */
export function estimateMessageTokens(msg) {
  const content = typeof msg?.content === "string" ? msg.content : "";
  return estimateTokens(content) + 4; // 角色标记开销
}

/**
 * 把消息列表裁剪到预算内。
 *
 * @param {object[]} messages - [{ role, content }]
 * @param {object} [opts]
 * @param {number} [opts.maxTokens] - 历史部分的总预算
 * @param {number} [opts.maxMessages] - 条数硬上限
 * @param {number} [opts.keepRecent] - 至少保留最近多少条（即使超预算）
 * @param {boolean} [opts.summarize] - 是否生成前情摘要锚点
 * @returns {{ messages: object[], dropped: number, droppedMessages: object[], summary: string|null, usedTokens: number }}
 */
export function trimHistory(messages, opts = {}) {
  const {
    maxTokens = 4000,
    maxMessages = 200,
    keepRecent = 4,
    summarize = true
  } = opts;

  const list = Array.isArray(messages) ? messages.filter(m => m && m.role) : [];
  if (list.length === 0) {
    return { messages: [], dropped: 0, droppedMessages: [], summary: null, usedTokens: 0 };
  }

  // 从最新往回累加，直到超预算
  const kept = [];
  let used = 0;

  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i];
    const cost = estimateMessageTokens(msg);

    const wouldExceed = used + cost > maxTokens;
    const wouldExceedCount = kept.length >= maxMessages;

    // 最近 keepRecent 条无论如何保留
    if ((wouldExceed || wouldExceedCount) && kept.length >= keepRecent) {
      break;
    }

    kept.unshift(msg);
    used += cost;
  }

  const dropped = list.length - kept.length;
  const droppedMessages = dropped > 0 ? list.slice(0, dropped) : [];

  // 被丢掉的头部压成摘要锚点
  let summary = null;
  if (dropped > 0 && summarize) {
    summary = buildSummary(droppedMessages);
  }

  // 前缀断点标记。
  //
  // 签名是 provider 侧的「前缀指纹」——描述的是「从对话开头到这里」
  // 这段序列。头部一旦被裁剪（或前面插了摘要），保留下来的消息
  // 前面接的就不再是原来那段了，签名失效。
  //
  // 为什么不直接删掉：rawContent 还留着，万一将来前缀又接回去
  // （比如预算放宽、摘要移除），签名又能用。标记比删除可逆。
  if (dropped > 0) {
    for (const m of kept) m._prefixBroken = true;
  }

  return { messages: kept, dropped, droppedMessages, summary, usedTokens: used };
}

/**
 * 把被丢弃的历史压成一段结构化摘要。
 *
 * 不做 LLM 调用——只提取"发生过什么"的骨架：
 *   - 首条用户消息（通常是场景起点）
 *   - 参与的角色
 *   - 消息条数与大致跨度
 *
 * @param {object[]} dropped
 * @param {{ maxChars?: number }} [opts]
 */
export function buildSummary(dropped, opts = {}) {
  const { maxChars = 600 } = opts;
  if (!Array.isArray(dropped) || dropped.length === 0) return null;

  const lines = [];

  const firstUser = dropped.find(m => m.role === "user");
  if (firstUser?.content) {
    const snippet = String(firstUser.content).replace(/\s+/g, " ").slice(0, 120);
    lines.push(`起点：${snippet}`);
  }

  const roles = new Set(dropped.map(m => m.role));
  if (roles.size > 0) {
    lines.push(`涉及角色：${[...roles].join("、")}`);
  }

  // 最后一条被丢的 assistant 消息（最近的上下文）
  const lastAssistant = [...dropped].reverse().find(m => m.role === "assistant");
  if (lastAssistant?.content) {
    const snippet = String(lastAssistant.content).replace(/\s+/g, " ").slice(0, 120);
    lines.push(`此前进展：${snippet}`);
  }

  lines.push(`（以上 ${dropped.length} 条历史已折叠）`);

  let out = lines.join("\n");
  if (out.length > maxChars) {
    out = out.slice(0, maxChars) + "…";
  }
  return out;
}

/**
 * 合并「上次存下的摘要」与「这次新折叠的部分」。
 *
 * 为什么要合并而不是重算：摘要写回的意义就在于**不用重算**。
 * 长对话里每次生成都丢掉前 40 条、再从头压一遍骨架，
 * 等于每轮都在重复同一件活。
 *
 * 三种情形：
 *   1. 没有旧摘要 → 现算
 *   2. 旧摘要覆盖范围 ≤ 当前折叠数 → 只压「新多出来的那段」再拼上
 *   3. 旧摘要覆盖范围 > 当前折叠数（预算放宽了）→ 旧摘要已失效，重算
 *
 * @param {{text:string, coveredCount:number}|null} previous
 * @param {object[]} droppedMessages
 * @param {{maxChars?: number}} [opts]
 * @returns {{text:string, coveredCount:number}|null}
 */
export function mergeSummary(previous, droppedMessages, opts = {}) {
  const dropped = Array.isArray(droppedMessages) ? droppedMessages : [];
  if (dropped.length === 0) return null;

  const prevText = typeof previous?.text === "string" && previous.text ? previous.text : null;
  const covered = Number(previous?.coveredCount) || 0;

  // 情形 0：旧摘要**是模型写的**，而这一轮又多折了一些。
  //
  // 不能按情形 2 那样把机械骨架拼在后面：那份骨架里带
  //「起点：…」「涉及角色：…」和标注行，拼在模型写的连续叙述后面，
  // 等于在一篇像样的摘要尾巴上钉一块标签，反而把它的可读性毁掉。
  // 正解：保持模型写的那段，只把覆盖范围推到新的折叠数——
  // 少记下那几条比记出一段混杂文字强。（想要那几条进摘要，
  // 用户手边有「让模型重写」那个按钮。）
  if (prevText && previous?.byModel && covered < dropped.length) {
    return { text: prevText, coveredCount: dropped.length, byModel: true };
  }

  // 情形 3：旧摘要盖得比现在还多 → 已经对不上了，重算
  if (prevText && covered > dropped.length) {
    const fresh = buildSummary(dropped, opts);
    return fresh ? { text: fresh, coveredCount: dropped.length } : null;
  }

  // 情形 1 / 2
  const freshPart = dropped.slice(covered);
  const freshText = freshPart.length > 0 ? buildSummary(freshPart, opts) : null;

  if (!prevText) {
    return freshText ? { text: freshText, coveredCount: dropped.length } : null;
  }
  if (!freshText) {
    // 折叠数没变 → 旧摘要原样可用
    return { text: prevText, coveredCount: covered, byModel: !!previous?.byModel };
  }
  return {
    text: `${prevText}\n${freshText}`,
    coveredCount: dropped.length,
    byModel: !!previous?.byModel
  };
}

/**
 * 把摘要锚点插回消息列表最前。
 *
 * @param {object[]} messages - 已裁剪的消息
 * @param {string|null} summary
 * @returns {object[]}
 */
export function attachSummary(messages, summary) {
  if (!summary) return messages;
  return [
    { role: "user", content: `[前情提要]\n${summary}` },
    ...messages
  ];
}

/**
 * 一次性完成：裁剪 + 摘要锚点。
 *
 * @param {object[]} messages
 * @param {object} [opts]
 * @param {{text:string, coveredCount:number}|null} [opts.previousSummary] - 对话上存着的旧摘要
 * @returns {{ messages: object[], dropped: number, usedTokens: number, summaryAttached: boolean, summaryRecord: object|null }}
 */
export function prepareHistory(messages, opts = {}) {
  const { summarize = true, previousSummary = null, summaryFilter = null, ...rest } = opts;
  const r = trimHistory(messages, { summarize: false, ...rest });

  /*
   * summaryFilter：哪些被折叠的消息**不许进摘要**。
   *
   * 私语（带 audience 的消息）走的就是这条：摘要是缓存在对话上的、
   * 所有发言人共用的一份——私语一旦进了它，就等于对所有人公开了。
   * 宁可让它在窗口里自生自灭（旧到被丢掉就丢掉），也不能漏进共享摘要。
   */
  const folded = summaryFilter ? r.droppedMessages.filter(summaryFilter) : r.droppedMessages;
  const summaryRecord = summarize
    ? mergeSummary(previousSummary, folded, rest)
    : null;

  const withSummary = summaryRecord?.text
    ? attachSummary(r.messages, summaryRecord.text)
    : r.messages;

  // 摘要插在最前，同样改变了后面所有消息的前缀。
  if (summaryRecord?.text) {
    for (const m of r.messages) m._prefixBroken = true;
  }

  return {
    messages: withSummary,
    dropped: r.dropped,
    usedTokens: r.usedTokens,
    summaryAttached: !!summaryRecord?.text,
    summaryRecord
  };
}

/**
 * 按总上下文预算分配：历史 / 设定 / 系统提示。
 *
 * @param {number} contextWindow - 模型上下文窗口（token）
 * @param {object} [opts]
 * @param {number} [opts.reserveForOutput] - 给输出留多少
 * @param {number} [opts.systemTokens] - 系统提示占用的估算
 * @param {number} [opts.loreRatio] - 设定占剩余预算的比例
 */
export function allocateBudget(contextWindow, opts = {}) {
  const {
    reserveForOutput = 1000,
    systemTokens = 0,
    loreRatio = 0.3
  } = opts;

  // 上下文窗口缺失/非法时用一个保守但可用的兜底。
  // 调用方应尽量传模型真实的 contextWindow（models.list() 里有）。
  const window = Number(contextWindow) > 0 ? Number(contextWindow) : 8000;

  const available = Math.max(0, window - reserveForOutput - systemTokens);
  const lore = Math.floor(available * loreRatio);
  const history = available - lore;

  return { available, history, lore, system: systemTokens, output: reserveForOutput, window };
}
