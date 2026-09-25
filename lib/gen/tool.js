// lib/gen/tool.js — 给 Agent 用的生成工具（兜底那条路）
//
// 为什么需要兜底：白名单里只有萌娘百科与 arXiv 两个源（维基与 Fandom
// 在这台机上连不通、灰机 403，都是实测）。历史、地理、真实人物这类题材
// 白名单装不下——但**我（Agent）手里有全网检索能力**。
// 所以这条路是：我先查，把材料递进来，App 只负责抽取 → 组装 → 核对。
//
// 接口刻意收 material 而不是收关键词：
//   收关键词就等于让 App 去猜"该查什么"，而它没有那个能力（也没那个白名单）；
//   收材料则责任清楚——查到什么、从哪查的，都是递材料的人负责。
//
// 返回值带 counts 与 dropped：让“删了多少越界内容”这件事在我这边也看得见。
//
// 名字说明：叫 tavern_compose_card（原先 tavern_draft_card）。那次改名是基于一个错误诊断。
// 真病因见 lib/media/tool.js 开头：`execute`/`parameters` 两个键名都写错了——
// 前者让工具“能列出、调不动”，后者让参数对模型不可见。

import { extractFacts } from "./extract.js";
import { compose } from "./compose.js";
import { verifyProvenance } from "./verify.js";

function text(s) {
  return { content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] };
}

function guard(fn) {
  return async (args) => {
    try {
      return text(await fn(args || {}));
    } catch (e) {
      return text(`Error: ${e?.message || String(e)}`);
    }
  };
}

const MATERIAL_SCHEMA = {
  type: "array",
  description: "已检索好的材料。每条要有 url（出处，必需）与 text（正文）",
  items: {
    type: "object",
    properties: {
      url: { type: "string", description: "来源地址，必需——没出处的材料会被丢弃" },
      title: { type: "string" },
      text: { type: "string", description: "正文（可截断）" },
      tier: { type: "string", description: "encyclopedia | official | community" }
    },
    required: ["url", "text"]
  }
};

/**
 * @param {{llm: object|null}} deps
 */
export function createGenTools({ llm } = {}) {
  return [
    {
      name: "tavern_compose_card",
      description: [
        "把**已经检索好的材料**变成一张原酒馆格式的角色卡（可选带世界书）。",
        "适合白名单来源覆盖不到的题材：先在宿主侧检索（web_search / web_fetch），",
        "把材料连同出处一起递进来，这里只做抽取、组装与出处核对。",
        "两条纪律：材料里挂不上出处的会被丢弃；生成结果里在材料内找不到依据的断言会被删掉并计数。"
      ].join(""),
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "要一个什么样的角色（一句话）" },
          material: MATERIAL_SCHEMA,
          makeBook: { type: "boolean", description: "是否生成世界书条目（默认 true）" }
        },
        required: ["query", "material"]
      },
      execute: guard(async (args) => {
        if (!llm || typeof llm.generate !== "function") throw new Error("模型服务未就绪");

        const docs = (Array.isArray(args.material) ? args.material : [])
          .map((m) => ({
            url: String(m?.url || "").trim(),
            title: String(m?.title || "").trim(),
            text: String(m?.text || "").trim(),
            tier: m?.tier
          }))
          .filter((d) => d.url && d.text);

        if (docs.length === 0) throw new Error("材料为空：每条至少要有 url 与 text");

        const ex = await extractFacts({ query: args.query, docs, llm });
        if (ex.facts.length === 0) throw new Error("抽取后没有任何带出处的事实——检查材料里是否真的写明了内容");

        const cp = await compose({ query: args.query, facts: ex.facts, llm });
        const v = verifyProvenance({ card: cp.card, book: cp.book, facts: ex.facts });

        return {
          card: v.card,
          book: args.makeBook === false ? { entries: [] } : v.book,
          counts: {
            materials: docs.length,
            facts: ex.facts.length,
            droppedFacts: ex.dropped,
            entries: v.book.entries.length,
            droppedSentences: v.dropped.length
          },
          droppedSamples: v.dropped.slice(0, 5),
          note: "这份草稿**没有落库**。要入库请调到角色卡接口，或在生成台里审一遍再存。"
        };
      })
    }
  ];
}
