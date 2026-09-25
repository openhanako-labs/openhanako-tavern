// lib/gen/sources/index.js — 来源注册表与可用性体检
//
// 体检为什么是功能的一部分、而不是调试手段：
// 这台机上维基百科与 Fandom 连不通、灰机 403（2026-09-25 实测），
// 而"连不通"和"这个来源没有相关内容"在用户眼里长得一模一样。
// 先跑一次体检，把"这条路今天走不通"摆出来，用户才知道该换题材还是该走兜底。

import * as moegirl from "./moegirl.js";
import * as arxiv from "./arxiv.js";

/** 注册表。加新来源只在这里加一行 + 一个适配器。 */
export const SOURCES = [
  { id: moegirl.id, label: moegirl.label, tier: moegirl.tier, gather: moegirl.gather, probe: moegirl.probe },
  { id: arxiv.id, label: arxiv.label, tier: arxiv.tier, gather: arxiv.gather, probe: arxiv.probe }
];

export function getSource(id) {
  return SOURCES.find((s) => s.id === id) || null;
}

/**
 * 逐个源打一次最小请求。
 *
 * 单个源失败不影响其余——体检的意义就是"分别知道谁通谁不通"，
 * 一个失败就整体抛错的话，它就没用了。
 *
 * @returns {Promise<{id,label,tier,ok,ms,note}[]>}
 */
export async function checkAvailability(net) {
  const out = [];
  for (const src of SOURCES) {
    const t0 = Date.now();
    try {
      const r = await src.probe(net);
      out.push({
        id: src.id,
        label: src.label,
        tier: src.tier,
        ok: r.ok === true,
        ms: Date.now() - t0,
        note: r.note || ""
      });
    } catch (e) {
      out.push({
        id: src.id,
        label: src.label,
        tier: src.tier,
        ok: false,
        ms: Date.now() - t0,
        note: e?.message || String(e)
      });
    }
  }
  return out;
}
