// lib/lore/activation.js — 激活判定的纯函数层
//
// 规格来源：DiceFrame src/lorebook/activation.py（逐函数对齐）
//
// 本模块只放"单条判定"的纯函数，不做索引、不做递归——那些在 matcher.js。
//
// ⚠️ 命名约定：DiceFrame 用 snake_case，本实现用 camelCase。
//    所有读取函数同时接受两种写法（见 readCounter），以兼容 ST 导入数据。

// ── selectiveLogic（ST 副键逻辑） ──

/** ST world_info_logic: 0=AND_ANY 1=NOT_ALL 2=NOT_ANY 3=AND_ALL */
export const ST_SELECTIVE_LOGIC = {
  0: "and_any",
  1: "not_all",
  2: "not_any",
  3: "and_all"
};

const SELECTIVE_ALIASES = {
  "": "and_any",
  "0": "and_any", "1": "not_all", "2": "not_any", "3": "and_all",
  "and": "and_any", "and_any": "and_any", "any": "and_any", "or": "and_any",
  "and_all": "and_all", "all": "and_all",
  "not_any": "not_any",
  "not_all": "not_all"
};

/**
 * 归一化 selectiveLogic。
 * 未知值回退 and_any（ST 默认）——不发明新模式，且主键仍必须匹配。
 */
export function normalizeSelectiveLogic(value) {
  if (value === undefined || value === null) return "and_any";
  const raw = String(value).trim().toLowerCase();
  return SELECTIVE_ALIASES[raw] ?? "and_any";
}

/** 主键匹配模式（DiceFrame legacy 词汇，与副键逻辑分开）。 */
export const PRIMARY_MATCH_MODES = new Set(["any", "all", "not_any", "not_all"]);

export function normalizePrimaryMatchMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  return PRIMARY_MATCH_MODES.has(mode) ? mode : "any";
}

// ── 概率 ──

/**
 * 概率判定。configured >= 100 时直接通过（不做无谓随机）。
 * @returns {{ accepted: boolean, configured: number, roll: number }}
 */
export function evaluateProbability(entry, rng = Math.random) {
  const configured = Math.max(0, Math.min(100, Number(entry?.probability ?? 100) || 0));
  if (configured >= 100) {
    return { accepted: true, configured, roll: 0 };
  }
  const roll = Math.floor(rng() * 100) + 1;
  return { accepted: roll <= configured, configured, roll };
}

// ── 匹配分数（ST getScore 兼容） ──

/**
 * 计算条目在分组竞争里的分数。
 * 主键每命中一个计 1 分；副键只在"正向逻辑"下加分：
 *   and_any → 每个命中都加
 *   and_all → 全部命中才加（加命中数）
 *   not_any / not_all → 永不加分
 */
export function matchedKeyScore(entry, primaryHits = [], secondaryHits = []) {
  if (!primaryHits || primaryHits.length === 0) return 0;

  let score = primaryHits.filter(Boolean).length;
  if (!secondaryHits || secondaryHits.length === 0) return score;

  const logic = normalizeSelectiveLogic(entry?.selectiveLogic ?? entry?.selective_logic);
  if (logic === "and_any") {
    score += secondaryHits.filter(Boolean).length;
  } else if (logic === "and_all" && secondaryHits.every(Boolean)) {
    score += secondaryHits.filter(Boolean).length;
  }
  return score;
}

// ── 递归资格 ──

/**
 * 判断条目是否有资格参与递归展开。
 *
 * ⚠️ 这只是"递归资格"的一道门。完整的递归 eligibility 还包含
 *    nonRecursable / scanDepth / recursionLevel —— 那些在 matcher 的
 *    eligibilityReason 里统一处理（因为需要 depth 与 pass 上下文）。
 */
export function eligibleForRecursion(entry, depth, { recursivePass = false } = {}) {
  if (!entry || entry.enabled === false) return false;
  if (entry.delayUntilRecursion && !recursivePass) return false;

  const level = Number(entry.recursionLevel ?? 0) || 0;
  return level <= 0 || depth >= level;
}

/**
 * 条目内容是否能进入递归缓冲区。
 *
 * ⚠️ DiceFrame 同时检查两个字段：
 *    prevent_further_recursion → 不让内容去扫描别的条目
 *    non_recursable            → 自身不允许"通过递归被到达"，其内容也不该成为扫描源
 * 漏掉后者会让 nonRecursable 条目的内容仍然扩散。
 */
export function nextRecursionBuffer(entry) {
  if (!entry) return "";
  if (entry.preventRecursion || entry.nonRecursable) return "";
  return String(entry?.content ?? "");
}

// ── 定时效果（sticky / cooldown / delay） ──

/** 计数键名（与 DiceFrame 一致）。 */
export const TIMED_COUNTER_KEYS = [
  "stickyRemaining", "cooldownRemaining", "delayRemaining", "pendingCooldown"
];

/** 读取计数，同时接受 camelCase 与 snake_case。 */
export function readCounter(state, name) {
  if (!state) return 0;
  const snake = name.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  const raw = state[name] ?? state[snake] ?? 0;
  return Math.max(0, Number(raw) || 0);
}

/** 创建空的定时状态。 */
export function createTimedState() {
  return {};
}

/** 该条目当前是否因 sticky 而处于激活中。 */
export function stickyActive(state) {
  if (!state || typeof state !== "object") return false;
  // legacy 形状：{ status: "active", remaining: n }
  if (String(state.status ?? "") === "active" && Number(state.remaining ?? 0) > 0) {
    return true;
  }
  return readCounter(state, "stickyRemaining") > 0;
}

/**
 * 唯一的 cooldown / legacy-delay 闸门。
 *
 * 所有候选通道（关键词 / 模糊 / 语义 / 递归）共用，避免只对初始种子生效。
 * sticky 生效中的条目永不被挡——它的 cooldown 还没开始计时。
 */
export function timedGateBlocked(state) {
  if (!state || typeof state !== "object") return false;
  if (stickyActive(state)) return false;
  const status = String(state.status ?? "");
  if ((status === "cooldown" || status === "delayed" || status === "delay")
      && Number(state.remaining ?? 0) > 0) {
    return true;
  }
  return readCounter(state, "cooldownRemaining") > 0
      || readCounter(state, "delayRemaining") > 0;
}

/** legacy 形状的 delay 计数器是否仍在跑。 */
export function legacyDelayBlocked(state) {
  if (!state || typeof state !== "object") return false;
  const status = String(state.status ?? "");
  if (status === "delayed" || status === "delay") {
    return Number(state.remaining ?? 0) > 0;
  }
  return readCounter(state, "delayRemaining") > 0;
}

/**
 * delay 前置门：还没到该生效的回合数时挡下。
 *
 * ⚠️ 语义（DiceFrame 明确）：delay 是对 authoritative turn tick 的**前置门**，
 *    不是激活后的倒计时。delay=5 意味着"第 5 回合之前不激活"，
 *    而不是"立刻激活然后自己封 5 回合"。
 *    currentTick 为 null 表示调用方没有 tick 权威 → 跳过该门（不假装知道）。
 */
export function delayGateBlocked(entry, currentTick = null) {
  if (currentTick === null || currentTick === undefined) return false;
  const delay = Math.max(0, Number(entry?.delay ?? 0) || 0);
  return delay > 0 && Number(currentTick) < delay;
}

/**
 * 条目激活后布置定时状态。
 *
 * 生命周期（与 ST 一致）：
 *     inactive → activated → sticky_active → cooldown → inactive
 *
 * cooldown 只在 sticky 生效期间"待命"，sticky 窗口结束后才开始倒计时
 * （见 advanceTimedState）。否则条目会被自己的 cooldown 挡住。
 *
 * ⚠️ 重触发不会刷新正在跑的计时器：sticky 或 cooldown 仍有剩余时直接返回。
 * ⚠️ delay 不在这里落计数器——它是前置门，不是倒计时。
 *
 * @param {object} state - 就地修改（与 DiceFrame 一致）
 * @param {{ sticky?: number, cooldown?: number, activatedTick?: number }} timers
 * @returns {object} 同一个 state（便于链式使用）
 */
export function armTimedActivation(state, timers = {}) {
  const target = state || {};
  const sticky = Math.max(0, Number(timers.sticky ?? 0) || 0);
  const cooldown = Math.max(0, Number(timers.cooldown ?? 0) || 0);
  const activatedTick = Number(timers.activatedTick ?? 0) || 0;

  if (sticky <= 0 && cooldown <= 0) return target;

  // 已在计时 → 不刷新
  if (readCounter(target, "stickyRemaining") > 0) return target;
  if (readCounter(target, "cooldownRemaining") > 0) return target;

  if (sticky > 0) {
    target.stickyRemaining = sticky;
    target.pendingCooldown = cooldown;
  } else {
    target.cooldownRemaining = cooldown;
    target.pendingCooldown = 0;
  }
  target.activatedTick = activatedTick;
  return target;
}

/**
 * 推进一个 authoritative tick。返回 true 表示所有计数器都已归零。
 *
 * sticky 先跑到 0，然后才启动待命的 cooldown——条目永不会被自己的 cooldown
 * 在 sticky 窗口内挡住。delayRemaining 只为 legacy 存档保留。
 */
export function advanceTimedState(state) {
  if (!state || typeof state !== "object") return true;

  let sticky = readCounter(state, "stickyRemaining");
  let cooldown = readCounter(state, "cooldownRemaining");
  let delay = readCounter(state, "delayRemaining");
  let pending = readCounter(state, "pendingCooldown");

  if (sticky > 0) {
    sticky -= 1;
    if (sticky === 0 && pending > 0) {
      cooldown = pending;
      pending = 0;
    }
  } else if (cooldown > 0) {
    cooldown -= 1;
  }
  if (delay > 0) delay -= 1;

  state.stickyRemaining = sticky;
  state.cooldownRemaining = cooldown;
  state.delayRemaining = delay;
  state.pendingCooldown = pending;

  return sticky <= 0 && cooldown <= 0 && delay <= 0 && pending <= 0;
}

/**
 * 把 legacy 定时状态迁成规范形状（幂等）。
 *
 * 同时修复修复前的坏形状：同一次激活同时写入 stickyRemaining 与
 * cooldownRemaining —— cooldown 会被移回 pendingCooldown。
 */
export function migrateTimedState(state) {
  const out = {};
  for (const [id, raw] of Object.entries(state || {})) {
    if (!raw || typeof raw !== "object") continue;

    const hasCounter = TIMED_COUNTER_KEYS.some(k => k in raw);
    if (hasCounter) {
      let sticky = readCounter(raw, "stickyRemaining");
      let cooldown = readCounter(raw, "cooldownRemaining");
      let pending = readCounter(raw, "pendingCooldown");
      // 修复坏形状：sticky 与 cooldown 同时生效 → cooldown 退回 pending
      if (sticky > 0 && cooldown > 0) {
        pending = Math.max(pending, cooldown);
        cooldown = 0;
      }
      out[String(id)] = {
        stickyRemaining: sticky,
        cooldownRemaining: cooldown,
        delayRemaining: readCounter(raw, "delayRemaining"),
        pendingCooldown: pending,
        activatedTick: Number(raw.activatedTick ?? raw.activated_tick ?? 0) || 0
      };
      continue;
    }

    // 更老的形状：{ status, remaining }
    const remaining = Math.max(0, Number(raw.remaining ?? 0) || 0);
    const status = String(raw.status ?? "");
    if (status === "delayed" || status === "delay") {
      // 旧 delayed 记的是"还剩几轮"，新语义是"第 N 回合前不激活"，
      // 无法精确等价 → 安全迁成"无 active state"，由 delay 字段重新判定。
      continue;
    }
    out[String(id)] = {
      stickyRemaining: status === "active" ? remaining : 0,
      cooldownRemaining: status === "cooldown" ? remaining : 0,
      delayRemaining: 0,
      pendingCooldown: 0,
      activatedTick: Number(raw.activatedTick ?? raw.activated_tick ?? 0) || 0
    };
  }
  return out;
}

// ── 关键词匹配 ──

/** 判断是否为正则键（ST 约定：/pattern/flags）。 */
export function parseRegexKey(key) {
  const s = String(key ?? "").trim();
  const m = s.match(/^\/(.+)\/([gimsuy]*)$/s);
  if (!m) return null;
  try {
    return new RegExp(m[1], m[2]);
  } catch {
    return null; // 无效正则 → 当作普通文本处理
  }
}

/** 转义正则特殊字符。 */
export function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 正则编译缓存。
 *
 * keyMatches 在候选发现阶段被高频调用（全量遍历），
 * 每次 new RegExp 是重操作。缓存按「pattern + flags」键。
 *
 * 上限保护：超过 MAX_REGEX_CACHE 就整体清空——
 * 避免长期运行下被非常规 key 集撑大（世界书是有限集，正常不会触发）。
 */
const REGEX_CACHE = new Map();
const MAX_REGEX_CACHE = 2000;

function cachedRegex(pattern, flags) {
  const cacheKey = `${flags}\u0000${pattern}`;
  let re = REGEX_CACHE.get(cacheKey);
  if (re !== undefined) return re;

  try {
    re = new RegExp(pattern, flags);
  } catch {
    re = null;   // 无效正则也缓存，避免反复尝试编译
  }

  if (REGEX_CACHE.size >= MAX_REGEX_CACHE) REGEX_CACHE.clear();
  REGEX_CACHE.set(cacheKey, re);
  return re;
}

/**
 * 单个关键词是否命中文本。
 *
 * @param {string} key
 * @param {string} text
 * @param {{ caseSensitive?: boolean, matchWholeWords?: boolean, useRegex?: boolean }} opts
 */
export function keyMatches(key, text, opts = {}) {
  if (!key) return false;

  // 正则键：无论 useRegex 开关，ST 都认 /.../ 形式
  const re = parseRegexKey(key);
  if (re) {
    try {
      return re.test(text);
    } catch {
      return false;
    }
  }

  if (opts.useRegex) {
    // useRegex 模式下，非 /../ 形式的键也按正则解释
    const compiled = cachedRegex(key, opts.caseSensitive ? "" : "i");
    if (compiled === null) return false;
    try {
      return compiled.test(text);
    } catch {
      return false;
    }
  }

  const haystack = opts.caseSensitive ? text : text.toLowerCase();
  const needle = opts.caseSensitive ? key : key.toLowerCase();

  if (opts.matchWholeWords) {
    // 整词匹配。
    // 注意：中文不用空格分词，所以不能用 \w / \b 做边界。
    // 策略：若关键词含 CJK 字符，退化为子串匹配（"整词"在中文里不成立）；
    //       否则（纯拉丁/数字）用标准单词边界。
    const flags = opts.caseSensitive ? "" : "i";
    const hasCJK = /[\u4e00-\u9fff\u3040-\u30ff]/.test(key);
    const pattern = hasCJK ? escapeRegex(key) : `\\b${escapeRegex(key)}\\b`;
    const compiled = cachedRegex(pattern, flags);
    if (compiled === null) return haystack.includes(needle);
    try {
      return compiled.test(text);
    } catch {
      return haystack.includes(needle);
    }
  }

  return haystack.includes(needle);
}

/** 从条目读关键词数组（兼容 keywords / secondaryKeys 的两种写法）。 */
export function readKeys(entry, field) {
  const snake = field.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  const raw = entry?.[field] ?? entry?.[snake] ?? [];
  if (Array.isArray(raw)) {
    return raw.map(k => String(k ?? "").trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(k => String(k ?? "").trim()).filter(Boolean);
      }
    } catch { /* 当单个关键词处理 */ }
    return raw.trim() ? [raw.trim()] : [];
  }
  return [];
}

/**
 * 计算主键命中情况。
 * @returns {boolean[]} 每个主键是否命中
 */
export function primaryHits(entry, text, { fuzzy = false } = {}) {
  const keys = readKeys(entry, "keywords");
  const opts = {
    caseSensitive: !!entry?.caseSensitive,
    matchWholeWords: !!entry?.matchWholeWords,
    useRegex: entry?.trigger?.type === "regex" || !!entry?.useRegex
  };
  const allowFuzzy = fuzzy && entry?.fuzzyEnabled !== false;
  return keys.map(k => keyMatches(k, text, opts) || (allowFuzzy && fuzzyHit(k, entry, text)));
}

/** 计算副键命中情况。 */
export function secondaryHits(entry, text, { fuzzy = false } = {}) {
  const keys = readKeys(entry, "secondaryKeys");
  const opts = {
    caseSensitive: !!entry?.caseSensitive,
    matchWholeWords: !!entry?.matchWholeWords,
    useRegex: !!entry?.useRegex
  };
  const allowFuzzy = fuzzy && entry?.fuzzyEnabled !== false;
  return keys.map(k => keyMatches(k, text, opts) || (allowFuzzy && fuzzyHit(k, entry, text)));
}

/**
 * 模糊兜底：仅对"朴素、大小写不敏感"的键生效（bigram 命中）。
 * 正则键、整词键、大小写敏感键一律不走模糊。
 */
export const MIN_FUZZY_KEY_LEN = 2;

export function fuzzyHit(keyword, entry, text) {
  if (entry?.useRegex || entry?.matchWholeWords) return false;
  if (String(keyword).startsWith("/")) return false;
  if (entry?.caseSensitive) return false;

  const needle = String(keyword).toLowerCase();
  const haystack = String(text).toLowerCase();
  if (needle.length < MIN_FUZZY_KEY_LEN) return false;

  for (let i = 0; i < needle.length - 1; i++) {
    if (haystack.includes(needle.slice(i, i + 2))) return true;
  }
  return false;
}

/**
 * 副键逻辑判定（ST 语义：主键必须先匹配，这里是第二道闸）。
 *
 * @param {string} logic - and_any | not_all | not_any | and_all
 * @param {boolean[]} hits - 副键命中情况
 */
export function selectiveGatePasses(logic, hits) {
  if (!hits || hits.length === 0) return true; // 没配副键 → 不拦

  const any = hits.some(Boolean);
  const all = hits.every(Boolean);

  switch (logic) {
    case "and_any":  return any;    // 至少命中一个
    case "and_all":  return all;    // 全部命中
    case "not_any":  return !any;   // 一个都不许命中
    case "not_all":  return !all;   // 不允许全部命中
    default:         return any;    // 未知 → and_any
  }
}

/**
 * 单条条目的关键词判定——唯一权威。
 *
 * matcher 与 trace 都读这个函数，保证 trace 报的原因与激活路径一致。
 *
 * @returns {{
 *   matched: boolean, primaryOk: boolean, secondaryOk: boolean|null,
 *   primaryHits: boolean[], secondaryHits: boolean[],
 *   mode: string, logic: string
 * }}
 */
export function keywordDecision(entry, text, { fuzzy = false } = {}) {
  const primaryKeys = readKeys(entry, "keywords");
  const secondaryKeys = readKeys(entry, "secondaryKeys");
  const mode = normalizePrimaryMatchMode(entry?.primaryMatchMode ?? entry?.match_mode);
  const logic = normalizeSelectiveLogic(entry?.selectiveLogic ?? entry?.selective_logic);

  if (primaryKeys.length === 0 && secondaryKeys.length === 0) {
    return {
      matched: false, primaryOk: false, secondaryOk: null,
      primaryHits: [], secondaryHits: [], mode, logic
    };
  }

  const pHits = primaryHits(entry, text, { fuzzy });
  let primaryOk;
  if (mode === "all") {
    primaryOk = primaryKeys.length > 0 && pHits.every(Boolean);
  } else if (mode === "not_any") {
    primaryOk = !pHits.some(Boolean);
  } else if (mode === "not_all") {
    primaryOk = !(primaryKeys.length > 0 && pHits.every(Boolean));
  } else {
    primaryOk = pHits.some(Boolean);
  }

  let secondaryOk = null;
  let sHits = new Array(secondaryKeys.length).fill(false);

  // selective=false 时副键仍保留为数据，但不参与闸门
  const selectiveOn = entry?.selective !== false;
  if (primaryOk && secondaryKeys.length > 0 && selectiveOn) {
    sHits = secondaryHits(entry, text, { fuzzy });
    secondaryOk = selectiveGatePasses(logic, sHits);
  }

  return {
    matched: primaryOk && secondaryOk !== false,
    primaryOk,
    secondaryOk,
    primaryHits: pHits,
    secondaryHits: sHits,
    mode,
    logic
  };
}
