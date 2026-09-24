// lib/board/model.js — 黑板的数据模型
//
// 黑板是「这个世界此刻的样子」，不是又一份设定库。
// 一条记录带三个**正交**的标签，互不决定：
//
//   lifespan    活多久       world（跨对话） / chat（只在这一场）
//   visible     谁看得见     public / user / char:<角色id>
//   activation  什么时候醒   keyword（被提到） / constant（一直在）
//
// 为什么不照原酒馆那种「四层」：那套把三件正交的事糅成了一件，结果
// 「角色自带的世界书」和「这一场临时冒出来的地点」坐不进同一张表。
// 拆成三个标签之后，一条记录可以同时是「世界级 · 只有薇拉看得见 · 被提到才醒」。
//
// 两块护身符（都是从踩过的坑里来的）：
//   1. **可见性 fail closed**——不认识的取值一律判不可见。宁可少给一条，
//      不可漏给一格：私密格泄漏比少一条设定严重得多。
//   2. **黑板格独立于世界书**。世界书条目是「关键词触发 → 注入文本」的内容载体，
//      黑板格是「多变量绑定 + 三维状态 + 归属」。硬塞进 lore/matcher 当新字段，
//      排序键、token 预算、激活报告全要按两种实体分叉，最后一定重构。
//      所以这里自己一套；lore 需要问的时候，只通过 isVisibleTo / cellApplies 咨询。

import crypto from "node:crypto";

export const BoardLifespan = {
  WORLD: "world",
  CHAT: "chat"
};

export const BoardActivation = {
  KEYWORD: "keyword",
  CONSTANT: "constant"
};

export const USER_VISIBILITY = "user";

/** 角色可见性的取值形态：`char:<角色id>` */
export function charVisibility(characterId) {
  return `char:${characterId}`;
}

const LIFESPANS = new Set(Object.values(BoardLifespan));
const ACTIVATIONS = new Set(Object.values(BoardActivation));
const CHAR_VISIBLE = /^char:.+$/;

export function createBoardCell(overrides = {}) {
  return normalizeBoardCell({
    id: crypto.randomUUID(),
    title: "",
    body: "",
    lifespan: BoardLifespan.CHAT,
    visible: "public",
    activation: BoardActivation.KEYWORD,
    keywords: [],
    order: 100,
    enabled: true,
    source: "manual",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  });
}

/**
 * 补齐 / 纠偏一格黑板。
 *
 * 注意 `visible` 的处理：**不认识的字符串原样保留**，由 isVisibleTo 判成不可见
 * （fail closed）。这里不把它"修正"成 public——那等于把一格私密变成公开，
 * 是整个子系统里最不能犯的错。
 */
export function normalizeBoardCell(cell) {
  if (!cell || typeof cell !== "object") return cell;

  const out = { ...cell };

  out.title = typeof out.title === "string" ? out.title : "";
  out.body = typeof out.body === "string" ? out.body : "";

  if (!LIFESPANS.has(out.lifespan)) out.lifespan = BoardLifespan.CHAT;
  if (!ACTIVATIONS.has(out.activation)) out.activation = BoardActivation.KEYWORD;

  // 缺字段 / 不是字符串 → 当作公开（新建时一定写了；这里是读侧兜底）
  // 是字符串但不认识 → 原样留着，让 isVisibleTo 判不可见
  if (typeof out.visible !== "string" || !out.visible) out.visible = "public";

  out.keywords = Array.isArray(out.keywords)
    ? out.keywords.map(k => String(k || "").trim()).filter(Boolean)
    : [];

  out.order = Number.isFinite(Number(out.order)) ? Number(out.order) : 100;
  out.enabled = out.enabled !== false;
  out.source = typeof out.source === "string" && out.source ? out.source : "manual";

  return out;
}

/**
 * 这条记录对某个观察者是否可见。
 * @param {object} cell
 * @param {{ characterId?: string }} [viewer] 观察者；不传 = 用户自己（公共视角）
 */
export function isVisibleTo(cell, viewer = {}) {
  const v = cell?.visible;
  if (v === undefined || v === null || v === "public") return true;

  const cid = viewer?.characterId || null;

  // 只有用户看得见 → 任何角色视角都读不到
  if (v === USER_VISIBILITY) return !cid;

  // 只有某个角色看得见
  if (typeof v === "string" && CHAR_VISIBLE.test(v)) return !!cid && v.slice(5) === cid;

  // 不认识的取值：fail closed
  return false;
}

/** 关键词是否命中（大小写不敏感）。 */
export function keywordHit(cell, text) {
  if (cell?.activation !== BoardActivation.KEYWORD) return false;
  const keys = Array.isArray(cell?.keywords) ? cell.keywords : [];
  if (keys.length === 0) return false;
  const hay = String(text || "").toLowerCase();
  return keys.some(k => k && hay.includes(String(k).toLowerCase()));
}

/**
 * 这一轮，这条记录上场吗。
 * 三个条件都过才算：开着 → 对这个观察者可见 → 激活条件满足。
 * 这是引擎"裁决"的入口：lore 或管道想问"这条该不该进上下文"，问这里。
 */
export function cellApplies(cell, { text = "", viewer = {} } = {}) {
  if (!cell) return false;
  if (cell.enabled === false) return false;
  if (!isVisibleTo(cell, viewer)) return false;
  if (cell.activation === BoardActivation.CONSTANT) return true;
  return keywordHit(cell, text);
}

/** 按 order 升序、同序时按 title——保证渲染与注入的顺序稳定（缓存要字节稳定）。 */
export function sortBoardCells(cells) {
  return [...(cells || [])].sort((a, b) => {
    const oa = Number(a?.order ?? 100) || 0;
    const ob = Number(b?.order ?? 100) || 0;
    if (oa !== ob) return oa - ob;
    return String(a?.title || "").localeCompare(String(b?.title || ""));
  });
}
