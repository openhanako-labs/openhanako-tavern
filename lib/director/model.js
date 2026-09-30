// lib/director/model.js — 导演实体：状态定义 + 校验
//
// 「导演」是配方式文游里的**剧情公式**。它不是一个剧本，也不是节拍清单，
// 而是一组**状态约束**：
//
//   规定「在什么条件下必须发生什么性质的事」，不规定「具体发生什么」。
//
// （v1 曾把它写成 `beats: ["介绍场景", "抛出一个反常细节"]` —— 那是预设节拍，
//   只是把「预设台词」换了个壳：无限的是表面文字，骨架仍被写死。
//   v2 换成元规则，见 docs/plans/2026-09-27-recipe-integration.md §3.2。）
//
// 实体是**纯配置**：它不含进度。进度存在某场对话自己的 variables 里，
// 所以同一张卡开两场对话 = 同一个剧本、两次不同的演出，互不覆盖。

/*
 * 进度存在哪：该场对话的 variables 里，一个双下划线前缀的键。
 *
 * 前缀选 `__` 是因为用户自定义变量几乎不可能撞上它——
 * 而撞上就意味着「用户的变量被配方悄悄改了」，那是查都查不出来的一类错。
 */
export const DIRECTOR_VAR_KEY = "__dir";

/** 状态变量的两种形态：数值量、开关量。 */
export const VarKind = {
  NUMBER: "number",
  FLAG: "flag"
};

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** 一个状态声明是开关还是数值：只看 init 的类型，不另加字段。 */
export function varKindOf(spec) {
  if (!isPlainObject(spec)) return VarKind.NUMBER;
  return typeof spec.init === "boolean" ? VarKind.FLAG : VarKind.NUMBER;
}

/**
 * 变量名的字符类。
 *
 * 允许中文：配方是**中文用户手编的 JSON**，`张力` 比 `tension` 更像他会写的东西。
 * 首字符不能是数字（不然 `2x` 会和数值常量撞上）。
 *
 * engine.js 与 report.js 拿这个模式拼自己的正则——三处的名字规则必须同一份，
 * 否则会出现「能声明、不能写条件」这种半通不通的状态。
 */
export const VAR_NAME_PATTERN = "[A-Za-z_\\u4e00-\\u9fa5][\\w.\\u4e00-\\u9fa5]*";
export const VAR_NAME_RE = new RegExp("^" + VAR_NAME_PATTERN + "$");

/**
 * 造一个导演实体。
 *
 * @param {{ id?: string, name?: string, characterId?: string, state?: object,
 *           rules?: Array, freeform?: string }} [overrides]
 */
export function createDirectorEntity(overrides = {}) {
  const state = isPlainObject(overrides.state) ? overrides.state : {};
  return {
    id: overrides.id || "",
    name: overrides.name || "未命名配方",
    characterId: overrides.characterId || "",
    state,
    rules: Array.isArray(overrides.rules) ? overrides.rules : [],
    /*
     * 最后一句交给模型的话。
     * 默认值不是客套——它承担一件事：**明说骨架在规则里，不在清单里**。
     * 少了这句，模型会把 brief 读成「本轮要做的第 N 件事」，
     * 而那是 v1 的错法。
     */
    freeform: overrides.freeform
      || "本轮发生什么由你决定——不要按清单走，只遵守上面的约束。",

    /*
     * ── 「四件」里的后三件（2026-09-28）──
     *
     * 为什么现在才加：它们要**一场能绑多条公式**才有语义。
     * 原先 conv.directorId 是单值，引擎里根本没有「两条同时生效」的场合——
     * 顺序排给谁看、冲突时谁赢都不成立。
     *
     * order    注入先后。数字小的先注入。同值时按创建顺序（数组下标）稳。
     * priority **状态同名时谁说了算**。数字大的赢。
     *          与 order 是两个不同的问题：order 管「谁先写」，
     *          priority 管「谁算数」。只有 order 没有 priority 时，
     *          后写的会盖掉先写的，而「后」由数组顺序决定——用户看不见。
     * tags     本地分类标签，**不进引擎**。定位同设定库的 category：
     *          「不参与 ST 导出，也不进世界书语义」。
     */
    order: Number.isFinite(Number(overrides.order)) ? Number(overrides.order) : 1,
    priority: Number.isFinite(Number(overrides.priority)) ? Number(overrides.priority) : 100,
    tags: Array.isArray(overrides.tags)
      ? overrides.tags.map(t => String(t ?? "").trim()).filter(Boolean)
      : [],

    /*
     * ── 节奏（S3 / 2026-09-29）──
     *
     * AIRP 图 07「剧情规划」里的节奏四选项：更日常 / 更戏剧 / 更多人物 /
     * 更多感情线。多选叠加，空数组 = 没有这行注入。
     *
     * 存储用英文 key（daily / drama / cast / bond），显示与注入在 prompt.js
     * 里走映射表——不让模型自己解释词义，写死的中文指令直接注入。
     */
    pacing: Array.isArray(overrides.pacing)
      ? overrides.pacing.map(p => String(p ?? "").trim()).filter(Boolean)
      : [],

    enabled: overrides.enabled !== false
  };
}

/** 这一条规则会不会改状态（effects 全是 no-op 的规则不算推进器）。 */
export function ruleHasEffect(rule) {
  return typeof rule?.effect === "string" && rule.effect.trim() !== "";
}

/**
 * 条件里引用了哪些变量。
 *
 * 为什么非要有这个：`when: "tensin >= 7"`（拼错一个字母）在运行时走成
 * `numberOf(undefined) >= 7` → false，于是那条规则**永远不命中**，
 * 而运行期一个字都不报。这是最坏的一类错：剧情照走，只是不按你写的走。
 *
 * 所以拼写错必须在**校验期**就抓出来。只查 effect 是不够的——
 * 引用错一个名字同样会让一条规则变哑巴。
 *
 * @returns {{names: string[], bad: string[]}} bad 是认不出来的段
 */
export function namesInWhen(expr) {
  const names = [];
  const bad = [];
  for (const part of String(expr ?? "").split(/&&|\|\|/)) {
    const s = part.trim();
    if (!s) continue;
    if (s === "always" || s === "never") continue;
    const cmp = new RegExp("^(" + VAR_NAME_PATTERN + ")\\s*(?:>=|<=|==|!=|>|<)\\s*-?\\d+(?:\\.\\d+)?$").exec(s);
    if (cmp) { names.push(cmp[1]); continue; }
    if (VAR_NAME_RE.test(s)) { names.push(s); continue; }
    bad.push(s);
  }
  return { names, bad };
}

/**
 * 实体自检：把「写错了但不会报错」的东西挑出来。
 *
 * 为什么要有它：规则是用户手编的 JSON。写错的后果不是崩，而是
 * **那条规则从此静默失效**——剧情照样走，只是永远不按你想的走。
 * 这类错必须在保存时就顶回去，不能等到读者看不见的地方。
 *
 * @returns {string[]} 问题清单（空数组 = 通过）
 */
export function validateDirectorEntity(entity) {
  const problems = [];
  if (!isPlainObject(entity)) return ["不是一份有效的配方"];

  const state = isPlainObject(entity.state) ? entity.state : {};
  const names = Object.keys(state);

  for (const [name, spec] of Object.entries(state)) {
    if (!VAR_NAME_RE.test(name)) problems.push(`状态名不合法："${name}"`);
    if (!isPlainObject(spec)) { problems.push(`状态 "${name}" 的声明不是一个对象`); continue; }
    if (varKindOf(spec) === VarKind.NUMBER) {
      if (!Number.isFinite(Number(spec.init))) problems.push(`状态 "${name}" 缺一个数值 init`);
      const hasMin = spec.min !== undefined, hasMax = spec.max !== undefined;
      if (hasMin && !Number.isFinite(Number(spec.min))) problems.push(`状态 "${name}" 的 min 不是数字`);
      if (hasMax && !Number.isFinite(Number(spec.max))) problems.push(`状态 "${name}" 的 max 不是数字`);
      if (hasMin && hasMax && Number(spec.min) > Number(spec.max)) problems.push(`状态 "${name}" 的 min 大于 max`);
    }
  }

  const rules = Array.isArray(entity.rules) ? entity.rules : [];
  if (rules.length === 0) problems.push("一条规则都没有——那这个配方什么也不做");
  rules.forEach((rule, i) => {
    const at = `第 ${i + 1} 条规则`;
    if (!isPlainObject(rule)) { problems.push(`${at} 不是一个对象`); return; }
    if (typeof rule.when !== "string" || !rule.when.trim()) problems.push(`${at} 缺 when`);
    if (typeof rule.effect !== "string" || !rule.effect.trim()) problems.push(`${at} 缺 effect`);
    // effect 里写的名字必须在 state 里声明过——否则它改的是一个不存在的量
    const m = new RegExp("^(" + VAR_NAME_PATTERN + ")\\s*(?:\\+=|-=|=)").exec(String(rule.effect || "").trim());
    if (m && names.length > 0 && !names.includes(m[1])) {
      problems.push(`${at} 改的 "${m[1]}" 没在 state 里声明`);
    }

    /*
     * 条件里引用的名字同样要查。
     *
     * 这一条是我一开始漏掉的，而漏掉的后果和上面一模一样——
     * 只是更难发现：改错名字的 effect 会抛错或写到一个新键上（看得见），
     * 而条件里错一个字母只会让它从此不命中（看不见）。
     */
    const when = namesInWhen(rule.when);
    for (const seg of when.bad) problems.push(`${at} 的条件看不懂："${seg}"`);
    for (const name of when.names) {
      if (names.length > 0 && !names.includes(name)) {
        problems.push(`${at} 的条件引用了 "${name}"，它没在 state 里声明`);
      }
    }
  });

  return problems;
}

/** 出场状态：每个变量取自己的 init。 */
export function initialDirectorState(entity) {
  const out = {};
  for (const [name, spec] of Object.entries(isPlainObject(entity?.state) ? entity.state : {})) {
    out[name] = varKindOf(spec) === VarKind.FLAG ? !!spec.init : Number(spec.init) || 0;
  }
  return out;
}

/** 状态规范化：声明过的量补齐初值，声明外的量原样留着（不静默丢用户数据）。 */
export function normalizeDirectorState(entity, state) {
  const out = { ...(isPlainObject(state) ? state : {}) };
  for (const [name, spec] of Object.entries(isPlainObject(entity?.state) ? entity.state : {})) {
    const kind = varKindOf(spec);
    if (out[name] === undefined) {
      out[name] = kind === VarKind.FLAG ? !!spec.init : Number(spec.init) || 0;
    } else if (kind === VarKind.FLAG) {
      out[name] = !!out[name];
    } else if (!Number.isFinite(Number(out[name]))) {
      out[name] = Number(spec.init) || 0;
    }
  }
  return out;
}

/** 会不会推进：至少要有一条无条件的 effect，否则状态永远停在原地。 */
export function hasBaseline(entity) {
  return (entity?.rules || []).some(r => String(r?.when || "").trim() === "always" && ruleHasEffect(r));
}
