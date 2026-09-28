/**
 * 公式绑定与进度的形状归一 —— 纯函数，不碰 IO。
 *
 * 为什么单独一个文件：
 *   2026-09-28 之前，一场对话只绑**一条**公式（`directorId` 是字符串），
 *   进度存在 `variables.__dir` 里，形状是**扁平**的：`{ 张力: 3 }`。
 *
 *   改成多条之后两处都变了形状：
 *     绑定：directorId: "a"        →  directorIds: ["a", "b"]
 *     进度：__dir: { 张力: 3 }      →  __dir: { a: { 张力: 3 }, b: { … } }
 *
 *   而**老对话文件不会自动改写**——它们读进来还是旧形状。
 *   所以每个读点都得同时认两种，且这份「怎么认」必须只有一处实现：
 *   写在 model.js 里 Node 测不到（那文件要 crypto 等宿主环境），
 *   写成纯函数就能直接钉用例。
 *
 * 一条底线：**旧形状永远能读**。宁可多写一个分支，也不能让
 * 已经跑着的对话丢掉进度。
 */

/** 判断一个值是不是「原始类型的状态量」（旧形状里的值长这样）。 */
function isScalarState(v) {
  return v === null || (typeof v !== "object" && typeof v !== "function");
}

/**
 * 从一份对话记录里取出绑定的公式 id 列表。
 *
 * 优先 `directorIds`；没有就退回旧的单值 `directorId`。
 * 两者都归一成去空、去重、保持顺序的字符串数组。
 *
 * @param {object} conv
 * @returns {string[]}
 */
export function directorIdsOf(conv) {
  const raw = Array.isArray(conv?.directorIds) && conv.directorIds.length
    ? conv.directorIds
    : (conv?.directorId ? [conv.directorId] : []);
  const out = [];
  for (const v of raw) {
    const s = String(v ?? "").trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * 写侧：把一串 id 归一成要落盘的形状。
 *
 * 同时维护两个字段——`directorIds` 是新形状，`directorId` 保留为
 * **第一条**（老版本读这个字段，保持向后兼容；空列表时是空串）。
 *
 * @param {string[]} ids
 * @returns {{directorIds: string[], directorId: string}}
 */
export function normalizeDirectorIds(ids) {
  const list = [];
  for (const v of Array.isArray(ids) ? ids : []) {
    const s = String(v ?? "").trim();
    if (s && !list.includes(s)) list.push(s);
  }
  return { directorIds: list, directorId: list[0] || "" };
}

/**
 * 从 `variables.__dir` 里取出**某一条公式**的进度。
 *
 * 认两种形状：
 *   · 新：`{ "uuid-a": { 张力: 3 } }` —— 取 raw[directorId]
 *   · 旧：`{ 张力: 3 }`              —— 扁平，整份都是这一条的
 *
 * 判据不是「有没有 directorId 这个键」，而是**值是不是对象**：
 * 旧形状的值全是原始类型（数字 / 布尔），新形状的值全是对象。
 * 用值判比用键判稳——状态名恰好叫 uuid 的概率可以忽略，
 * 但「值是不是对象」永远能分开两种形状。
 *
 * @param {object} raw   conv.variables.__dir
 * @param {string} directorId
 * @returns {object} 该公式的进度（认不出就返回空对象）
 */
export function dirStateOf(raw, directorId) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const key = String(directorId ?? "").trim();

  // 新形状：这个 id 有自己的命名空间
  const own = key ? raw[key] : undefined;
  if (own && typeof own === "object" && !Array.isArray(own)) return { ...own };

  // 旧形状：整份都是扁平的标量
  const vals = Object.values(raw);
  if (vals.length > 0 && vals.every(isScalarState)) return { ...raw };

  // 空对象，或认不出的形状（比如新形状但这条公式还没有进度）
  return {};
}

/**
 * 写侧：把某一条公式的进度写回 `__dir`，返回**新的** `__dir`。
 *
 * 这里承担那次「升格」：如果原来是旧形状（扁平），
 * 而这次写的是多条公式之一，就把旧的扁平数据挪到 `migrateFrom` 的
 * 命名空间下——否则那份进度会变成孤儿（谁都不认它）。
 *
 * 单条公式时**不做升格**：保持旧形状，老对话不被无谓改写。
 *
 * @param {object} raw        当前 __dir
 * @param {string} directorId 要写的这条
 * @param {object} state      这条的新进度
 * @param {object} [opts]
 * @param {string} [opts.migrateFrom] 旧扁平数据该归到哪个 id 下（升格时用）
 * @param {boolean} [opts.forceNested] 强制用新形状（绑定多于一条时为 true）
 * @returns {object} 新的 __dir
 */
export function writeDirState(raw, directorId, state, opts = {}) {
  const key = String(directorId ?? "").trim();
  if (!key) return raw && typeof raw === "object" ? raw : {};

  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const vals = Object.values(base);
  const looksLegacy = vals.length > 0 && vals.every(isScalarState);

  // 单条、且当前是旧形状、且没要求强制嵌套 → 维持旧形状（老对话不动）
  if (looksLegacy && !opts.forceNested) {
    return { ...state };
  }

  // 升格：旧扁平数据归到 migrateFrom 名下
  const out = {};
  if (looksLegacy) {
    const from = String(opts.migrateFrom ?? "").trim();
    if (from) out[from] = { ...base };
  } else {
    for (const [k, v] of Object.entries(base)) {
      out[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...v } : v;
    }
  }
  out[key] = { ...state };
  return out;
}

/**
 * 这份 `__dir` 是不是旧形状（扁平）。
 * 用于判断「要不要升格」。
 */
export function isLegacyDirState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const vals = Object.values(raw);
  return vals.length > 0 && vals.every(isScalarState);
}
