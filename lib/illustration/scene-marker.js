// lib/illustration/scene-marker.js — 从回复正文里抽取 [场景] 标记
//
// 规格：docs/spec-scene-illustration.md
//
// 契约（不改）：
//   输入：一段模型回复正文（可能带宏、可能多行、可能没标记）
//   输出：{ text, marker, prompt, extras, hasMarker }
//     text      —— 剥离了所有标记块的正文（模型没写标记时 text === 原文）
//     marker    —— 命中的整块标记（不含 [场景] 两字，只留描述）；无则 null
//     prompt    —— 描述去空格后的原样（含 {{char}} 宏，不展开）；无则 null
//     extras    —— 被丢弃的额外标记数量（模型一次写多块的场景）
//     hasMarker —— 布尔：是否识别到有效的 [场景] 块
//
// 为什么是纯函数：
//   标记解析是 UI 面、服务端面、测试面共同要用的规则，写死在这里比
//   散落在多个模块里好维护。纯函数也意味着可以在任何地方跑（不依赖 SDK、
//   不依赖 DOM），测试里不需要 mock 环境。

/** 单个 [场景] 块的长度上限（不含 [场景] 三字）。超过视为模型写崩了。 */
const MAX_LEN = 200;
const HEAD = "[场景]";

function isValidDesc(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  return t.length > 0 && t.length <= MAX_LEN;
}

/**
 * 从回复正文里抽取场景标记。
 *
 * @param {string} text  模型回复正文
 * @returns {{
 *   text: string, marker: string|null, prompt: string|null,
 *   extras: number, hasMarker: boolean
 * }}
 *
 * 主用例（对应计划 2.2）：
 *   ① 无标记        → hasMarker=false，text 原样返回
 *   ② 多标记        → 取第一块作 prompt，extras = 其余数量；
 *                     text 里把所有标记块都剔掉，避免用户看到的正文里
 *                     还残留一个 [场景]（那看起来像模型自己写崩了）
 *   ③ 标记里带换行  → 只取紧邻 [场景] 的同一行文本
 *   ④ 标记里有 {{char}} 宏 → 原样存进 prompt，不展开
 *
 * 判据（spec §1）：
 *   · 全角 `[场景]` 是硬要求，`[Scene]` 视为无标记
 *   · 只认**紧邻** [场景] 的同一行文本；跨行的部分不属于这块
 *   · 描述空 or 超长 → 无标记（此时不剔，保留原文）
 *   · 位置不强制在末尾：写在中间的也算，只是"最末"是模型的自然落笔位置
 */
export function extractSceneMarker(text) {
  const raw = typeof text === "string" ? text : "";

  // 列出所有 [场景] 位置。全角方括号是硬约束，英文括号不匹配。
  const hits = [];
  let from = 0;
  while (true) {
    const i = raw.indexOf(HEAD, from);
    if (i === -1) break;
    hits.push(i);
    from = i + HEAD.length;
  }

  if (hits.length === 0) {
    return { text: raw, marker: null, prompt: null, extras: 0, hasMarker: false };
  }

  // 主块 = 第一块。后面每块的行数只数，不作 prompt。
  const first = hits[0];
  const headEnd = first + HEAD.length;
  const after = raw.slice(headEnd);
  const nl = after.indexOf("\n");
  const line = nl >= 0 ? after.slice(0, nl) : after;
  const prompt = line.trim();

  const extras = hits.length - 1;

  // 描述不合格（空 / 超长）→ 无标记；此时原文不动，把 extras 交回去给诊断用
  if (!isValidDesc(prompt)) {
    return { text: raw, marker: null, prompt: null, extras, hasMarker: false };
  }

  // 剔掉所有块：主块和 extras 都从 text 里拿掉
  const stripped = stripAllBlocks(raw, hits);

  return {
    text: stripped,
    marker: prompt,
    prompt,
    extras,
    hasMarker: true
  };
}

/**
 * 从原文里剔掉每个标记块（[场景] + 紧邻那一行）。
 * 剔完后把三行及以上的空行压成两行，末尾空白剪掉。
 *
 * 倒序处理，避免前面剔除影响后面的 offset。
 */
function stripAllBlocks(raw, hits) {
  const cuts = hits.map((i) => {
    const headEnd = i + HEAD.length;
    const after = raw.slice(headEnd);
    const nl = after.indexOf("\n");
    const lineEnd = nl >= 0 ? headEnd + nl : raw.length;
    return { start: i, end: lineEnd };
  });
  let out = raw;
  for (let k = cuts.length - 1; k >= 0; k--) {
    const { start, end } = cuts[k];
    out = out.slice(0, start) + out.slice(end);
  }
  return out.replace(/\n{3,}/g, "\n\n").trimEnd();
}

/** 判据辅助：一段文本是不是合格的描述（1–200 字，非纯空白）。 */
export function isValidDescription(s) {
  return isValidDesc(s);
}

/**
 * 给模型的那句指令（只在 `scene.mode === "marker"` 时注入）。
 *
 * 为何从 HEAD 拼出来、而不在别处抄一遍字面量：
 * 这句话里出现的标记必须和解析器**逐字一致**。括号写错一个码点，
 * 模型照着写出来的就永远认不出来——而且**不报错**，看起来只是“模型没配合”。
 * （spec §1 写的是「全角方括号是硬要求」，而这里 HEAD 是**半角**——
 *   文档与代码对不上，照文档写就会写出一个永不生效的指令。）
 *
 * 语气刻意压平：不用“你必须”，也不多举例子——
 * 它只是**建议**（spec §4），拿它保证覆盖是错的，靠强语气只会让它滥写、白烧 token。
 *
 * @returns {string} 一行中文，约 80 字
 */
export function sceneMarkerInstruction() {
  return `配图约定：若当前这一幕值得配一张图，在回复末尾另起一行写 ${HEAD}`
    + ` 并紧跟一句画面描述（同一行内，1–${MAX_LEN} 字）。`
    + "不需要配图就什么都不要写，也不必解释这条约定。";
}

export const SCENE_MARKER_MAX_LEN = MAX_LEN;
export const SCENE_MARKER_HEAD = HEAD;
