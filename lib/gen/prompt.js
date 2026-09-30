// lib/gen/prompt.js — 三个模型调用的提示词 + 严格 JSON 解析
//
// 结构上的要点只有一个：**调用一看到原文，调用二只看到清单**。
// 那道墙是防幻觉用的——模型没有自由发挥的原料，写出来的每句话
// 都必须能在清单里找到。这不是省 token。
//
// 解析上的要点也只有一个：**严格，且不重试**。
// 解析失败说明这次输出不合形状，重试只会把同一类错再犯一遍、
// 还把用户的时间搭进去。要说清哪里不合法。
//
// 第三个调用（C1-2 二期）：图鉴抽取。
// 它也是“只见原文”那一类——只抽取，不创作。三件红线与 summary-llm 同源：
//   ① 只许从正文提取，不许新增正文没有的人物/地点/关系
//   ② 已收录的实体不要重复列
//   ③ 输出严格的 JSON（不包代码块）——解析失败就静默丢弃，不重试

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
  "世界书条目（character_book.entries）里，keys 是触发词、content 是条目正文、name 是条目名。",
  "每条都要给 name（取不到就用它的第一个触发词）——没名字的条目在设定库里会互相覆盖。",
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

// ── 调用三（C1-2 二期）：正文 → 图鉴候选实体 ────────────
//
// 三道红线（与 summary-llm 同根）：
//   ① 只许从正文提取——模型一旦“知道得多”，就会开始往正文里塞。
//      所以已收录名单也要递进去，让它知道哪些不要再列。
//   ② 严格 JSON（对象，不是数组），不包代码块——parseJsonStrict 能容下
//      围栏，但围栏本身就是一种“不严格”，宁可从源头禁掉。
//   ③ 只回三个顶层字段：persons / places / relations。多一个字段就当
//      模型想多写东西——静默丢弃。fields 里空串、undefined、null 一律
//      当“正文没说”，不拿“0”、“未知”去填——未知就是未知。

export const CODEX_EXTRACT_RULES = [
  "你是图鉴抽取器。只做抽取，不做任何创作。",
  "只许从给定的正文中提取人物 / 地点 / 关系；正文没提到的实体，一个字都不得写。",
  "不许推测、不许补充常识、不许往正文里添人添地添关系。",
  "已收录名单里的名字不要重复列（哪怕正文又提了一次）。",
  "人物：只列**正文里首次露面的新人物**（不是玩家、不是当前主角）。态度 / 状态只写正文里明确说到的；说不到就留空字符串，不要自己造。",
  "地点：只列**正文里首次露面的新地点**。描述 / 局势 / 倾向，正文没提到就留空字符串。",
  "关系：只列**正文里明确表述的、且两端在正文里都出现过名字的关系**（人物 / 地点 / 势力都可作端点）。关系里直接写**名字**（不是 id），后端会自己联表；两端名字任一端解析不到 → 后端会丢掉这条，所以宁可少写也不要编名字。",
  "方向：A→B（从 = A、到 = B）；正文未标明方向（只是提及两者有某种关系）时，direction 填 undirected。",
  "输出必须是严格的 JSON 对象，形如：",
  '{"persons":[{"name":"…","attitude":"…","status":"…","tags":["…"]}],"places":[{"name":"…","description":"…","situation":"…","tendency":"…"}],"relations":[{"from":"…","to":"…","kind":"…","direction":"directed","note":"…"}]}',
  "三个顶层数组一个都不能少（没东西就回空数组 []）。",
  "不要输出任何其他字段、不要包代码块、不要写解释。除了这个 JSON 对象以外，一个字都不要输出。"
].join("\n");

/**
 * 构造「图鉴抽取」那一次调用。
 *
 * @param {{text: string, existing?: {persons?: string[], places?: string[], relations?: string[]}, characterName?: string}} args
 * @returns {{systemPrompt: string, messages: object[]}}
 */
export function codexExtractPrompt({ text, existing, characterName }) {
  const ex = existing && typeof existing === "object" ? existing : {};
  const lines = [];
  if (characterName) lines.push(`当前主角（不要当作新人物）：${characterName}`);

  const exPersons = Array.isArray(ex.persons) ? ex.persons.filter(Boolean) : [];
  const exPlaces = Array.isArray(ex.places) ? ex.places.filter(Boolean) : [];
  const exRels = Array.isArray(ex.relations) ? ex.relations.filter(Boolean) : [];
  if (exPersons.length) lines.push(`已收录人物（不要重复）：${exPersons.join("、")}`);
  if (exPlaces.length) lines.push(`已收录地点（不要重复）：${exPlaces.join("、")}`);
  if (exRels.length) lines.push(`已收录关系（不要重复）：${exRels.join("；")}`);

  const ctx = lines.length ? lines.join("\n") : "（当前图鉴为空）";

  return {
    systemPrompt: CODEX_EXTRACT_RULES,
    messages: [{
      role: "user",
      content: `=== 当前图鉴 ===\n${ctx}\n\n=== 本轮正文 ===\n${String(text || "").trim()}`
    }]
  };
}

/**
 * 严格解析模型输出，只认三个人物 / 地点 / 关系三个顶层字段。
 *
 * 多一个字段就抛错——那是模型想要“额外发挥”的信号，宁可不认也不当事实收下。
 *
 * @param {string} raw
 * @returns {{persons: object[], places: object[], relations: object[]}}
 */
export function parseCodexExtract(raw) {
  const obj = parseJsonStrict(raw, { expect: "object", what: "图鉴抽取" });
  // 顶层只准出现三个字段
  const allowed = new Set(["persons", "places", "relations"]);
  for (const k of Object.keys(obj || {})) {
    if (!allowed.has(k)) throw new Error(`图鉴抽取出现未允许的字段：${k}`);
  }
  return {
    persons: Array.isArray(obj.persons) ? obj.persons : [],
    places: Array.isArray(obj.places) ? obj.places : [],
    relations: Array.isArray(obj.relations) ? obj.relations : []
  };
}
