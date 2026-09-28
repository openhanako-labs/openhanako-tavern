// lib/director/engine.js — 规则引擎：条件求值、效果应用、每轮结算
//
// 为什么自己写一小套语言，而不是 eval / new Function：
// 规则来自**用户手编的 JSON**。eval 等于把这个 App 的执行权交出去，
// 而这里要表达的东西只有「比较」和「加减赋值」两种——
// 一张穷举得完的语法表，比一个能跑任意代码的解释器既安全得多，也好测得多
// （每条分支都能钉一个用例，遇到不认识的就报错，不猜）。
//
// 语言一共两句话：
//   条件 when   ：`always` / `never` / `名字 >= 数字`，可用 && 和 || 串
//   效果 effect ：`名字 += 数字` / `-=` / `=`
// 没有括号、没有函数调用、没有变量间运算。需要更多时**加语法**，不要加自由度。

import { varKindOf, VarKind, VAR_NAME_PATTERN } from "./model.js";

const CMP_RE = new RegExp("^(" + VAR_NAME_PATTERN + ")\\s*(>=|<=|==|!=|>|<)\\s*(-?\\d+(?:\\.\\d+)?)$");
const ASSIGN_RE = new RegExp("^(" + VAR_NAME_PATTERN + ")\\s*(\\+=|-=|=)\\s*(-?\\d+(?:\\.\\d+)?)$");
const BARE_NAME_RE = new RegExp("^" + VAR_NAME_PATTERN + "$");

/** 状态量取数：开关当 0/1 用，这样 `confessed >= 1` 也能写。 */
export function numberOf(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === true) return 1;
  if (value === false) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 求值一个条件。
 *
 * @param {string} expr
 * @param {object} state
 * @returns {boolean}
 * @throws 语法不认识时抛错（静默返回 false 会让规则悄悄失效）
 */
export function evalWhen(expr, state) {
  const s = String(expr ?? "").trim();
  if (!s || s === "always") return true;
  if (s === "never") return false;

  // && 先切、|| 后切：与 / 或的优先级靠顺序体现。没有括号——
  // 规则是给人读的，读的人不该需要记优先级表。
  if (s.includes("&&")) return s.split("&&").every(part => evalWhen(part, state));
  if (s.includes("||")) return s.split("||").some(part => evalWhen(part, state));

  // 光写一个名字 = 「这个开关开着」/「这个量不是零」。
  // 用户会自然地写 `when: "confessed"`，而不是 `confessed >= 1`——
  // 这两种写法都收，但语义要说清：开关按真假，数值按非零。
  if (BARE_NAME_RE.test(s)) return numberOf(state?.[s]) !== 0;

  const m = CMP_RE.exec(s);
  if (!m) throw new Error(`看不懂的条件："${s}"（只支持 名字 >= 数字，可用 && / || 串）`);

  const left = numberOf(state?.[m[1]]);
  const right = Number(m[3]);
  switch (m[2]) {
    case ">=": return left >= right;
    case "<=": return left <= right;
    case ">": return left > right;
    case "<": return left < right;
    case "==": return left === right;
    case "!=": return left !== right;
    default: return false;
  }
}

/** 按声明把数值夹进 [min, max]。规则是可信的，越界就地夹住而不是丢弃。 */
export function clampToSchema(entity, name, value) {
  const spec = entity?.state?.[name];
  if (!spec || varKindOf(spec) === VarKind.FLAG) return value;
  let v = value;
  if (Number.isFinite(Number(spec.min))) v = Math.max(Number(spec.min), v);
  if (Number.isFinite(Number(spec.max))) v = Math.min(Number(spec.max), v);
  return v;
}

/**
 * 应用一条效果，返回**新** state（不改原对象）。
 *
 * @returns {{state: object, change: {name, from, to}|null}}
 */
export function applyEffect(effect, state, entity) {
  const s = String(effect ?? "").trim();
  if (!s) return { state, change: null };

  const m = ASSIGN_RE.exec(s);
  if (!m) throw new Error(`看不懂的效果："${s}"（只支持 名字 += 数字 / -= / =）`);

  const [, name, op, numStr] = m;
  const n = Number(numStr);
  const from = numberOf(state?.[name]);
  const raw = op === "+=" ? from + n : op === "-=" ? from - n : n;
  const to = clampToSchema(entity, name, raw);

  return { state: { ...state, [name]: to }, change: { name, from, to } };
}

/**
 * 这一轮**摆在模型面前**的约束。
 *
 * 只取带 brief 的规则——effect 是结算时的事，不是给模型看的。
 * brief 是「必须出现什么性质的事」，不是「本轮做第几件事」。
 *
 * @returns {Array<{when: string, brief: string}>}
 */
export function activeBriefs(entity, state) {
  const out = [];
  for (const rule of entity?.rules || []) {
    const brief = String(rule?.brief ?? "").trim();
    if (!brief) continue;
    let hit = false;
    try { hit = evalWhen(rule.when, state); } catch { hit = false; }
    if (hit) out.push({ when: String(rule.when || "").trim(), brief });
  }
  return out;
}

/**
 * 结算一轮：基线规则 + 命中的条件规则 + 模型的上报。
 *
 * 顺序是有理由的：
 *   1. 规则的 effect 先跑（这一场的骨架，每次都在推）
 *   2. 上报的增量后跑（模型这一轮自己加的东西，压在骨架上）
 * 反过来的话，规则里的 `= 2` 会把模型刚上报的结果抹掉。
 *
 * @param {object} entity
 * @param {object} state   这一轮开始时的状态
 * @param {Array}  reports 已解析并校验过的上报（见 report.js）
 * @returns {{state: object, changes: Array, rejected: Array}}
 */
export function settle(entity, state, reports = []) {
  let cur = { ...state };
  const changes = [];
  const rules = entity?.rules || [];

  const usable = (rule) => rule && typeof rule.effect === "string" && rule.effect.trim();
  const isBaseline = (rule) => String(rule?.when || "").trim() === "always";

  /*
   * 两阶段，**不看数组顺序**：
   *   一、先跑完所有基线（always）——这一场自己的推进，每次都在走。
   *   二、再用推完之后的值判条件规则。
   *
   * 为什么必须分阶段，而不是“顺着数组跑”：
   * 那样的话 `张力 += 3` 写在条件规则前面还是后面，结果完全不同。
   * 而注入给模型的预览（previewState）**只跑基线**——
   * 于是会出现“预览说这一轮到 7 了、结算却没触发 7 的规则”这种错，
   * 而且两句都不报错，只是剧情慢慢走歪。
   *
   * 规则是给人写的。读的人不该先学会一条“先写基线再写条件”的潜规则
   * 才能预判自己的配方怎么跑。
   */
  for (const rule of rules) {
    if (!usable(rule) || !isBaseline(rule)) continue;
    const { state: next, change } = applyEffect(rule.effect, cur, entity);
    cur = next;
    if (change && change.from !== change.to) changes.push({ ...change, by: "rule" });
  }

  for (const rule of rules) {
    if (!usable(rule) || isBaseline(rule)) continue;
    let hit = false;
    try { hit = evalWhen(rule.when, cur); } catch { hit = false; }
    if (!hit) continue;
    const { state: next, change } = applyEffect(rule.effect, cur, entity);
    cur = next;
    if (change && change.from !== change.to) changes.push({ ...change, by: "rule" });
  }

  const rejected = [];
  for (const rep of Array.isArray(reports) ? reports : []) {
    if (!rep || rep.rejected) { if (rep?.rejected) rejected.push(rep); continue; }

    if (rep.kind === "flag") {
      const spec = entity?.state?.[rep.name];
      if (!spec || varKindOf(spec) !== VarKind.FLAG) {
        // flag 必须先在配方里声明。允许凭空造 flag 等于让模型改配置。
        rejected.push({ ...rep, rejected: `"${rep.name}" 不是这个配方声明的开关` });
        continue;
      }
      const from = !!cur[rep.name];
      if (from !== rep.value) { cur = { ...cur, [rep.name]: rep.value }; changes.push({ name: rep.name, from, to: rep.value, by: "report" }); }
      continue;
    }

    const spec = entity?.state?.[rep.name];
    if (!spec || varKindOf(spec) === VarKind.FLAG) {
      rejected.push({ ...rep, rejected: `"${rep.name}" 不是这个配方的数值量` });
      continue;
    }
    const from = numberOf(cur[rep.name]);
    const raw = rep.op === "-" ? from - rep.value : rep.op === "=" ? rep.value : from + rep.value;
    // 上报越界**丢弃**，不像规则那样夹住：规则是作者写的，上报是模型报的。
    // 模型报了一个越界值，说明它对自己在推什么没有把握——这时候猜不如不采。
    if (raw < Number(spec.min ?? -Infinity) || raw > Number(spec.max ?? Infinity)) {
      rejected.push({ ...rep, rejected: `越界：${raw} 不在 [${spec.min ?? "-∞"}, ${spec.max ?? "∞"}]` });
      continue;
    }
    cur = { ...cur, [rep.name]: raw };
    if (from !== raw) changes.push({ name: rep.name, from, to: raw, by: "report" });
  }

  return { state: cur, changes, rejected };
}

/**
 * 只跑基线（always）那一部分，得到「这一轮结束时大概会在哪」。
 *
 * 为什么预先看这一步：约束说的是「张力到 7 时必须出现一次冲突」，
 * 而 7 是 baseline 推上去的。若拿**进入**这一轮的状态去比，
 * 那句话永远晚一轮才提示——提示到达时，该发生冲突的那一轮已经过去了。
 */
export function previewState(entity, state) {
  let cur = { ...state };
  for (const rule of entity?.rules || []) {
    if (String(rule?.when || "").trim() !== "always") continue;
    if (!rule.effect?.trim()) continue;
    try { cur = applyEffect(rule.effect, cur, entity).state; } catch { /* 坏规则不参与预演 */ }
  }
  return cur;
}

/** 状态 → 一行给人看的摘要（界面与 trace 共用）。 */
export function describeState(entity, state) {
  const parts = [];
  for (const [name, spec] of Object.entries(entity?.state || {})) {
    const v = state?.[name];
    if (varKindOf(spec) === VarKind.FLAG) {
      if (v) parts.push(name);
    } else {
      const max = Number.isFinite(Number(spec.max)) ? `/${Number(spec.max)}` : "";
      parts.push(`${name} ${Number(v) || 0}${max}`);
    }
  }
  return parts.join(" · ");
}

/**
 * 多条公式的注入顺序。
 *
 * `order` 小的先注入。同值时保持原数组顺序（稳定排序）——
 * 那是创建顺序，比随机强。
 *
 * 为什么顺序不是 priority：两者回答不同的问题。
 *   order    —— 「谁先写」：影响块在 prompt 里的先后
 *   priority —— 「谁算数」：两条都声明同名量时，谁的值留下
 * 只有 order 时，后写的会盖掉先写的，而「后」由数组顺序决定——
 * 用户看不见也控制不了。所以两个都要。
 */
export function sortByOrder(entities) {
  return (Array.isArray(entities) ? entities : [])
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const ao = Number(a.e?.order); const bo = Number(b.e?.order);
      const av = Number.isFinite(ao) ? ao : 1;
      const bv = Number.isFinite(bo) ? bo : 1;
      if (av !== bv) return av - bv;
      return a.i - b.i;   // 同 order → 保持原顺序
    })
    .map(x => x.e);
}

/**
 * 一条上报该归谁。
 *
 * 上报语法（`[状态 张力+2]`）不带公式标识，所以得按**状态名**路由：
 * 一个上报只被「声明了这个名字」的公式消费。
 *
 * 若同名量被多条声明 —— 按 priority 高的那条收（数字大的赢），
 * 其余记进 rejected（带原因）。这就是 priority 在结算侧的用处。
 *
 * @param {Array} entities 已按 order 排好
 * @param {string} name    上报里的状态名
 * @returns {{ owner: object|null, losers: object[] }}
 */
export function ownerOfVar(entities, name) {
  const claimers = (Array.isArray(entities) ? entities : [])
    .filter(e => e && e.enabled !== false && e.state && Object.prototype.hasOwnProperty.call(e.state, name));
  if (claimers.length === 0) return { owner: null, losers: [] };
  if (claimers.length === 1) return { owner: claimers[0], losers: [] };

  // 多条声明：priority 大的赢；同 priority 时 order 小的赢（先写的占位）
  const sorted = claimers.slice().sort((a, b) => {
    const ap = Number.isFinite(Number(a.priority)) ? Number(a.priority) : 100;
    const bp = Number.isFinite(Number(b.priority)) ? Number(b.priority) : 100;
    if (ap !== bp) return bp - ap;
    const ao = Number.isFinite(Number(a.order)) ? Number(a.order) : 1;
    const bo = Number.isFinite(Number(b.order)) ? Number(b.order) : 1;
    return ao - bo;
  });
  return { owner: sorted[0], losers: sorted.slice(1) };
}

/**
 * 结算一批公式。
 *
 * 每一条各自跑自己的 settle（状态各归各家，互不干扰），
 * 而上报按名字路由到唯一的主人。
 *
 * 返回的 `states` 是「id → 新进度」的映射，调用方拿它写回
 * `__dir` 的各自命名空间。
 *
 * @param {Array} entities 已按 order 排好的一批
 * @param {object} states  id → 这一轮开始时的进度
 * @param {Array} reports  已解析的上报
 * @returns {{ states: object, changes: Array, rejected: Array }}
 */
export function settleMany(entities, states, reports = []) {
  const list = (Array.isArray(entities) ? entities : []).filter(e => e && e.id);
  const next = {};
  for (const e of list) next[e.id] = { ...(states?.[e.id] || {}) };

  const changes = [];
  const rejected = [];

  // 一、各自的规则先跑（基线 + 条件），状态各归各家
  for (const e of list) {
    if (e.enabled === false) continue;
    const r = settle(e, next[e.id], []);
    next[e.id] = r.state;
    for (const c of r.changes) changes.push({ ...c, directorId: e.id, directorName: e.name });
  }

  // 二、上报按名字路由到唯一的主人
  const byOwner = new Map();
  for (const rep of Array.isArray(reports) ? reports : []) {
    if (!rep || rep.rejected) { if (rep?.rejected) rejected.push(rep); continue; }
    const { owner, losers } = ownerOfVar(list, rep.name);
    if (!owner) {
      rejected.push({ ...rep, rejected: `"${rep.name}" 没有任何公式声明过` });
      continue;
    }
    if (losers.length) {
      rejected.push({
        ...rep,
        rejected: `被「${owner.name || owner.id}」优先接管（同名量，优先级更高）`
      });
    }
    if (!byOwner.has(owner.id)) byOwner.set(owner.id, []);
    byOwner.get(owner.id).push(rep);
  }

  for (const [id, reps] of byOwner) {
    const e = list.find(x => x.id === id);
    if (!e) continue;
    const r = settle(e, next[id], reps);
    next[id] = r.state;
    for (const c of r.changes) changes.push({ ...c, directorId: e.id, directorName: e.name });
    for (const x of r.rejected) rejected.push({ ...x, directorId: e.id });
  }

  return { states: next, changes, rejected };
}
