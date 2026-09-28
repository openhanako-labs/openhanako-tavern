/**
 * 设定库的分组口径 —— 纯函数，不碰 DOM。
 *
 * 为什么单独一个文件：
 *   这个口径**必须和运行时一致**。用户看到的“常驻”意味着
 *   “每一轮都在上下文里”，那是运行时的行为，不是界面的装饰。
 *   而 settings.js 是 DOM 模块，Node 里 import 不了——
 *   把口径挪出来，测试才能直接盯住它，而不是盯住一份抄写。
 *
 * 真机上量到的分布（106 条 / 2026-09-27）：
 *   always 64 · regex 40 · keyword 2
 *   其中 37 条是 `always` **又带触发词**（`交感同操`、`allmind`…）。
 *   那不是坏数据，是 ST 导入的正常产物——ST 的 constant 语义就是
 *   “触发词忽略”。所以它们在界面上归“常驻”，且不画触发词。
 */

/**
 * 是不是常驻条目。
 *
 * 口径与 lib/lore/matcher.js:80 逐字对齐：
 *   if (e.trigger?.type === "always" || e.isConstant) → 无条件加进种子
 * 也就是说，这两类条目**根本不看关键词**。
 */
export function isConstantSetting(s) {
  const t = s?.trigger?.type;
  if (t === "always" || s?.isConstant === true) return true;
  if (t === "keyword" || t === "regex") return false;
  // 老数据没有 trigger 字段：按“有没有可用触发词”判
  return (Array.isArray(s?.keywords) ? s.keywords : []).length === 0;
}

/**
 * 分组桶：0 常驻 / 1 触发 / 2 已停用。
 *
 * 停用单独一组，不混进“常驻/触发”——
 * 一条关掉的设定不该在生效组里冒充生效。
 */
export function settingBucket(s) {
  if (s?.enabled === false) return 2;
  return isConstantSetting(s) ? 0 : 1;
}

/** 分组抬头。顺序即渲染顺序。 */
export const SETTING_SECTIONS = [
  { key: 0, title: "常驻", hint: "每轮都在上下文里" },
  { key: 1, title: "触发", hint: "说到才进" },
  { key: 2, title: "已停用", hint: "现在不生效" }
];

/**
 * 这条的触发词现在**算不算数**。
 *
 * 常驻条目的触发词是惰性的（运行时压根不读），
 * 所以界面上不该用强调色画出来——那等于告诉用户“说到这个词就会生效”。
 */
export function keywordsAreLive(s) {
  return !isConstantSetting(s);
}
