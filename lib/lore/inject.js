// lib/lore/inject.js — 按锚点把世界书条目分流到最终请求
//
// 为什么独立成模块：这段逻辑原本藏在 conversations/routes.js 的闭包里，
// 导致它**无法被单测覆盖**——而"条目最终落在哪个位置"恰恰是
// 单元测试测不到、只有真实运行才暴露问题的地方。
//
// ST 的 position 语义：
//   before_char / after_char  → 角色定义前/后（进 systemPrompt）
//   an_top / an_bottom        → 作者注释区（进 systemPrompt）
//   at_depth                  → 插进消息历史，depth 决定插在第几条之前
//   example_before/after      → 示例对话区（进 systemPrompt）
//   outlet                    → 不自动注入（由调用方决定）
//
// ⚠️ 宿主 SDK 契约里 messages **没有 system role**（system 走独立的
//    systemPrompt 参数）。所以 at_depth 不能新增 system 消息，
//    而是拼到目标位置那条消息的**前缀**里。

/** 会并入 systemPrompt 的锚点（顺序即拼接顺序）。 */
export const PROMPT_ANCHORS = [
  "before_char",
  "after_char",
  "an_top",
  "an_bottom",
  "example_before",
  "example_after",
  "unspecified"
];

/**
 * 把非 at_depth 的锚点条目拼成系统提示附加文本。
 *
 * @param {object} byAnchor - groupByAnchor 的结果
 * @param {(entries: object[]) => string} render - 渲染函数（默认 renderEntries）
 */
export function renderAnchoredLore(byAnchor, render) {
  if (!byAnchor) return "";
  const renderFn = render || ((list) => list.map(e => String(e.content ?? "")).filter(Boolean).join("\n\n"));

  const parts = [];
  for (const key of PROMPT_ANCHORS) {
    const list = byAnchor[key];
    if (!Array.isArray(list) || list.length === 0) continue;
    const text = renderFn(list);
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

/**
 * 把 at_depth 条目插进消息历史。
 *
 * @param {object[]} messages - 已裁剪的历史消息（会被浅拷贝，不改原数组）
 * @param {object} byAnchor
 * @param {number} [defaultDepth=4]
 * @returns {{ messages: object[], injected: Array<{id,name,anchor,at}> }}
 */
export function injectByAnchor(messages, byAnchor, defaultDepth = 4) {
  const list = Array.isArray(messages) ? messages : [];
  if (!byAnchor || !Array.isArray(byAnchor.at_depth) || byAnchor.at_depth.length === 0) {
    return { messages: list, injected: [] };
  }

  const out = list.map(m => ({ ...m }));
  const injected = [];

  const withDepth = byAnchor.at_depth.map(e => ({
    entry: e,
    depth: Math.max(1, Number(e.depth ?? e.extensions?._preserved_depth ?? defaultDepth) || defaultDepth)
  }));
  // depth 大的先处理（离末尾近），避免前一次插入影响后一次的位置
  withDepth.sort((a, b) => b.depth - a.depth);

  for (const { entry, depth } of withDepth) {
    const text = String(entry.content ?? "");
    if (!text) continue;

    if (out.length === 0) {
      injected.push({ id: entry.id, name: entry.name, anchor: "at_depth", at: -1, note: "无目标消息" });
      continue;
    }

    const idx = Math.max(0, out.length - depth);
    const target = out[idx];
    target.content = `${text}\n\n${target.content}`;
    target._lorePrefix = [...(target._lorePrefix || []), entry.name || entry.id];
    // 内容被前缀改写了。这里**不需要**手动清签名：读取端
    // （assistantContentFor）会比对 content 与 rawContent，
    // 不一致就自动回退纯文本。保留 rawContent 反而更好——
    // 将来若前缀被移除，签名又能用了。
    injected.push({ id: entry.id, name: entry.name, anchor: "at_depth", at: idx });
  }

  return { messages: out, injected };
}

/**
 * 一步到位：给定历史与锚点分组，返回最终消息序列。
 */
export function applyAnchorInjection(messages, byAnchor, opts = {}) {
  const { defaultDepth = 4 } = opts;
  return injectByAnchor(messages, byAnchor, defaultDepth);
}
