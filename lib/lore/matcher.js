// lib/lore/matcher.js — 世界书匹配器（统一 eligibility pipeline + 递归）
//
// 规格来源：DiceFrame src/lorebook/matcher.py
//
// 核心不变量（照搬，不简化）：
//   1. 所有候选（关键词 / 模糊 / 语义 / 递归）走同一条 eligibility 管线：
//        enabled → visibility(fail closed) → 通道门 → timed 门 → delay 前置门
//        → delayUntilRecursion → nonRecursable/recursionLevel/scanDepth → 概率
//        → 分组竞争 → 真正 activated
//   2. 被概率拒绝 / 分组落选的条目【不会】递归，也不写 timed 状态
//   3. 不可见条目不得成为结果、不得参与递归、不得写 timed 状态
//   4. work cutoff 只允许砍掉「最终排序里本来也靠后」的候选——
//      因此 frontier 必须按 entrySortKey 顺序求值
//   5. 只有真正 activated 的条目才写 timed activation state，且写入权
//      保留给 keyword 通道（纯 semantic 命中只参与召回）
//   6. 每次判定都记进 lastDecisions —— trace 的原因必须来自实际判定
//
// ⚠️ 与 DiceFrame 的一处刻意的行为差异：
//    MAX_RECURSIVE_DEPTH 只截断 legacy `triggersRecursive` 显式边。
//    canonical / ST 递归（扫描 activated content 发现）不受它截断——它的边界
//    来自 cycle guard、maxSteps / maxActivated、book recursiveScanning、
//    scanDepth、nonRecursable、preventFurtherRecursion 与 recursionLevel。

import {
  normalizeSelectiveLogic,
  evaluateProbability,
  matchedKeyScore,
  stickyActive,
  timedGateBlocked,
  legacyDelayBlocked,
  delayGateBlocked,
  armTimedActivation,
  primaryHits,
  secondaryHits,
  keywordDecision,
  readKeys,
  parseRegexKey,
  normalizePrimaryMatchMode
} from "./activation.js";
import { entrySortKey } from "./budget.js";

/** 递归展开的确定性上限（与 DiceFrame 对齐）。 */
export const MAX_RECURSIVE_DEPTH = 3;   // 仅 legacy triggersRecursive 边
export const MAX_RECURSION_STEPS = 2000;
export const MAX_ACTIVATED_ENTRIES = 400;
export const MIN_BUDGET_CANDIDATES = 32;
export const BUDGET_CANDIDATE_SLACK = 2;

const GROUP_ALLOW_ALL = new Set(["all", "allow_all"]);
const GROUP_SCORING_ON = new Set(["score", "matched_keys", "matched", "use_group_scoring"]);

export class KeywordMatcher {
  /**
   * @param {{ rng?: () => number }} [opts]
   */
  constructor(opts = {}) {
    this._rng = opts.rng || Math.random;
    this._entries = new Map();     // id → entry
    this._index = new Map();       // keyword(lower) → Set<id>（仅用于判断条目有无关键词）
    this._constantIds = new Set();
    this._fuzzyKeys = [];          // 长度 ≥ 2 的关键词（供 fuzzy 兑底）

    // 最近一次激活的逐条判定（供 ActivationTrace）
    this.lastDecisions = new Map();
    this.lastCutoff = "";
  }

  /** 从条目列表构建索引。 */
  build(entries) {
    this._entries.clear();
    this._index.clear();
    this._constantIds.clear();
    this._fuzzyKeys = [];
    this._alwaysScanIds = new Set();

    for (const e of entries || []) {
      if (!e || !e.id) continue;
      this._entries.set(e.id, e);

      if (e.trigger?.type === "always" || e.isConstant) {
        this._constantIds.add(e.id);
      }

      const allKeys = [...readKeys(e, "keywords"), ...readKeys(e, "secondaryKeys")];
      let hasIndexableKey = false;
      for (const kw of allKeys) {
        const k = String(kw ?? "").trim().toLowerCase();
        if (!k) continue;
        if (!this._index.has(k)) this._index.set(k, new Set());
        this._index.get(k).add(e.id);
        if (k.length >= 2 && !this._fuzzyKeys.includes(k)) this._fuzzyKeys.push(k);
        hasIndexableKey = true;
      }

      // 没有可用索引键的条目必须全量送审：
      //   正则键靠 pattern 匹配而非字面子串，索引发现不了；
      //   负向主键靠"文本不含关键词"成立，同样索引不到。
      // 不放进 alwaysScan，它们就永远不被激活。
      // 注意 parseRegexKey 返回 RegExp 或 null，不是带标记的对象。
      const isRegexKey = allKeys.some(k => parseRegexKey(k) !== null);
      const mode = normalizePrimaryMatchMode(e.primaryMatchMode ?? e.trigger?.mode);
      const negative = mode === "not_any" || mode === "not_all";
      if (!hasIndexableKey || isRegexKey || negative) {
        this._alwaysScanIds.add(e.id);
      }
    }

    // 有任一索引键才走 lexical 快速通道；否则会让整个 match() 短路，
    // 结果永远是空数组（这正是 "scanned: 0" 的根因）。
    this._hasAnyKey = this._index.size > 0;
    this._alwaysScan = this._alwaysScanIds;

    return this;
  }

  get size() {
    return this._entries.size;
  }

  /** 常量条目（trigger.type === "always"）。 */
  #constantIds() {
    return this._constantIds;
  }

  /** 当前处于 sticky 激活中的条目 id。 */
  #stickyActiveIds(timedState) {
    const out = new Set();
    if (!timedState) return out;
    const iter = timedState.forEach
      ? (cb) => timedState.forEach((v, k) => cb(k, v))
      : (cb) => Object.entries(timedState).forEach(([k, v]) => cb(k, v));
    iter((id, state) => {
      if (stickyActive(state) && this._entries.has(id)) out.add(id);
    });
    return out;
  }

  /** 当前被 cooldown / legacy delay 挡住的条目 id。 */
  #timedBlockedIds(timedState) {
    const out = new Set();
    if (!timedState) return out;
    const iter = timedState.forEach
      ? (cb) => timedState.forEach((v, k) => cb(k, v))
      : (cb) => Object.entries(timedState).forEach(([k, v]) => cb(k, v));
    iter((id, state) => {
      if (timedGateBlocked(state)) out.add(id);
    });
    return out;
  }

  /** 读某条目的定时状态（兼容 Map / 普通对象）。 */
  #stateOf(timedState, id) {
    if (!timedState) return null;
    if (timedState.get) return timedState.get(id) ?? null;
    return timedState[id] ?? null;
  }

  /**
   * 主入口：匹配 + 递归展开。
   *
   * @param {string} text - 扫描文本
   * @param {object} [opts]
   * @param {Map|object} [opts.timedState] - 条目 id → 定时状态
   * @param {(entry) => boolean} [opts.isVisible] - 可见性判定（递归之前生效，fail closed）
   * @param {(entry) => boolean} [opts.isCandidate] - 通道门（如 vector_only 不得被关键词发现）
   * @param {Iterable<string>} [opts.extraCandidates] - 其它通道发现的条目 id
   * @param {number|null} [opts.currentTick] - tick 权威；null 表示没有
   * @param {number} [opts.maxActivated]
   * @param {number} [opts.maxSteps]
   * @returns {object[]} 激活的条目（带 _directMatch / _recursive / _depth 标注）
   */
  match(text, opts = {}) {
    const {
      timedState = null,
      isVisible = null,
      isCandidate = null,
      extraCandidates = null,
      currentTick = null,
      maxActivated = MAX_ACTIVATED_ENTRIES,
      maxSteps = MAX_RECURSION_STEPS
    } = opts;

    const stepLimit = Math.max(1, Number(maxSteps) || MAX_RECURSION_STEPS);
    const activatedLimit = Math.max(1, Number(maxActivated) || MAX_ACTIVATED_ENTRIES);

    const scanText = String(text ?? "");
    const visible = isVisible || (() => true);
    const discover = isCandidate || (() => true);

    this.lastDecisions = new Map();
    this.lastCutoff = "";

    const blocked = this.#timedBlockedIds(timedState);
    const sticky = this.#stickyActiveIds(timedState);
    const constants = this.#constantIds();

    const semanticSeeds = new Set(
      [...(extraCandidates || [])].map(String).filter(id => this._entries.has(id))
    );

    // lexical 通道发现的条目（含 sticky / constant），决定 timed state 写入权
    const lexicalSeeds = new Set();
    const lexicalDiscovered = new Set();

    if (scanText && this._hasAnyKey) {
      let exact = new Set();
      for (const id of this.#keywordCandidates(scanText, false)) {
        const e = this._entries.get(id);
        if (e && discover(e)) exact.add(id);
      }
      // 精确匹配“减去被 timed 门挡下的”之后为空才走模糊兜底（与 DiceFrame 对齐）
      const lexicalProbe = new Set([...exact].filter(id => !blocked.has(id)));
      if (lexicalProbe.size === 0) {
        for (const id of this.#keywordCandidates(scanText, true)) {
          const e = this._entries.get(id);
          if (e && discover(e)) exact.add(id);
        }
      }
      for (const id of exact) lexicalDiscovered.add(id);
      for (const id of exact) if (!blocked.has(id)) lexicalSeeds.add(id);
    }

    for (const id of sticky) lexicalSeeds.add(id);
    for (const id of constants) lexicalSeeds.add(id);
    for (const id of sticky) lexicalDiscovered.add(id);
    for (const id of constants) lexicalDiscovered.add(id);

    const seeds = new Set([...semanticSeeds, ...lexicalSeeds]);
    for (const id of blocked) seeds.delete(id);

    // 被 timed 门挡下的候选也要记进 trace（否则无法区分"没发现"与"被挡"）
    for (const id of [...semanticSeeds, ...lexicalDiscovered]) {
      if (!blocked.has(id)) continue;
      const entry = this._entries.get(id);
      if (!entry) continue;
      const state = this.#stateOf(timedState, id);
      this.#record(id, {
        channel: semanticSeeds.has(id) && !lexicalDiscovered.has(id) ? "semantic" : "keyword",
        outcome: "rejected",
        reasonCode: legacyDelayBlocked(state) ? "delay" : "cooldown"
      });
    }

    const activated = new Set();
    const evaluated = new Set();
    const probabilityCache = new Map();
    const groupDecided = new Map();
    const parents = new Map();

    let frontier = new Map([...seeds].sort().map(id => [id, scanText]));
    let scanned = new Set();
    let legacyEdges = new Set();
    let depth = 0;
    let steps = 0;

    // 初始种子一律记为候选（不受 steps 限制）
    for (const id of seeds) {
      const channel = semanticSeeds.has(id) && !lexicalSeeds.has(id) ? "semantic"
        : constants.has(id) ? "constant"
        : sticky.has(id) ? "sticky"
        : "keyword";
      this.#record(id, { channel, depth: 0 });
    }

    while (frontier.size > 0) {
      // legacy 边受深度限制；canonical 递归不受
      if (depth >= MAX_RECURSIVE_DEPTH && legacyEdges.size > 0) {
        for (const id of legacyEdges) frontier.delete(id);
        legacyEdges = new Set();
        if (frontier.size === 0) break;
      }

      const batch = new Map();
      // frontier 一律按最终 inclusion 顺序求值，保证 cutoff 只砍尾部
      const ordered = [...frontier.keys()].sort((a, b) =>
        compareSortKeys(
          this.#frontierSortKey(a, lexicalSeeds.has(a), depth > 0),
          this.#frontierSortKey(b, lexicalSeeds.has(b), depth > 0)
        )
      );

      for (const id of ordered) {
        const entry = this._entries.get(id);
        if (!entry || evaluated.has(id)) continue;

        if (depth > 0) {
          // work cutoff 只限制递归展开；初始种子不受限
          if (steps >= stepLimit) { this.lastCutoff = "max_steps"; break; }
          steps++;
        }
        evaluated.add(id);

        const reason = this.#eligibilityReason(entry, {
          depth,
          visible,
          discover: scanned.has(id) ? discover : null,
          timedState,
          currentTick
        });

        this.#record(id, {
          depth,
          parent: parents.get(id) || "",
          timed: this.#timedSnapshot(id, entry, timedState, currentTick)
        });

        if (reason !== null) {
          this.#record(id, { outcome: "rejected", reasonCode: reason });
          continue;
        }

        if (!this.#probabilityOk(id, entry, probabilityCache)) {
          this.#record(id, { outcome: "rejected", reasonCode: "probability_rejected" });
          continue;
        }

        batch.set(id, frontier.get(id));
      }

      // 分组竞争：每个 pass 内即时竞争，落选者不进 recursion
      const winners = this.#groupWinners(batch, groupDecided);
      for (const id of batch.keys()) {
        if (!winners.has(id)) {
          this.#record(id, { outcome: "rejected", reasonCode: "group_lost" });
        }
      }
      for (const id of winners) {
        activated.add(id);
        const d = this.#decisionDepth(id);
        this.#record(id, {
          outcome: "activated",
          reasonCode: d > 0 ? "recursive"
            : this.#decisionChannel(id) === "semantic" ? "semantic" : "keyword"
        });
      }

      if (depth > 0 && activated.size >= activatedLimit) {
        this.lastCutoff = this.lastCutoff || "max_activated";
        break;
      }
      if (this.lastCutoff === "max_steps") break;

      // 展开下一层
      frontier = new Map();
      scanned = new Set();
      const allChildren = new Set();
      const allScanned = new Set();

      for (const id of [...winners].sort()) {
        const { children, childScanned } = this.#childrenOf(
          id, new Set([...evaluated, ...activated])
        );
        for (const cid of children.keys()) {
          if (!parents.has(cid)) parents.set(cid, id);
        }
        for (const [cid, txt] of children) frontier.set(cid, txt);
        for (const cid of children.keys()) allChildren.add(cid);
        for (const cid of childScanned) allScanned.add(cid);
        for (const cid of childScanned) scanned.add(cid);
      }

      // 没有任何 parent 通过 content 扫描到达的子条目 = legacy 显式边
      legacyEdges = new Set([...allChildren].filter(id => !allScanned.has(id)));
      depth++;
    }

    // 只有真正 activated 的条目才写 timed state，且写入权保留给 keyword 通道
    if (timedState) {
      const writable = [...activated].filter(id => lexicalSeeds.has(id));
      this.#applyTimeEffects(writable, timedState, currentTick);
    }

    const result = this.#sortByTier(activated);
    for (const row of result) {
      const eid = String(row.id ?? "");
      row._directMatch = lexicalSeeds.has(eid);
      row._recursive = this.#decisionDepth(eid) > 0;
      row._semanticOnly = semanticSeeds.has(eid) && !lexicalSeeds.has(eid);
      row._isConstant = constants.has(eid);
    }
    return result;
  }

  /**
   * 完整 eligibility 判定。返回 null 表示通过，否则返回拒绝原因码。
   *
   * fail closed：任何一道门不通过都返回原因，绝不放行。
   */
  #eligibilityReason(entry, { depth, visible, discover, timedState, currentTick }) {
    if (entry.enabled === false) return "disabled";
    if (!visible(entry)) return "hidden";
    if (discover !== null && discover !== undefined && !discover(entry)) return "vector_channel";

    const state = this.#stateOf(timedState, entry.id);
    if (timedGateBlocked(state)) {
      return legacyDelayBlocked(state) ? "delay" : "cooldown";
    }
    // sticky 生效中的条目豁免 delay 门（它的 cooldown 还没开始）
    if (delayGateBlocked(entry, currentTick) && !stickyActive(state)) {
      return "delay";
    }

    const recursivePass = depth > 0;
    if (entry.delayUntilRecursion && !recursivePass) return "delay_until_recursion";

    if (recursivePass) {
      // nonRecursable 只限制"通过递归被到达"；直接命中仍可传播
      if (entry.nonRecursable) return "non_recursable";
      const level = Number(entry.recursionLevel ?? 0) || 0;
      if (level > 0 && depth < level) return "recursion_level";
      const configured = Number(entry.scanDepth ?? 0) || 0;
      if (configured > 0 && depth > configured) return "scan_depth";
    }

    return null;
  }

  /** 概率判定：每轮每条目只 roll 一次（否则递归中结果不确定）。 */
  #probabilityOk(id, entry, cache) {
    if (!cache.has(id)) {
      const r = evaluateProbability(entry, this._rng);
      cache.set(id, r.accepted);
      this.#record(id, { probability: r });
    }
    return cache.get(id);
  }

  /**
   * 关键词通道的候选：**全量遍历所有条目**做完整判定。
   *
   * ⚠️ 为什么不用关键词索引加速：
   *    索引的前提是「命中 ⇒ 文本含该字面量」，但以下语义不满足这个前提——
   *      · 负向主键（not_any / not_all）：靠「文本**不**含关键词」成立
   *      · 正则键（/pattern/ 或 useRegex）：靠 pattern 匹配，不是字面子串
   *      · 整词 / 大小写敏感：边界判定与子串包含不同
   *    这类「非字面量」语义无法枚举穷尽，索引会把它们**静默漏掉**。
   *    DiceFrame 的 `_candidate_ids` 就是全量遍历，这里跟随规格。
   *    世界书通常几十到几百条，全量遍历是微秒级——不值得用正确性换性能。
   *
   * @param {string} text
   * @param {boolean} fuzzy - 是否启用模糊兜底
   */
  #keywordCandidates(text, fuzzy) {
    const out = new Set();
    for (const [id, entry] of this._entries) {
      if (keywordDecision(entry, text, { fuzzy }).matched) out.add(id);
    }
    return out;
  }

  /**
   * 已激活条目的内容 → 子候选。
   * 返回 { children: Map<id, text>, childScanned: Set<id> }。
   *
   * ⚠️ 内容传播只被 preventRecursion 阻断——与 DiceFrame matcher._children_of
   *    一致（activation.py 里那个同时检查 non_recursable 的 next_recursion_buffer
   *    在 DiceFrame 里从未被调用，是死代码；这里跟随可执行的那份）。
   */
  #childrenOf(id, excluded) {
    const entry = this._entries.get(id);
    if (!entry || entry.preventRecursion) return { children: new Map(), childScanned: new Set() };

    const children = new Map();
    const childScanned = new Set();
    const childText = String(entry.content ?? "");

    // book 级开关（默认开）
    if (childText && entry.recursiveScanning !== false) {
      for (const cid of [...this.#keywordCandidates(childText, false)].sort()) {
        if (!excluded.has(cid)) {
          children.set(cid, childText);
          childScanned.add(cid);
        }
      }
    }

    // legacy 显式边：triggersRecursive
    let triggers = entry.triggersRecursive ?? [];
    if (typeof triggers === "string") {
      try { triggers = JSON.parse(triggers); } catch { triggers = []; }
    }
    for (const raw of Array.isArray(triggers) ? triggers : []) {
      const tid = String(raw);
      if (!excluded.has(tid) && this._entries.has(tid)) {
        children.set(tid, childText);
        childScanned.delete(tid);   // 显式边不算关键词发现
      }
    }

    return { children, childScanned };
  }

  /** 分组名（兼容 groups[] 与 group 单值）。 */
  #groupNames(entry) {
    const names = readKeys(entry, "groups");
    const single = String(entry?.group ?? "").trim();
    if (single) names.push(single);
    return [...new Set(names)];
  }

  /** 组内打分。 */
  #scoreOf(id, text) {
    const entry = this._entries.get(id) || {};
    return matchedKeyScore(
      entry,
      primaryHits(entry, text),
      secondaryHits(entry, text)
    );
  }

  /**
   * 分组竞争。
   *
   * 规则：
   *   - 组内任一成员 groupScoring=all/allow_all → 全组放行
   *   - 组内任一成员 groupScoring=score 系列 → 按 matchedKeyScore 取最高
   *   - prioritizeInclusion → priority 降序、order 降序（ST 语义）
   *   - 否则按 groupWeight 加权随机
   *   - 已决出的组：后到成员一律落选
   */
  #groupWinners(batch, decided) {
    const groups = new Map();
    for (const id of batch.keys()) {
      for (const name of this.#groupNames(this._entries.get(id) || {})) {
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(id);
      }
    }

    const winners = new Set(batch.keys());

    for (const [name, members] of groups) {
      if (members.length <= 1) continue;
      const anyAllowAll = members.some(m => GROUP_ALLOW_ALL.has(
        String(this._entries.get(m)?.groupScoring ?? "").trim().toLowerCase()
      ));
      if (anyAllowAll) continue;

      if (decided.has(name)) {
        const w = decided.get(name);
        for (const m of members) if (m !== w) winners.delete(m);
        this.#recordGroupOutcome(name, members, w);
        continue;
      }

      let pool = [...members];
      const anyScoring = members.some(m => GROUP_SCORING_ON.has(
        String(this._entries.get(m)?.groupScoring ?? "").trim().toLowerCase()
      ));
      if (anyScoring) {
        const best = Math.max(...members.map(m => this.#scoreOf(m, batch.get(m))));
        pool = members.filter(m => this.#scoreOf(m, batch.get(m)) === best);
      }

      const prioritized = pool.filter(m => this._entries.get(m)?.prioritizeInclusion);
      let winner;
      if (prioritized.length > 0) {
        // ST Prioritize Inclusion 依赖较高的 insertion order → order 降序
        prioritized.sort((a, b) => {
          const ea = this._entries.get(a) || {}, eb = this._entries.get(b) || {};
          const pa = -Number(ea.priority ?? 0), pb = -Number(eb.priority ?? 0);
          if (pa !== pb) return pa - pb;
          const oa = -Number(ea.order ?? 100), ob = -Number(eb.order ?? 100);
          if (oa !== ob) return oa - ob;
          return String(a) < String(b) ? -1 : 1;
        });
        winner = prioritized[0];
      } else {
        winner = this.#weightedPick([...pool].sort());
      }

      decided.set(name, winner);
      for (const m of members) if (m !== winner) winners.delete(m);
      this.#recordGroupOutcome(name, members, winner);
    }

    return winners;
  }

  #recordGroupOutcome(name, members, winner) {
    for (const m of members) {
      const row = this.lastDecisions.get(m) || {};
      const group = { ...(row.group || {}) };
      group.contestedGroup = name;
      group.outcome = m === winner ? "winner" : "lost";
      group.winner = winner;
      this.#record(m, { group });
    }
  }

  /** groupWeight 加权随机（RNG 可注入以保证确定性）。 */
  #weightedPick(pool) {
    if (pool.length === 0) return "";
    if (pool.length === 1) return pool[0];
    const weights = pool.map(m => Math.max(1, Number(this._entries.get(m)?.groupWeight ?? 1) || 1));
    let roll = this._rng() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < pool.length; i++) {
      roll -= weights[i];
      if (roll < 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  /**
   * 写 timed activation state。
   * delay 不在这里落计数器——它是前置门，不是倒计时。
   */
  #applyTimeEffects(ids, timedState, currentTick) {
    for (const id of ids) {
      const entry = this._entries.get(id);
      if (!entry) continue;
      const sticky = Math.max(0, Number(entry.sticky ?? 0) || 0);
      const cooldown = Math.max(0, Number(entry.cooldown ?? 0) || 0);
      if (sticky <= 0 && cooldown <= 0) continue;

      if (timedState.get) {
        if (!timedState.has(id)) timedState.set(id, {});
        armTimedActivation(timedState.get(id), {
          sticky, cooldown, activatedTick: Number(currentTick ?? 0) || 0
        });
      } else {
        if (!timedState[id]) timedState[id] = {};
        armTimedActivation(timedState[id], {
          sticky, cooldown, activatedTick: Number(currentTick ?? 0) || 0
        });
      }
    }
  }

  /** tier 排序：core < background < archived，再按 order，最后 id 兜底。 */
  #sortByTier(ids) {
    const tierOrder = { core: 0, background: 1, archived: 2 };
    const out = [];
    for (const id of ids) {
      const e = this._entries.get(id);
      if (e) out.push({ ...e });
    }
    out.sort((a, b) => {
      const ta = tierOrder[a.tier ?? "background"] ?? 1;
      const tb = tierOrder[b.tier ?? "background"] ?? 1;
      if (ta !== tb) return ta - tb;
      const oa = Number(a.order ?? 100), ob = Number(b.order ?? 100);
      if (oa !== ob) return oa - ob;
      return String(a.id ?? "") < String(b.id ?? "") ? -1 : 1;
    });
    return out;
  }

  /** frontier 求值顺序 = 最终 inclusion 顺序。 */
  #frontierSortKey(id, direct, recursive) {
    const entry = this._entries.get(id);
    if (!entry) return [1, 1, 0, 100, recursive ? 1 : 0, 1, String(id)];
    return entrySortKey({ ...entry, _directMatch: direct }, { recursive, semanticOnly: false });
  }

  /** 定时状态快照（供 trace）。 */
  #timedSnapshot(id, entry, timedState, currentTick) {
    const state = this.#stateOf(timedState, id);
    return {
      stickyActive: stickyActive(state),
      cooldownBlocked: timedGateBlocked(state) && !legacyDelayBlocked(state),
      delayBlocked: delayGateBlocked(entry, currentTick) || legacyDelayBlocked(state),
      delay: Math.max(0, Number(entry.delay ?? 0) || 0),
      currentTick: currentTick ?? null
    };
  }

  /** 写一条判定记录（trace 的唯一事实来源）。 */
  #record(id, fields = {}) {
    const row = this.lastDecisions.get(id) || {
      entryId: id, channel: "", depth: 0, parent: "",
      probability: null, group: null, timed: null,
      outcome: "candidate", reasonCode: ""
    };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) row[k] = v;
      else if (k === "probability" || k === "group" || k === "timed") row[k] = v;
    }
    this.lastDecisions.set(id, row);
  }

  #decisionDepth(id) {
    return Number(this.lastDecisions.get(id)?.depth ?? 0) || 0;
  }

  #decisionChannel(id) {
    return String(this.lastDecisions.get(id)?.channel ?? "");
  }

  /** 诊断：最近一次激活的判定明细。 */
  decisionsSnapshot() {
    return {
      cutoff: this.lastCutoff,
      decisions: Object.fromEntries(this.lastDecisions)
    };
  }

  /** 关键词通道的公开判定（供 trace 复用，避免重算）。 */
  keywordDecision(entry, text) {
    return keywordDecision(entry, text);
  }
}

/** 比较两个排序键数组。 */
export function compareSortKeys(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (typeof x === "string" || typeof y === "string") {
      return String(x) < String(y) ? -1 : 1;
    }
    return x < y ? -1 : 1;
  }
  return 0;
}
