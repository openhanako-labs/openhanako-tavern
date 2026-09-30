// lib/recall/tools.js — ReAct 循环用的两个工具
//
//   search(keywords)   走倒排索引，返回带分数的候选条目（截到 8000 字符）
//   read_entry(id)     读条目全文（同 id 只读一次，去重防重复读）
//
// 骨架跟 Sirchmunk 的 ToolRegistry 一致：每个工具都是
//   { description, parameters: { type, properties, required }, execute(args) }
// execute 的返回是 { text, ok, ...meta }——text 是给 LLM 看的观察。
//
// 为什么把工具做成对象而不是 class：
//   · 循环里只需要按名字查 + 执行，不需要继承
//   · 测试时可以直接构造工具表，不必起一个 registry 实例
//   · tools.js 与 loop.js 之间靠「工具表」这个纯数据结构对话，边界干净

/** 单个工具结果的字符上限（跟 Sirchmunk 的 8000 一致）。 */
export const TOOL_RESULT_CHAR_LIMIT = 8000;

function truncate(text, limit = TOOL_RESULT_CHAR_LIMIT) {
  const s = String(text ?? "");
  if (s.length <= limit) return s;
  return s.slice(0, limit) + "\n... [output truncated]";
}

/** 把候选条目渲染成给 LLM 看的观察文本。 */
function renderCandidates(results, maxChars = TOOL_RESULT_CHAR_LIMIT) {
  if (!results || results.length === 0) return "No results.";
  const parts = [];
  let used = 0;
  for (const r of results) {
    const body = String(r.body ?? "");
    // 只截取 body 的前 400 字符作预览，全文走 read_entry
    const preview = body.length > 400 ? body.slice(0, 400) + " …" : body;
    const block =
      `[${r.id}] kind=${r.kind} score=${r.score}\n`
      + (r.title ? `title: ${r.title}\n` : "")
      + (r.name && r.name !== r.title ? `name: ${r.name}\n` : "")
      + `preview: ${preview}`;
    if (used + block.length > maxChars) {
      parts.push(`... (${results.length - parts.length} more candidates omitted)`);
      break;
    }
    parts.push(block);
    used += block.length + 4;
  }
  return parts.join("\n\n---\n\n");
}

/** 把一个条目的完整内容渲染成观察文本。 */
function renderEntry(entry, id) {
  const body = String(entry?.body ?? "");
  const title = String(entry?.title ?? "");
  const name = String(entry?.name ?? "");
  return truncate(
    `[${id}]\n`
    + (title ? `title: ${title}\n` : "")
    + (name ? `name: ${name}\n` : "")
    + `body:\n${body}`
  );
}

/**
 * 建工具表。
 *
 * @param {{ index: InvertedIndex, ctx: RecallContext }} deps
 * @returns {{search: object, read_entry: object}}
 */
export function createRecallTools({ index, ctx }) {
  if (!index || typeof index.search !== "function") {
    throw new Error("recall.tools 需要一个可用的 InvertedIndex");
  }
  if (!ctx || typeof ctx.markEntryRead !== "function") {
    throw new Error("recall.tools 需要一个可用的 RecallContext");
  }

  return {
    search: {
      description:
        "在角色卡 / 世界书 / 对话历史中按关键词检索，返回带分数的候选条目（预览）。",
      parameters: {
        type: "object",
        properties: {
          keywords: {
            type: "array",
            items: { type: "string" },
            description: "关键词数组；中英文都行，别重复用同一批词。"
          }
        },
        required: ["keywords"]
      },
      async execute(args = {}) {
        const rawKw = args.keywords;
        let keywords;
        if (Array.isArray(rawKw)) {
          keywords = rawKw.map(k => String(k)).filter(Boolean);
        } else if (typeof rawKw === "string" && rawKw.trim()) {
          keywords = [rawKw];
        } else {
          ctx.addLog("search", 0, { error: "no keywords" });
          return { text: "keywords 必须是数组（至少一个非空字符串）。", ok: false };
        }
        if (keywords.length === 0) {
          ctx.addLog("search", 0, { error: "empty keywords" });
          return { text: "keywords 不能为空数组。", ok: false };
        }
        ctx.addSearch(keywords.join(" | "));
        const results = index.search(keywords, { topK: 8 });
        const text = renderCandidates(results);
        ctx.addLog("search", 0, { keywords, hits: results.length });
        return { text, ok: true, hits: results.length };
      }
    },

    read_entry: {
      description:
        "读取某个条目的完整内容。id 用 search 返回的 id（char:xxx / lore:xxx / conv:xxx）。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "条目的 id" }
        },
        required: ["id"]
      },
      async execute(args = {}) {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        if (!id) {
          ctx.addLog("read_entry", 0, { error: "no id" });
          return { text: "id 必填。", ok: false };
        }
        if (ctx.isEntryRead(id)) {
          ctx.addLog("read_entry", 0, { id, dedup: true });
          return { text: `(已经读过 ${id}，不需要重复读)`, ok: false, dedup: true };
        }
        const entry = index.entries.get(id);
        if (!entry) {
          ctx.addLog("read_entry", 0, { id, error: "not found" });
          return { text: `找不到该条目：${id}`, ok: false };
        }
        ctx.markEntryRead(id);
        const text = renderEntry(entry, id);
        ctx.addLog("read_entry", 0, { id, chars: text.length });
        return { text, ok: true };
      }
    }
  };
}

export default createRecallTools;
