/**
 * 设定库的折叠状态 —— 纯函数，不碰 DOM，不碰 localStorage。
 *
 * 为什么单独一个文件：
 *   折叠看似是纯 UI 状态，但它有一个**必须成立的不变量**——
 *   写入时用的 key 和读取时用的 key 必须逐字相同。
 *   这个不变量一旦破了，表现是「点了没反应」：不报错、不抛异常，
 *   只是永远读回 false。settings.js 是 DOM 模块，Node 里 import 不了，
 *   所以 key 的构造规则必须挪到这里，测试才盯得住它。
 *
 * 真事故（2026-09-28）：
 *   SETTING_SECTIONS 的 key 是**数字** 0/1/2，renderSection 里写
 *   `data-key="${escapeHtml(g.key)}"`，而 escapeHtml 当时用 `!str` 判空——
 *   `!0` 为 true，于是 escapeHtml(0) 返回空串，常驻组抬头的 data-key 成了 ""。
 *   点击写入 `...:trigger:`，渲染时读 `...:trigger:0`，两端永远对不上。
 *   触发/已停用两组的 key 是 1/2，恰好能对上 —— 所以**只有「常驻」坏**，
 *   看起来像是「只有第一组不能折叠」，掩盖了真正的原因。
 *
 * 因此这里把 key 的构造收成唯一入口，两侧都必须走它。
 */

/** 折叠状态在 localStorage 里的 key 前缀。 */
const FOLD_PREFIX = "eleckoi:settings-folded";

/**
 * 折叠 key。
 *
 * `String(groupKey)` 不能省：分组 key 可能是数字（SETTING_SECTIONS 就是 0/1/2），
 * 而从 dataset 读回来的永远是字符串。不统一，读写两端就会错位。
 *
 * @param {string} dim      分组维度（trigger / category / priority）
 * @param {string|number} groupKey 分组 key
 */
export function foldKey(dim, groupKey) {
  return `${FOLD_PREFIX}:${String(dim)}:${String(groupKey)}`;
}

/**
 * 读一个折叠值。没有记录默认 false（展开）。
 *
 * @param {string|number} groupKey
 * @param {string} dim
 * @param {(k: string) => string|null} read 取字符串的注入点（真实调用传 localStorage.getItem）
 */
export function readFolded(groupKey, dim, read) {
  try {
    return read(foldKey(dim, groupKey)) === "1";
  } catch {
    return false;
  }
}

/**
 * 算翻转后的新值。
 *
 * @param {string|number} groupKey
 * @param {string} dim
 * @param {(k: string) => string|null} read
 */
export function nextFoldedValue(groupKey, dim, read) {
  return !readFolded(groupKey, dim, read);
}
