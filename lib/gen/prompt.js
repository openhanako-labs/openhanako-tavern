// lib/gen/prompt.js — 两个模型调用的提示词 + 严格 JSON 解析
//
// 结构上的要点只有一个：**调用一看到原文，调用二只看到清单**。
// 那道墙是防幻觉用的——模型没有自由发挥的原料，写出来的每句话
// 都必须能在清单里找到。这不是省 token。
//
// 解析上的要点也只有一个：**严格，且不重试**。
// 解析失败说明这次输出不合形状，重试只会把同一类错再犯一遍、
// 还把用户的时间搭进去。要说清哪里不合法。

/** 抽取阶段的规则（单列出来是为了能被单测直接钉住） */
export const EXTRACT_RULES = [
  "你只做抽取，不做任何创作。",
  "只许把材料里已写明的内容压缩成要点；不许新增、不许推测、不许补充常识。",
  "每一条要点都必须挂一个出处（source.url / source.title / source.tier）。",
  "挂不上出处的要点必须丢弃，不要为了凑数写进去。",
  "材料之间互相矛盾时，两条都记下来，不要自行裁定谁对。",
  "输出必须是严格的 JSON 数组，形如：",
  '[{"fact":"…","source":{"url":"…","title":"…","tier":"community"}}]',
  "除了这个 JSON 数组，不要输出任何别的东西。"
].join("\n");

/** 组装阶段的字段白名单：只用这些，别碰原酒馆的其他内部字段。 */
export const CARD_FIELDS = [
  "name", "description", "personality", "scenario",
  "first_mes", "mes_example", "creator_notes", "tags"
];

/** 组装阶段的规则 */
export const COMPOSE_RULES = [
  "你会收到一份**事实清单**，清单里的每一条都带出处。",
  "只许使用清单里的事实。清单没有的设定，一个字都不要写。",
  "开场白（first_mes）要写成角色在场景里说的第一句话，可以有动作描写，但不要写成旁白。",
  "世界书条目（character_book.entries）里，keys 是触发词、content 是条目正文。",
  "宁可写得朴素，也不要为了好看而编。",
  "输出必须是严格的 JSON 对象：",
  '{"card":{…},"book":{"entries":[{"keys":["…"],"content":"…","position":"before_char"}]}}',
  `card 里只许出现这些字段：${CARD_FIELDS.join(" / ")}。`,
  "除了这个 JSON 对象，不要输出任何别的东西。"
].join("\n");

/**
 * 调用一：原文 → 事实清单。
 *
 * 返回形状跟仓库里已有的模型调用一致：`{systemPrompt, messages}` ——
 * LLMService.generate(messages, {systemPrompt}) 就是这么收的。
 * @param {{query: string, docs: {url,title,text}[]}} args
 */
export function extractPrompt({ query, docs }) {
  const list = Array.isArray(docs) ? docs : [];
  const material = list
    .map((d, i) => [
      `【材料 ${i + 1}】${d.title || "（无标题）"}`,
      `出处：${d.url}`,
      `正文：${String(d.text || "").trim()}`
    ].join("\n"))
    .join("\n\n");

  return {
    systemPrompt: EXTRACT_RULES,
    messages: [{ role: "user", content: `需求：${query}\n\n=== 检索到的材料 ===\n${material}` }]
  };
}

/**
 * 调用二：事实清单 → 卡 + 世界书。
 *
 * 注意这里**收不到 docs**：调用方就算手里有原文，也不许递进来。
 * 接口形状本身就是那道墙——想犯规得先改函数签名，那就得有人看见。
 */
export function composePrompt({ query, facts }) {
  const list = Array.isArray(facts) ? facts : [];
  const material = list
    .map((f, i) => `[${i + 1}] ${f.fact}\n    出处：${f.source?.url || "（无）"}｜${f.source?.tier || "未知"}`)
    .join("\n");

  return {
    systemPrompt: COMPOSE_RULES,
    messages: [
      {
        role: "user",
        content: `需求：${query}\n\n=== 事实清单（只有这些可用）===\n${material || "（空）"}`
      }
    ]
  };
}

function typeName(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "数组";
  return typeof v === "object" ? "对象" : typeof v;
}

/** 从解析错误里抠出字符位置，附一段上下文，让人一眼看到坏在哪。 */
function locate(text, err) {
  const m = /position\s+(\d+)/i.exec(err?.message || "");
  if (!m) return err?.message || "无法解析";
  const pos = Number(m[1]);
  const from = Math.max(0, pos - 40);
  const snippet = text.slice(from, pos + 20).replace(/\s+/g, " ");
  return `${err.message}；附近：…${snippet}…`;
}

/**
 * 严格解析模型输出。
 *
 * 容忍三种常见包装（围栏、前后废话），但不容忍形状错误。
 * @param {string} text
 * @param {{expect?: "object"|"array", what?: string}} [opts]
 */
export function parseJsonStrict(text, { expect, what = "模型输出" } = {}) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) throw new Error(`${what}是空的`);

  const candidates = [raw];

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence && fence[1].trim()) candidates.push(fence[1].trim());

  const firstBrace = raw.search(/[[{]/);
  const lastClose = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
  if (firstBrace >= 0 && lastClose > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastClose + 1));
  }

  let parsed;
  let syntaxErr = null;
  let used = raw;
  for (const c of candidates) {
    try {
      parsed = JSON.parse(c);
      syntaxErr = null;
      used = c;
      break;
    } catch (e) {
      syntaxErr = e;
    }
  }
  if (syntaxErr) throw new Error(`${what}不是合法 JSON：${locate(used, syntaxErr)}`);

  if (expect === "array" && !Array.isArray(parsed)) {
    throw new Error(`${what}该是数组，实际是${typeName(parsed)}`);
  }
  if (expect === "object" && (Array.isArray(parsed) || parsed === null || typeof parsed !== "object")) {
    throw new Error(`${what}该是对象，实际是${typeName(parsed)}`);
  }
  return parsed;
}
