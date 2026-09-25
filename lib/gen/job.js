// lib/gen/job.js — 生成任务：状态机 + 流水线
//
// 为什么用「提交 + 轮询」而不是一个长请求：
//   一次生成要检索几个页面、跑两次模型调用，几十秒起步。
//   长请求会把「还在跑」和「挂了」变成同一种表现（浏览器/宿主超时），
//   而用户最需要知道的恰恰是"现在卡在哪一步"。
//   提交+轮询不新增宿主能力（不用 app/tasks.manage），也不需要权限复核。
//
// 任务只存在内存里：进程重启就没了。生成任务本来就是一次性的——
// 落盘的是生成**结果**（用户审查之后写进卡库），不是任务本身。

import { SOURCES, getSource } from "./sources/index.js";
import { extractFacts } from "./extract.js";
import { compose } from "./compose.js";
import { verifyProvenance } from "./verify.js";

/** id → job */
const jobs = new Map();

/** 阶段顺序（前端按这个显示进度） */
export const PHASES = ["searching", "extracting", "composing", "verifying", "done", "failed"];

let seq = 0;

/** 建任务（不跑）。 */
export function createJob({ query, sources, docsPerSource = 3 } = {}) {
  const id = `gen-${Date.now().toString(36)}-${(++seq).toString(36)}`;
  const job = {
    id,
    query: String(query || "").trim(),
    state: "running",
    phase: "searching",
    detail: "准备检索",
    sources: Array.isArray(sources) && sources.length > 0 ? sources : SOURCES.map((s) => s.id),
    docsPerSource,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    notes: [],          // 每个来源的成败（检索阶段的可见出口）
    counts: { docs: 0, facts: 0, droppedFacts: 0, entries: 0, droppedSentences: 0 },
    result: null,
    error: null
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

/** 测试用：清空。 */
export function resetJobs() {
  jobs.clear();
  seq = 0;
}

function snapshot(job) {
  // 只给前端该看的东西：不吐原始模型回话（又长又可能带用户没审过的内容）
  return {
    id: job.id,
    query: job.query,
    state: job.state,
    phase: job.phase,
    detail: job.detail,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    notes: job.notes,
    counts: job.counts,
    error: job.error,
    result: job.result
  };
}

export { snapshot };

/**
 * 跑任务。**不要 await 它**（路由里 fire-and-forget），结果靠轮询拿。
 *
 * @param {string} id
 * @param {{net: object|null, llm: object|null}} deps
 */
export async function runJob(id, { net, llm } = {}) {
  const job = jobs.get(id);
  if (!job) return;

  try {
    // ── ① 检索 ──
    job.phase = "searching";
    const docs = [];
    for (const sid of job.sources) {
      const src = getSource(sid);
      if (!src) {
        job.notes.push({ source: sid, ok: false, note: "未知来源" });
        continue;
      }
      try {
        const got = await src.gather(job.query, { net, limit: job.docsPerSource });
        job.notes.push({ source: src.id, label: src.label, ok: true, count: got.length });
        docs.push(...got);
      } catch (e) {
        job.notes.push({ source: src.id, label: src.label, ok: false, note: e?.message || String(e) });
      }
    }
    job.counts.docs = docs.length;
    if (docs.length === 0) {
      const why = job.notes.map((n) => `${n.label || n.source}: ${n.note || "没取到"}`).join("；");
      throw new Error(`检索没取到任何材料（${why}）`);
    }

    // ── ② 抽取 ──
    job.phase = "extracting";
    job.detail = `从 ${docs.length} 份材料里抽取事实`;
    const ex = await extractFacts({ query: job.query, docs, llm });
    job.counts.facts = ex.facts.length;
    job.counts.droppedFacts = ex.dropped;
    if (ex.facts.length === 0) {
      throw new Error("抽取结果里没有任何带出处的事实（模型可能没按格式给，或材料里确实没有可用内容）");
    }
    job.detail = `抽到 ${ex.facts.length} 条事实`;

    // ── ③ 组装 ──
    job.phase = "composing";
    const cp = await compose({ query: job.query, facts: ex.facts, llm });
    job.counts.entries = cp.book.entries.length;

    // ── ④ 核对 ──
    job.phase = "verifying";
    const v = verifyProvenance({ card: cp.card, book: cp.book, facts: ex.facts });
    job.counts.entries = v.book.entries.length;
    job.counts.droppedSentences = v.dropped.length;

    job.result = {
      card: v.card,
      book: v.book,
      facts: ex.facts,
      materials: docs.map((d) => ({ url: d.url, title: d.title || "" })),
      dropped: {
        facts: ex.dropped,
        entries: cp.droppedEntries,
        sentences: v.dropped.length,
        samples: v.dropped.slice(0, 5)     // 留几句样例，报告里能看见"删了什么"
      }
    };
    job.phase = "done";
    job.state = "done";
    job.detail = "完成";
    job.finishedAt = new Date().toISOString();
  } catch (e) {
    job.state = "failed";
    job.phase = "failed";
    job.detail = e?.message || String(e);
    job.error = e?.message || String(e);
    job.finishedAt = new Date().toISOString();
  }
}
