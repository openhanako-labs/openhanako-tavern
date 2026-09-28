// lib/settings/import.js — ST 世界书 / 角色卡内嵌世界书导入
//
// 字段映射依据：
//   - docs.sillytavern.app/usage/core-concepts/worldinfo
//   - DiceFrame src/lorebook/adapters/sillytavern.py（字段语义的交叉验证）
//
// 关键语义（不可想当然）：
//   - selectiveLogic 是【副键】逻辑，主键必须仍然匹配。四值：
//       0=AND_ANY  1=NOT_ALL  2=NOT_ANY  3=AND_ALL
//     未识别值回退 AND_ANY（ST 默认），不发明新模式。
//   - ST position 数字编码与文本 anchor 不是 1:1：
//       0=before_char  1=after_char  2/3=AN  4=atDepth  5/6=example  7=outlet
//     保留原始编码在 extensions._preserved_position，不静默丢弃。
//   - constant=true 表示"始终激活"，等价于我们的 trigger.type = always。
//   - useRegex=true 时 key 是 JS 正则；我们跑 JS，所以可直接用。

import { createSetting, TriggerType } from "./model.js";

/** ST selectiveLogic 数字编码 → 规范名。 */
export const ST_SELECTIVE_LOGIC = {
  0: "and_any",
  1: "not_all",
  2: "not_any",
  3: "and_all"
};

/** 兼容别名（字符串形式的历史写法）。 */
const SELECTIVE_LOGIC_ALIASES = {
  "": "and_any",
  "0": "and_any", "1": "not_all", "2": "not_any", "3": "and_all",
  "and": "and_any", "and_any": "and_any", "any": "and_any", "or": "and_any",
  "and_all": "and_all", "all": "and_all",
  "not_any": "not_any",
  "not_all": "not_all"
};

export function normalizeSelectiveLogic(value) {
  if (value === undefined || value === null) return "and_any";
  const raw = String(value).trim().toLowerCase();
  return SELECTIVE_LOGIC_ALIASES[raw] ?? "and_any";
}

/** ST position 数字 → 我们的 anchor 名。无法映射时保留原值。 */
export function mapPosition(position) {
  const map = {
    0: "before_char",
    1: "after_char",
    2: "an_top",
    3: "an_bottom",
    4: "at_depth",
    5: "example_before",
    6: "example_after",
    7: "outlet"
  };
  const n = Number(position);
  return map[n] ?? null;
}

/** 把 ST 的 key/keys 字段统一成数组。 */
function toStringArray(value) {
  if (Array.isArray(value)) return value.map(v => String(v)).filter(Boolean);
  if (typeof value === "string") {
    return value.split(",").map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * 单个 ST 世界书条目 → 我们的设定对象。
 *
 * @param {object} entry - ST world book entry
 * @param {{ order?: number, source?: string }} [opts]
 */
export function stEntryToSetting(entry, opts = {}) {
  if (!entry || typeof entry !== "object") {
    throw new Error("entry must be an object");
  }

  const primaryKeys = toStringArray(entry.key ?? entry.keys);
  const secondaryKeys = toStringArray(entry.keysecondary ?? entry.secondary_keys ?? entry.secondaryKeys);
  const constant = !!entry.constant;
  const disabled = !!(entry.disable ?? entry.disabled);
  const useRegex = !!(entry.useRegex ?? entry.use_regex);

  // 主触发：constant → always；否则 keyword/regex
  let trigger;
  if (constant) {
    trigger = { type: TriggerType.ALWAYS, keywords: primaryKeys, caseSensitive: !!entry.caseSensitive };
  } else if (useRegex) {
    trigger = { type: TriggerType.REGEX, regex: primaryKeys.join("|"), keywords: primaryKeys, caseSensitive: !!entry.caseSensitive };
  } else {
    trigger = { type: TriggerType.KEYWORD, keywords: primaryKeys, caseSensitive: !!entry.caseSensitive };
  }

  const selectiveLogic = normalizeSelectiveLogic(entry.selectiveLogic ?? entry.selective_logic);
  const selective = entry.selective !== false; // ST 默认 true
  const position = entry.position;
  const anchor = mapPosition(position);

  return createSetting({
    name: String(entry.comment ?? entry.name ?? "").trim() || "（无名称）",
    type: "custom",
    description: String(entry.comment ?? ""),
    content: String(entry.content ?? ""),

    keywords: primaryKeys,
    trigger,

    // 副键与选择性逻辑（世界书引擎在 C3 消费）
    secondaryKeys,
    selectiveLogic,
    selective,

    // 插入位置
    position: position ?? null,
    anchor,

    // 排序与概率
    priority: 100,

    /*
     * 顺序：调用方给了就用调用方的；没给就尊重条目自己的 order。
     *
     * 这一层**不是死代码**：stEntryToSetting 是对外导出的，单条转换
     * （测试、路由里的单条路径）就是靠这个 fallback 拿到原来的 order。
     * 【2026-09-27：我一开始以为它不可达，测试当场纠正了我。】
     *
     * 真正需要小心的是批量那条路：stWorldBookToSettings 会**自己编号**，
     * 因为它要先把整本按 ST 的 order 降序排好（单条上看不出全局顺序）。
     */
    order: Number.isFinite(Number(opts.order))
      ? Number(opts.order)
      : (Number.isFinite(Number(entry.order)) ? Number(entry.order) : 100),
    probability: Number(entry.probability ?? 100) || 100,

    // 递归（C3 消费）
    excludeRecursion: !!(entry.excludeRecursion ?? entry.nonRecursable),
    preventRecursion: !!(entry.preventFurtherRecursion ?? entry.preventRecursion),
    delayUntilRecursion: !!(entry.delayUntilRecursion),
    recursionLevel: Number(entry.recursionLevel ?? 0) || 0,

    // 匹配控制
    matchWholeWords: !!entry.matchWholeWords,
    caseSensitive: !!entry.caseSensitive,
    scanDepth: Number(entry.scanDepth ?? 0) || 0,

    // 定时效果（保留原始值）
    sticky: Number(entry.sticky ?? 0) || 0,
    cooldown: Number(entry.cooldown ?? 0) || 0,
    delay: Number(entry.delay ?? 0) || 0,

    enabled: !disabled,

    // 溯源 + 原始数据（不丢字段）
    source: opts.source || "sillytavern",
    externalId: String(entry.uid ?? entry.id ?? ""),
    extensions: {
      _preserved_position: position ?? "",
      _raw: entry
    }
  });
}

/**
 * ST 世界书文件（{ entries: {...} | [...] }）→ 设定数组。
 *
 * ST 导出格式里 entries 可能是数组或对象（key 为 uid）。
 */
export function stWorldBookToSettings(worldBook, opts = {}) {
  if (!worldBook || typeof worldBook !== "object") {
    throw new Error("Invalid world book: not an object");
  }

  let rows = worldBook.entries;
  if (!rows) throw new Error("Invalid world book: missing entries");

  // 对象形式 → 数组（按 uid 排序保证稳定）
  if (!Array.isArray(rows)) {
    rows = Object.keys(rows)
      .sort((a, b) => Number(a) - Number(b))
      .map(k => rows[k]);
  }

  /*
   * 编号之前，先按 ST 自己的 `order` **降序**排一遍。
   *
   * 为什么必须排：ST 那边进 prompt 的顺序就是 `(a,b) => b.order - a.order`
   * （world-info.js:88，大的先），而我们的 entrySortKey 是**升序**（小的先）——
   * 两边方向相反。以前这里不排，直接按 uid（=创建顺序）编号，
   * 于是导进来的世界书**用「创建顺序」顶掉了用户在 ST 里排好的顺序**，
   * 而且哪一步都不报错。
   *
   * 排序是稳定的：同 order 的保持输入顺序（输入已按 uid 排过）。
   */
  const stOrder = (e) => {
    const n = Number(e?.order);
    return Number.isFinite(n) ? n : 100;   // ST 新条目的默认 order 是 100
  };
  const ordered = rows.slice().sort((a, b) => stOrder(b) - stOrder(a));

  const settings = [];
  let order = 1;
  for (const row of ordered) {
    if (!row || typeof row !== "object") continue;
    try {
      settings.push(stEntryToSetting(row, { order: order++, source: opts.source }));
    } catch {
      // 单条坏数据不应中断整个导入
    }
  }

  return settings;
}

/**
 * 角色卡内嵌的 character_book → 设定数组。
 *
 * ST 卡里 character_book 的形状与独立世界书一致（{ entries: [...] }），
 * 但 entries 里可能没有 comment，只有 name。
 */
export function characterBookToSettings(characterBook, opts = {}) {
  if (!characterBook || typeof characterBook !== "object") return [];

  // 兼容两种形状：{ entries: [...] } 或直接是数组
  if (Array.isArray(characterBook)) {
    return stWorldBookToSettings({ entries: characterBook }, opts);
  }

  return stWorldBookToSettings(characterBook, { ...opts, source: opts?.source || "character_book" });
}
