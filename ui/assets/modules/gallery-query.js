// gallery-query.js — 图库「两级范围」的纯规则
//
// 为什么单独一个文件（同 settings-fold.js 的理由）：
//   gallery.js 是 DOM 模块（要 apiFetch / dom.*），Node 里 import 不了。
//   而两级怎么拼、空态说什么，是**契约**而不是实现细节——
//   契约就必须有测试盯着，所以它们必须住在一个零依赖的文件里。
//
// 两级的分界是**归属**，不是时间：
//   · 本场（conv） —— 这一场对话里画出来的场景插图
//                     （台账里 conversationId 对得上当前对话）
//   · 全部（all）  —— 立绘 + 所有场次的场景插图
//
// ⚠ 立绘属于**角色卡**，不属于某一场。所以「本场 + 立绘」**恒为空**。
//   这是设计，不是 bug——galleryEmptyState 会把这句话说给用户听，
//   否则用户会在这里反复点选却永远看不到东西，还以为图库坏了。

/**
 * 拼 /media/index 的查询串。
 *
 * @param {{scope?: "conv"|"all", kind?: string, conversationId?: string|null}} [f]
 * @returns {string} 形如 "?kind=scene&conversationId=abc"；无条件时 ""
 *
 * 两条边界，都不是洁癖：
 *
 * ① scope="conv" 但没有 conversationId（还没开对话）→ **不带**这个参数。
 *    否则会拼出 `conversationId=`（空串）。后端 filter.conversationId 用
 *    `!= null` 判，空串当成一个**真实 id** 去比，结果恒为空。
 *    而那正是用户最不该看到的一种空——他会以为图库坏了，
 *    其实只是没开对话。所以这里宁可不带，把判断交给上层（空态）。
 *
 * ② kind 为空串 / null / undefined → 不带 kind。
 *    空 kind 会让后端 `filter.kind = ""`，而 `r.kind !== ""` 恒真——
 *    同样是一条都筛不出来。
 */
export function buildGalleryQuery({ scope = "all", kind = "", conversationId = null } = {}) {
  const p = new URLSearchParams();
  const conv = typeof conversationId === "string" ? conversationId.trim() : "";
  if (scope === "conv" && conv) p.set("conversationId", conv);
  const k = typeof kind === "string" ? kind.trim() : "";
  if (k) p.set("kind", k);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/**
 * 空态文案。**必须说清「没有」的是什么，而且顺手教一次用法。**
 *
 * 为什么值得单独一个函数：这里最容易写成「暂无数据」四个字，
 * 而四种空的原因完全不同——
 *   没开对话 / 这一场还没画 / 立绘本就不属于某场 / 整个 App 还没出过图。
 * 分成四种，用户才知道下一步该干什么，而不是原地猜。
 *
 * @param {{scope?: string, kind?: string, hasConv?: boolean}} [f]
 * @returns {{title: string, desc: string, ico: string}}
 */
export function galleryEmptyState({ scope = "all", kind = "", hasConv = false } = {}) {
  const ICO = "🖼";

  // 本场 + 立绘：恒为空，而且**不是 bug**。
  // 这句话是整个抽屉里最该说的一句——不说，用户会在这里反复点选。
  if (scope === "conv" && kind === "portrait") {
    return {
      ico: ICO,
      title: "本场只会有场景插图",
      desc: "立绘属于角色卡，不属于某一场对话——切到「全部」才看得到。想在这一场里添一张，用聊天框 ⋯ 里的「补一张场景图」。"
    };
  }

  if (scope === "conv" && !hasConv) {
    return {
      ico: ICO,
      title: "还没打开一场对话",
      desc: "「本场」是跟着当前对话走的。开一场对话它才会有东西；或者切到「全部」，看所有场次和所有立绘。"
    };
  }

  if (scope === "conv") {
    return {
      ico: ICO,
      title: "这一场还没有图",
      desc: "模型的回复末尾写上 [场景] 加一句画面描述，这里就会出现一张；也可以在聊天框 ⋯ 里手动「补一张场景图」。"
    };
  }

  if (kind === "portrait") {
    return {
      ico: ICO,
      title: "还没有立绘",
      desc: "打开「当前角色」面板，给某张卡点「生成立绘」——那一步出的图会登记进这里。"
    };
  }

  if (kind === "scene") {
    return {
      ico: ICO,
      title: "还没有场景插图",
      desc: "在一场对话里让模型写 [场景] 标记，或者用聊天框 ⋯ 里的「补一张场景图」。插图要打开「场景插图」设置才会自动出。"
    };
  }

  return {
    ico: ICO,
    title: "还没有出过图",
    desc: "两个来源：给角色卡生成立绘，或者在一场对话里画场景插图。两边出的图都会记在这里。"
  };
}

/**
 * 计数行文案。
 *
 * @param {{scope?: string, shown?: number, total?: number}} [f]
 * @returns {string} 空的时候返回空串——调用方据此整行隐藏（CSS 的 :empty 兜底）
 *
 * 为什么返回空串而不是 "0 张"：计数行是**状态**，不是标题。
 * 空的时候留一行 "0 张" 只会让抽屉看起来多了一条没用的信息（基准 5 · 一节 ③）。
 */
export function galleryCountText({ scope = "all", shown = 0, total = 0 } = {}) {
  const who = scope === "conv" ? "本场" : "全部";
  const t = Number(total) || 0;
  if (t <= 0) return "";
  const s = Math.max(0, Math.min(Number(shown) || 0, t));
  if (s >= t) return `${who} ${t} 张`;
  return `${who} ${s} / ${t} 张`;
}
