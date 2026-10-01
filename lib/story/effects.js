// lib/story/effects.js — 剧情卡【效果】块结算：变量写入 + var-diff 账
//
// 红线（与 ops/engine.js 同一条纪律）：
//   变量账「从状态长出来」——这里只调 conversationRepo.updateVariables，
//   不另开账。var-diff 走 repo.setMessageVarDiff 挂到那条消息上，
//   气泡下方的 var-chip 自动出账（与 invu_update 同一个口径）。
//
// 与 ops 引擎的分工：
//   ops 引擎结算的是「模型主动声明的[结算 操作]标记」（有操作定义、有 pending）；
//   这里结算的是剧情卡协议里【效果】块的裸数值行——没有操作定义那一层，
//   就是 `体力 -10` 这种直接的变量变化。两条路汇到同一个 updateVariables。

import { parseStoryProtocol } from "./protocol.js";

/**
 * 把解析出的 effects[] 翻译成 { patch, diff }。
 *
 * @param {Array<{name:string, op:"+"|"-"|"=", value:string}>} effects
 * @param {object} varsBefore  结算前 conv.variables 快照
 * @returns {{patch: object, diff: Array}}
 */
export function effectsToPatch(effects = [], varsBefore = {}) {
  const patch = {};
  const diff = [];

  for (const e of effects) {
    const name = String(e?.name ?? "").trim();
    if (!name) continue;
    const op = e?.op;
    const rawVal = e?.value;

    if (op === "+" || op === "-") {
      const delta = Number(rawVal);
      if (!Number.isFinite(delta)) continue;
      const cur = Number(varsBefore?.[name] ?? 0);
      const base = Number.isFinite(cur) ? cur : 0;
      const next = op === "+" ? base + delta : base - delta;
      patch[name] = String(next);
      diff.push({
        name,
        change: "add",
        from: String(base),
        to: String(next),
        text: `${name} ${op === "+" ? "+" : "−"}${delta}`
      });
    } else if (op === "=") {
      patch[name] = String(rawVal);
      diff.push({
        name,
        change: "set",
        from: varsBefore?.[name] == null ? null : String(varsBefore[name]),
        to: String(rawVal),
        text: `${name} → ${rawVal}`
      });
    }
    // 未知 op：跳过（协议层已过滤，这里双保险）
  }

  return { patch, diff };
}

/**
 * 对一条 assistant 消息做剧情卡结算。
 *
 * 流程：解析 content → 有【效果】则写变量 + 挂 var-diff → 把解析结果挂到消息上。
 * 消息原文（content）一字不动——解析结果挂在 msg.story，渲染层消费。
 *
 * @param {object} opts
 * @param {object} opts.conv            当前对话（要带 id / variables）
 * @param {object} opts.message         刚落盘的 assistant 消息
 * @param {object} opts.conversationRepo  提供 updateVariables + setMessageVarDiff + editMessage
 * @returns {Promise<{settled:boolean, parsed:object, applied:Array, errors:Array}>}
 */
export async function settleStoryMessage({ conv, message, conversationRepo } = {}) {
  const errors = [];
  const empty = { settled: false, parsed: null, applied: [], errors };

  if (!message || message.role !== "assistant") return empty;
  const text = String(message.content ?? "");
  if (!text) return empty;

  const parsed = parseStoryProtocol(text);
  if (!parsed.found) return { ...empty, parsed };

  // 效果结算：写变量 + 记 var-diff
  const varsBefore = conv?.variables || {};
  const { patch, diff } = effectsToPatch(parsed.effects, varsBefore);
  const applied = [];

  if (Object.keys(patch).length > 0 && conv?.id && conversationRepo?.updateVariables) {
    try {
      await conversationRepo.updateVariables(conv.id, patch);
      applied.push(...diff.map(d => d.name));
    } catch (e) {
      errors.push({ stage: "updateVariables", reason: e?.message || String(e) });
    }
  }

  if (diff.length > 0 && conv?.id && conversationRepo?.setMessageVarDiff) {
    try {
      await conversationRepo.setMessageVarDiff(conv.id, message.id, diff);
    } catch (e) {
      errors.push({ stage: "setMessageVarDiff", reason: e?.message || String(e) });
    }
  }

  // 解析结果挂到消息上：渲染层读 msg.story 决定画剧情卡还是普通气泡。
  // 走 setMessageStory（字段级 patch），content 不动。
  if (conv?.id && conversationRepo?.setMessageStory) {
    try {
      await conversationRepo.setMessageStory(conv.id, message.id, parsed);
    } catch (e) {
      errors.push({ stage: "attachStory", reason: e?.message || String(e) });
    }
  }

  return { settled: applied.length > 0 || parsed.found, parsed, applied, errors };
}

export default { effectsToPatch, settleStoryMessage };
