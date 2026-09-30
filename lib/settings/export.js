// lib/settings/export.js — 设定 → ST 世界书 / 角色卡内嵌 character_book
//
// 与 import.js 严格互逆是这里的判据。
//
// 保真的关键在 extensions._raw：导入时把 ST 原条目**整个**存了下来。
// 所以导出的第一选择不是「重建」，而是「还回去」——
//   只存我们认识的字段 → ST 后来加的新键会在一次往返里蒸发；
//   一律重建         → 用户在 ST 里排的 order、我们还没有概念的字段，同样蒸发。
//
// 判据是「拿 _raw 再跑一遍导入，结果和现在这条一样吗」：
//   一样 → 这一条从头到尾没被动过 → 逐字还它原样。
//   不一样 → 用户改过 → 才走重建，把我们这边的值覆盖上去。
//
// 一处理解上的坑：ST 的 order 与我们的 order **方向相反**。
//   ST：prompt 里 order 大的先（world-info.js:88 的 b.order - a.order）。
//   我们：entrySortKey 升序，小的先。
//   import.js 是靠「先按 ST order 降序排、再从头编号」把方向掰过来的。
//   所以导出时原样写回 _raw.order（有的话），而不是把 1..N 当 ST order 发出去——
//   那样 ST 那边会把它读成「排在 100 后面的附录」。

import { TriggerType } from "./model.js";
import { stEntryToSetting, mapPosition, ST_SELECTIVE_LOGIC } from "./import.js";

/** anchor 名 → ST position 数字（mapPosition 的反函数）。 */
const POSITION_BY_ANCHOR = {
  before_char: 0,
  after_char: 1,
  an_top: 2,
  an_bottom: 3,
  at_depth: 4,
  example_before: 5,
  example_after: 6,
  outlet: 7
};

/** 规范名 → ST selectiveLogic 数字。 */
const SELECTIVE_LOGIC_BY_NAME = Object.fromEntries(
  Object.entries(ST_SELECTIVE_LOGIC).map(([num, name]) => [name, Number(num)])
);

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v, dflt = 0) => (Number.isFinite(Number(v)) ? Number(v) : dflt);

function toArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

/**
 * 我们接管的字段清单——「改没改过」只比这一批。
 *
 * 比全字段是不行的：_raw 里可能有二十几个键，其中大部分我们没有概念，
 * 拿它们去判「动没动过」只会一直被认成"动过"，于是每次都走重建、
 * 每次都要丢一批字段。比接管的这批，判据才落在用户真能动的东西上。
 */
function managedShape(setting) {
  const trig = setting.trigger || {};
  return JSON.stringify({
    name: setting.name ?? "",
    content: setting.content ?? "",
    keywords: toArray(setting.keywords),
    secondaryKeys: toArray(setting.secondaryKeys),
    triggerType: trig.type || "",
    triggerRegex: trig.regex ?? "",
    // 主键也算：只改了 trigger.keywords 而没动 setting.keywords，同样是一次改动，
    // 漏了它就会把「改了键」判成「没动过」，于是导出的还是旧键
    triggerKeywords: toArray(trig.keywords),
    triggerCase: !!trig.caseSensitive,
    selective: setting.selective !== false,
    selectiveLogic: setting.selectiveLogic ?? "and_any",
    anchor: setting.anchor ?? "",
    enabled: setting.enabled !== false,
    probability: num(setting.probability, 100),
    sticky: num(setting.sticky, 0),
    cooldown: num(setting.cooldown, 0),
    delay: num(setting.delay, 0),
    matchWholeWords: !!setting.matchWholeWords,
    caseSensitive: !!setting.caseSensitive,
    scanDepth: num(setting.scanDepth, 0),
    excludeRecursion: !!setting.excludeRecursion,
    preventRecursion: !!setting.preventRecursion,
    delayUntilRecursion: !!setting.delayUntilRecursion,
    recursionLevel: num(setting.recursionLevel, 0)
  });
}

/** 给导出条目定一个 uid：优先用它自己记着的 externalId，其次调用方给的，最后顺延。 */
function pickUid(setting, fallback) {
  const own = setting.externalId;
  // uid 0 是合法值（ST 第一条就是 0），所以不能拿真值判断“有没有”
  if (own !== undefined && own !== null && String(own).trim() !== "") {
    const n = Number(own);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback;
}

/** 插入位置：能保真就保真。 */
function positionOf(setting, base) {
  const preserved = setting.extensions?._preserved_position;
  const preservedOk = preserved !== "" && preserved !== undefined && preserved !== null
    && Number.isFinite(Number(preserved));
  /*
   * ST 的 2/3、5/6 各摊两个码（AN 上/下、示例前/后），而 anchor 名只有四个。
   * 光靠 anchor 反推**推不回原值**，所以原码要优先用——
   * 前提是 anchor 没被改过：改了还照发原码，两边就对不上了。
   */
  if (preservedOk) {
    const implied = mapPosition(Number(preserved));
    if (!setting.anchor || setting.anchor === implied) return Number(preserved);
  }
  const byAnchor = POSITION_BY_ANCHOR[setting.anchor];
  if (byAnchor !== undefined) return byAnchor;
  return Number.isFinite(Number(base?.position)) ? Number(base.position) : 1;
}

/**
 * 单条设定 → ST 世界书条目。
 *
 * @param {object} setting
 * @param {{ uid?: number, order?: number }} [opts]
 */
export function settingToStEntry(setting, opts = {}) {
  if (!isPlainObject(setting)) throw new Error("setting must be an object");

  const raw = isPlainObject(setting.extensions?._raw) ? setting.extensions._raw : null;

  // 没动过就原样还回去（连我们不认识的键一起）
  if (raw) {
    const baseline = stEntryToSetting(raw, { source: setting.source });
    if (managedShape(setting) === managedShape(baseline)) {
      const kept = { ...raw };
      kept.uid = pickUid(setting, Number(raw.uid) || opts.uid || 1);
      return kept;
    }
  }

  const base = raw ? { ...raw } : {};
  const trig = setting.trigger || {};
  const type = trig.type || TriggerType.KEYWORD;
  /*
   * 主键以 **trigger** 为准，不是 setting.keywords。
   *
   * 引擎（model.js 的 shouldTrigger）只读 trigger.keywords / trigger.regex，
   * setting.keywords 在它眼里根本不存在。拿后者导出，会出现
   * 「界面把 keywords 改了、trigger 没跟上」时导出的是旧值而引擎用的是空值
   * ——两边各说各话，这种错在回喂老酒馆之前看不出来。
   */
  const trigKeys = toArray(trig.keywords).length ? toArray(trig.keywords) : toArray(trig.regex);
  const keys = trigKeys.length ? trigKeys : toArray(setting.keywords);

  const rawOrder = Number(base.order);

  const entry = {
    ...base,
    uid: pickUid(setting, opts.uid || 1),
    comment: setting.name ?? "",
    content: setting.content ?? "",
    key: keys,
    keysecondary: toArray(setting.secondaryKeys),
    constant: type === TriggerType.ALWAYS,
    useRegex: type === TriggerType.REGEX,
    selective: setting.selective !== false,
    selectiveLogic: SELECTIVE_LOGIC_BY_NAME[setting.selectiveLogic] ?? 0,
    disable: setting.enabled === false,
    caseSensitive: !!setting.caseSensitive,
    matchWholeWords: !!setting.matchWholeWords,
    scanDepth: num(setting.scanDepth, 0),
    probability: num(setting.probability, 100),
    position: positionOf(setting, base),
    order: Number.isFinite(rawOrder) ? rawOrder : num(opts.order, 100),
    excludeRecursion: !!setting.excludeRecursion,
    preventRecursion: !!setting.preventRecursion,
    delayUntilRecursion: !!setting.delayUntilRecursion,
    recursionLevel: num(setting.recursionLevel, 0),
    sticky: num(setting.sticky, 0),
    cooldown: num(setting.cooldown, 0),
    delay: num(setting.delay, 0)
  };

  // 别名不留两份：ST 读的是 disable，留一个 disabled 在旁边只会让两边打架
  // category 也不导出：它是夜航船本地标签，不是世界书语义的一部分——
  // 导出去 ST 不会读，反而污染一份本该纯净的 JSON，下次导回来还得抹一次。
  delete entry.disabled;
  delete entry.keys;
  delete entry.secondary_keys;
  delete entry.nonRecursable;
  delete entry.category;

  return entry;
}

/**
 * 设定数组 → ST 世界书 JSON（`{ entries: { "<uid>": {...} } }`）。
 *
 * entries 用**对象**而不是数组：ST 官方导出的就是这么一份，
 * 且 key 就是 uid——两份条目撞了同一个 uid，后一份会在 ST 那边被吃掉。
 * 所以这里自己保证 uid 唯一（撞了就顺延到下一个空位）。
 */
export function settingsToStWorldBook(settings, opts = {}) {
  const list = (Array.isArray(settings) ? settings : []).filter(isPlainObject);
  // 导出顺序跟界面一致：order 升序
  const ordered = list
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (num(a.s.order, 100) - num(b.s.order, 100)) || (a.i - b.i))
    .map((x) => x.s);

  const entries = {};
  const used = new Set();
  let next = 1;

  for (const setting of ordered) {
    const entry = settingToStEntry(setting, { uid: next });
    let uid = Number(entry.uid);
    if (!Number.isFinite(uid) || uid < 0 || used.has(uid)) {
      while (used.has(next)) next++;
      uid = next;
      entry.uid = uid;
    }
    used.add(uid);
    if (uid >= next) next = uid + 1;
    entries[String(uid)] = entry;
  }

  const book = { entries };
  if (opts.name) book.name = String(opts.name);
  return book;
}

/** 一副「能直接喂给 ST」的 JSON 文本。 */
export function stringifyStWorldBook(settings, opts = {}) {
  return JSON.stringify(settingsToStWorldBook(settings, opts), null, 2);
}
