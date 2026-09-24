// lib/regex/repo.js — 正则脚本规则仓储
//
// 规则是「对文本做的替换」。它比看起来危险：一条写错的正则能让角色
// 说出完全不属于自己的话，而且没人会立刻发现。所以这里的纪律是：
//
//   1. 保存时编译（normalizeRule），坏的当场拒绝，不进运行时
//   2. 默认 disabled：新规则不该立刻影响别人的对话
//   3. scope 三层（global/preset/character）+ scopeId 限定生效范围
//   4. 存储形态单文件数组，读→改→原子写全程持锁
//
// 与 engine.js 的分工：本文件负责存与选（list/listFor/save），
// 真正应用规则、判断作用面在 engine.js。
//
// ST 兼容：importRules 接受 SillyTavern 的 RegexScript 形态，
// toStRegexScript 反向导出，两边字段名不同但语义一致。

import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, mutateJson, readJsonSafe } from "../atomic.js";
import { RegexScope, RegexSurface } from "./engine.js";

/** 单条规则最大长度：防一个规则把提示词撑爆 */
const MAX_RULE_LEN = 64 * 1024;

/**
 * 从 ST 的三个老开关反推 surfaces。
 *
 * 映射关系（与 engine.appliesToSurface 完全对应）：
 *   surfaces 含 prompt  ⟺ !markdownOnly
 *   surfaces 含 display ⟺ !promptOnly
 *   surfaces 含 stored  ⟺ runOnEdit
 */
function surfacesFromLegacy(o) {
  const out = [];
  if (o?.markdownOnly !== true) out.push(RegexSurface.PROMPT);
  if (o?.promptOnly !== true) out.push(RegexSurface.DISPLAY);
  if (o?.runOnEdit === true) out.push(RegexSurface.STORED);
  return out.length ? out : [RegexSurface.PROMPT];
}

/**
 * 读侧补齐：只管 surfaces 与三个派生开关，**不碰时间戳**。
 * （读一次就把 updated_at 刷新一遍，是那种“看起来无害”的谎——
 *   将来按“最近改过”排序时会全乱。）
 */
function withDerivedSurfaces(rule) {
  if (!rule || typeof rule !== "object") return rule;
  const surfaces = Array.isArray(rule.surfaces) && rule.surfaces.length
    ? rule.surfaces.filter(s => Object.values(RegexSurface).includes(s))
    : surfacesFromLegacy(rule);
  return {
    ...rule,
    surfaces,
    promptOnly: !surfaces.includes(RegexSurface.DISPLAY),
    markdownOnly: !surfaces.includes(RegexSurface.PROMPT),
    runOnEdit: surfaces.includes(RegexSurface.STORED)
  };
}

/**
 * 把外部输入收敛成一条合法规则。
 *
 * 支持两种 pattern 写法：
 *   1. "/pattern/flags"（SillyTavern 习惯）
 *   2. 裸 pattern + 独立 flags 字段
 * 非法直接抛——保存时就挡住，不留到运行时。
 *
 * ⚠️ 作用面这里有一段此前一直存在的**两套表示**，说清楚：
 *   · 本仓储存的是 `surfaces: ["prompt"|"display"|"stored"]`
 *   · 而引擎的 appliesToSurface() 读的是 ST 那三个老开关
 *     （promptOnly / markdownOnly / runOnEdit），**完全不看 surfaces**
 *   于是 surfaces 曾是一个摆设：界面与导入写了它，真正应用规则的那段不读。
 *   更阴的是 `markdownOnly` 以前根本不在返回值里——存一次就丢，
 *   一条原本不作用于 Prompt 的规则会开始作用于 Prompt。
 *
 * 现在：**surfaces 是唯一真源**，三个老开关降级成它的派生视图
 * （引擎与 ST 导出继续读它们，行为不变）：
 *     surfaces 含 prompt  ⟺ !markdownOnly
 *     surfaces 含 display ⟺ !promptOnly
 *     surfaces 含 stored  ⟺ runOnEdit
 * 没给 surfaces 时从三个开关反推，两边都能进。
 */
export function normalizeRule(input, existing = null) {
  if (!input || typeof input !== "object") throw new Error("规则必须是对象");

  const name = String(input.name ?? existing?.name ?? "").trim();
  if (!name) throw new Error("规则必须有 name");

  // "/a/g" → pattern="a" flags="g"
  let pattern = String(input.pattern ?? existing?.pattern ?? "");
  let flags = String(input.flags ?? existing?.flags ?? "g");
  const slashed = pattern.match(/^\/(.*)\/([a-z]*)$/);
  if (slashed) {
    pattern = slashed[1];
    if (slashed[2]) flags = slashed[2];
  }
  if (!pattern) throw new Error("规则必须有 pattern");

  // 编译一次，坏的当场暴露
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, flags);
  } catch (e) {
    throw new Error(`正则无效: ${e.message}`);
  }
  if (pattern.length > MAX_RULE_LEN || String(input.replacement ?? "").length > MAX_RULE_LEN) {
    throw new Error("规则过长");
  }

  const scope = Object.values(RegexScope).includes(input.scope)
    ? input.scope
    : (existing?.scope || RegexScope.GLOBAL);

  // ── 作用面：surfaces 为真源，三个老开关是派生视图 ──
  //
  // 优先级：显式 surfaces > 显式老开关（ST 导入走这条）> 原规则 > 缺省。
  // “缺省只作用于发请求前”与仓储原先的文档一致；从前引擎不看 surfaces，
  // 所以缺省值实际上也作用到了显示面——那才是偏差。
  const hasSurfaces = Array.isArray(input.surfaces) && input.surfaces.length > 0;
  const hasLegacy = input.promptOnly !== undefined
    || input.markdownOnly !== undefined
    || input.runOnEdit !== undefined;

  let surfaces;
  if (hasSurfaces) {
    surfaces = input.surfaces.filter(s => Object.values(RegexSurface).includes(s));
  } else if (hasLegacy) {
    surfaces = surfacesFromLegacy(input);
  } else if (existing) {
    surfaces = Array.isArray(existing.surfaces) && existing.surfaces.length
      ? existing.surfaces.filter(s => Object.values(RegexSurface).includes(s))
      : surfacesFromLegacy(existing);
  } else {
    surfaces = [RegexSurface.PROMPT];
  }
  if (surfaces.length === 0) surfaces = [RegexSurface.PROMPT];

  // 派生视图：引擎与 ST 导出读的是这三个
  const promptOnly = !surfaces.includes(RegexSurface.DISPLAY);
  const markdownOnly = !surfaces.includes(RegexSurface.PROMPT);
  const runOnEdit = surfaces.includes(RegexSurface.STORED);

  return {
    id: existing?.id || input.id || crypto.randomUUID(),
    name,
    pattern,
    replacement: String(input.replacement ?? existing?.replacement ?? ""),
    flags: flags.replace(/[^dgimsuvy]/g, ""),
    scope,
    scopeId: input.scopeId ?? existing?.scopeId ?? null,
    /** 作用面：唯一真源。storage/display/prompt，缺省只作用于发请求前 */
    surfaces,
    /** 派生：对用户输入/落盘也生效（等同于 surfaces 含 stored） */
    runOnEdit,
    /** 派生：只作用于请求、不改变展示文本（等同于 surfaces 不含 display） */
    promptOnly,
    /** 派生：不作用于发请求前（等同于 surfaces 不含 prompt） */
    markdownOnly,
    /**
     * enabled 语义：disabled=false 表示启用。
     * create（本 App 内新建）默认启用 —— 用户刚建的规则当然要生效；
     * 从 ST 导入时由 fromStRegexScript 显式传 disabled，那边的默认才是关。
     */
    disabled: input.disabled !== undefined
      ? input.disabled === true
      : (existing ? existing.disabled === true : false),
    order: Number.isFinite(input.order) ? input.order : (existing?.order ?? 0),
    created_at: existing?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

/** ST → 内部 */
export function fromStRegexScript(script, opts = {}) {
  return normalizeRule({
    name: script.scriptName || script.name || "未命名规则",
    // ST 把正则拆成 findRegex / replaceString
    pattern: script.findRegex ?? script.pattern,
    replacement: script.replaceString ?? script.replacement ?? "",
    flags: script.flags ?? "g",
    disabled: script.disabled !== false,
    runOnEdit: script.runOnEdit === true,
    promptOnly: script.promptOnly === true,
    // markdownOnly 以前**没收**：于是 ST 里一条「不作用于提示词」的规则
    // 导进来就会开始作用于提示词。三个开关必须一起收，才能正确反推 surfaces。
    markdownOnly: script.markdownOnly === true,
    order: opts.order ?? 0,
    ...opts
  });
}

/** 内部 → ST */
export function toStRegexScript(rule) {
  return {
    id: rule.id,
    scriptName: rule.name,
    // ST 的 findRegex 是 "/pattern/flags" 整体形态
    findRegex: `/${rule.pattern}/${rule.flags || "g"}`,
    replaceString: rule.replacement,
    flags: rule.flags || "g",
    disabled: rule.disabled === true,
    runOnEdit: rule.runOnEdit === true,
    promptOnly: rule.promptOnly === true,
    // 以前写死 false：导出一条 markdownOnly 的规则，回迁后就变了性质。
    markdownOnly: rule.markdownOnly === true,
    substituteRegex: 0
  };
}

export class RegexRepo {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dir = path.join(dataDir, "regex");
    this.file = path.join(this.dir, "rules.json");
  }

  async init() {
    await ensureDir(this.dir);
    await mutateJson(this.file, [], (cur) => (Array.isArray(cur) ? cur : []));
    return this;
  }

  async list() {
    const list = await readJsonSafe(this.file, []);
    const arr = Array.isArray(list) ? list : [];
    // 读侧补齐 surfaces 与三个派生开关：老数据（没 surfaces）与 ST 导入
    // 都能被界面与引擎看成一样的东西。不改写盘上文件，不做迁移。
    return arr.slice()
      .map(withDerivedSurfaces)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  /**
   * 取「这个上下文该用哪些规则」。
   *
   * ctx = { characterId, presetId, placement?, surface? }
   * - scope 不匹配 → 排除
   * - surface 不含 → 排除
   * - disabled → 排除
   */
  async listFor(context = {}) {
    const { characterId = null, presetId = null, surface = null, placement = null } = context;
    const all = await this.list();
    return all.filter((r) => {
      if (r.disabled !== false) return false;
      // scope 判定（与 engine.scopeMatches 同一套语义）
      switch (r.scope) {
        case RegexScope.GLOBAL: break;
        case RegexScope.CHARACTER:
          if (!characterId || r.scopeId !== characterId) return false;
          break;
        case RegexScope.PRESET:
          if (!presetId || r.scopeId !== presetId) return false;
          break;
        default: return false;
      }
      // surface：给了才过滤，不给视为都过
      if (surface && Array.isArray(r.surfaces) && r.surfaces.length > 0) {
        if (!r.surfaces.includes(surface)) return false;
      }
      if (placement && r.placement && r.placement !== placement) return false;
      return true;
    });
  }

  async get(id) {
    const all = await this.list();
    return all.find(r => r.id === id) || null;
  }

  /** 新增一条。拒绝重复 id。 */
  async create(input) {
    if (input?.id) throw new Error("create 不接受 id，id 由仓储生成");
    const rule = normalizeRule(input, null);
    await mutateJson(this.file, [], (cur) => {
      const list = Array.isArray(cur) ? cur : [];
      if (list.some(r => r.id === rule.id)) throw new Error(`id 已存在: ${rule.id}`);
      list.push(rule);
      return list;
    });
    return rule;
  }

  /** 改一条。外部不可改 id；不存在的规则抛错。 */
  async update(id, updates = {}) {
    let saved = null;
    await mutateJson(this.file, [], (cur) => {
      const list = Array.isArray(cur) ? cur : [];
      const i = list.findIndex(r => r.id === id);
      if (i === -1) throw new Error(`规则不存在: ${id}`);
      const merged = normalizeRule(
        { ...list[i], ...updates, id },
        list[i]
      );
      list[i] = merged;
      saved = merged;
      return list;
    });
    return saved;
  }

  async deleteRule(id) {
    let found = false;
    await mutateJson(this.file, [], (cur) => {
      const list = Array.isArray(cur) ? cur : [];
      found = list.some(r => r.id === id);
      return list.filter(r => r.id !== id);
    });
    if (!found) throw new Error(`规则不存在: ${id}`);
    return true;
  }

  /** deleteRule 的别名（测试与老代码用 remove） */
  async remove(id) {
    return this.deleteRule(id);
  }

  async setEnabled(id, enabled) {
    return this.update(id, { disabled: enabled !== true });
  }

  /**
   * 批量导入。同 id 覆盖，不产生副本。
   * @returns {Promise<{added:number, updated:number}>}
   */
  async importRules(items) {
    if (!Array.isArray(items)) throw new Error("需要规则数组");
    let added = 0, updated = 0;
    await mutateJson(this.file, [], (cur) => {
      const list = Array.isArray(cur) ? cur : [];
      items.forEach((raw, idx) => {
        // 已是内部形态（有 pattern 且不带 findRegex）就直接 normalize；
        // 否则视为 ST 形态
        const isSt = raw && typeof raw === "object"
          && (raw.findRegex !== undefined || raw.scriptName !== undefined)
          && raw.pattern === undefined;
        const rule = isSt
          ? fromStRegexScript(raw, { order: idx })
          : normalizeRule({ ...raw, order: raw.order ?? idx }, null);

        const i = list.findIndex(r => r.id === rule.id);
        if (i >= 0) { list[i] = rule; updated++; }
        else { list.push(rule); added++; }
      });
      return list;
    });
    return { added, updated };
  }

  /** 导出为 ST 形态 */
  async exportSt() {
    const all = await this.list();
    return all.map(toStRegexScript);
  }
}

export function createRegexRepo(dataDir) {
  return new RegexRepo(dataDir);
}
