// status-block.js —— 正文顶部那段「状态栏」的切分
//
// 为什么单独一个文件：这是一段**纯函数**，没有 DOM、没有 state。
// 它留在 chat.js 里就只能靠源码字符串去测（因为 chat.js 一 import 就碰 document），
// 而判据有边界（几条、多少比例算键值），边界必须能真跑。
//
// 它治的病（2026-09-27 用户截图）：
// 模型按世界书里的变量格式输出一长串键值清单，开头就是它。App 原样当正文渲染，
// 于是整块状态数据铺在消息顶部压着叙述，最后一行 `**任务面板:** {}`
// 看上去像一句渲染坏掉的占位——其实那只是模型老实输出、恰好为空的一个字段。

/**
 * 把 assistant 正文开头的「状态栏」块切出来。
 *
 * 这里**不解析**它（解析成变量是另一件事），只做切分：块归块，正文归正文。
 * 展开还在，信息不丢。
 *
 * 判据三条**同时**成立才算（宁可漏切，不可误切）：
 *   1. 正文里有一处独立成行的分隔线（*** / --- / ___）
 *   2. 它前面非空行不少于 3 行
 *   3. 其中至少一半是「键: 值」形状
 *
 * 叙述段落几乎不会三条全占；真误判了，代价也只是正文前多一个可展开的条。
 *
 * @param {string} text
 * @returns {{status: string, body: string, items: number}} status 为空表示没切
 */
export function splitStatusBlock(text) {
  const src = String(text ?? "");
  const m = /^([\s\S]*?)\n[ \t]*(\*{3,}|_{3,}|-{3,})[ \t]*\n/.exec(src);
  if (!m) return { status: "", body: src, items: 0 };

  const head = m[1];
  // 分隔线自己那一个换行要吃掉：正文不该空一行开头
  const rest = src.slice(m[0].length).replace(/^\n+/, "");
  const lines = head.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return { status: "", body: src, items: 0 };

  const isKv = (l) => /^[ \t]*\*{0,2}[^:：*\s][^:：]{0,30}[:：][ \t]*\S/.test(l);
  const items = lines.filter(isKv).length;
  if (items < Math.max(3, Math.ceil(lines.length / 2))) return { status: "", body: src, items: 0 };

  return { status: head.trim(), body: rest, items };
}
