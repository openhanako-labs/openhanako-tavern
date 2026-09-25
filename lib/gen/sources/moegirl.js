// lib/gen/sources/moegirl.js — 萌娘百科
//
// 为什么走 HTML 而不是 API：它的 api.php 对匿名调用返回
// {"error":{"code":"action-notallowed","info":"Unauthorized API call"}}（2026-09-25 实测）。
// 搜索页与条目页都还能取，所以走「搜索页 → 条目链 → 条目页正文」。

import { htmlToText, parseSearchLinks } from "../text.js";
import { makeGetter } from "../net.js";

const ORIGIN = "https://zh.moegirl.org.cn";
const LABEL = "萌娘百科";

/** 正文里最大留多少字（喂模型之前还要再截，这里先挡一道） */
const MAX_CHARS = 6000;

/*
 * 站点提示模板。
 *
 * 萌娘的条目页开头永远挂着一堆维护性提示（"本条目的主题不是…"、
 * "欢迎参与完善本条目"…）。它们对"这个世界/这个角色是什么"零贡献，
 * 却占了正文最前面几百字——不清掉，模型看到的第一屏全是客套话。
 *
 * 清单刻意短且保守：宁可漏掉一句噪音，也不要误删正文。
 */
const BOILERPLATE = [
  /提示：本条目的主题不是[^。]*。/g,
  /萌娘百科欢迎您参与完善本条目[^。\s]*。?/g,
  /欢迎正在阅读这个条目的您协助编辑本条目。?/g,
  /编辑前请阅读[^。]*。/g,
  /并查找相关资料。?/g,
  /萌娘百科祝您?在本站度过愉快的时光。?/g,
  /此页面中存在需要长期更新的内容及资料列表[^。]*。/g,
  /另请编辑者注意：[^。]*。/g,
  /\[ ?短链接 ?\]/g,
  /\[ ?显示全部 ?\]/g
];

/** 去掉站点提示模板。导出是为了单测能单独钉它。 */
export function stripBoilerplate(text) {
  let s = String(text || "");
  for (const re of BOILERPLATE) s = s.replace(re, " ");
  return s.replace(/\s{2,}/g, " ").trim();
}

/**
 * 搜条目。
 * @returns {Promise<{url: string, title: string}[]>}
 */
export async function search(q, { net, limit = 8 } = {}) {
  const get = makeGetter(net, LABEL);
  const url = `${ORIGIN}/index.php?search=${encodeURIComponent(q)}&fulltext=1`;
  const { text } = await get(url);
  const links = parseSearchLinks(text);
  return Number.isFinite(limit) && limit > 0 ? links.slice(0, limit) : links;
}

/** 取条目页正文。 */
export async function fetchPage(url, { net } = {}) {
  const get = makeGetter(net, LABEL);
  const { text: html } = await get(url);
  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = stripBoilerplate(htmlToText(titleM ? titleM[1] : "", { max: 200 }))
    .replace(/\s*[-—|]\s*萌娘百科\s*$/, "")
    .trim();
  const text = stripBoilerplate(htmlToText(html, { max: MAX_CHARS }));
  return { url, title, text };
}

/**
 * 搜 + 抓前 N 条。
 *
 * 单条抓取失败**不拖垮其余**：一次搜索里有一条烂链很正常，
 * 为一个 404 把整次生成判死，用户只会看到"没搜到东西"。
 */
export async function gather(q, { net, limit = 3 } = {}) {
  const links = await search(q, { net });
  const picked = Number.isFinite(limit) && limit > 0 ? links.slice(0, limit) : links;
  const docs = [];
  for (const link of picked) {
    try {
      docs.push(await fetchPage(link.url, { net }));
    } catch {
      /* 单条失败就跳过，继续下一条 */
    }
  }
  return docs;
}

export const id = "moegirl";
export const label = LABEL;
export const tier = "community";

/**
 * 体检：只打一次站点根，看得到得到东西。
 * 不做复杂判据（不解析内容）——体检要回答的是“这条路今天通不通”，
 * 不是“页面内容对不对”。
 */
export async function probe(net) {
  const get = makeGetter(net, LABEL);
  const { status, text } = await get(`${ORIGIN}/`);
  return { ok: status === 200 && text.length > 500, note: status === 200 ? "" : `HTTP ${status}` };
}
