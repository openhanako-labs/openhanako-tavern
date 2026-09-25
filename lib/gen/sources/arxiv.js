// lib/gen/sources/arxiv.js — arXiv
//
// 走官方 API（能取，返回 atom）。摘要是这里的正文来源——
// 论文全文对"造一个角色卡/世界书"没有意义，摘要里的问题、方法、结论才有。
//
// 注意只能取摘要级信息：arXiv 的条目本来就是"一篇论文"，
// 拿它来当世界设定时，要用的是它描述的**概念**，不是某位作者的个人信息。

import { parseAtom } from "../text.js";
import { makeGetter } from "../net.js";

const API = "https://export.arxiv.org/api/query";
const LABEL = "arXiv";

const MAX_CHARS = 4000;

/**
 * 按关键词检索。
 * @returns {Promise<{url: string, title: string, text: string}[]>}
 */
export async function search(q, { net, limit = 3 } = {}) {
  const get = makeGetter(net, LABEL);
  const n = Number.isFinite(limit) && limit > 0 ? limit : 3;
  const url = `${API}?search_query=all:${encodeURIComponent(q)}&max_results=${n}&sortBy=relevance`;
  const { text } = await get(url);
  return parseAtom(text)
    .slice(0, n)
    .map((it) => ({
      url: it.url,
      title: it.title,
      text: String(it.text || "").slice(0, MAX_CHARS)
    }));
}

/** 与 moegirl 同形：gather = 一次性拿到可喂模型的文档。 */
export async function gather(q, opts = {}) {
  return search(q, opts);
}

export const id = "arxiv";
export const label = LABEL;
export const tier = "official";

/** 体检：打一次最小查询，看能不能拿到 atom。 */
export async function probe(net) {
  const get = makeGetter(net, LABEL);
  const { status, text } = await get(`${API}?search_query=all:test&max_results=1`);
  return { ok: status === 200 && /<feed[\s>]/i.test(text), note: status === 200 ? "" : `HTTP ${status}` };
}
