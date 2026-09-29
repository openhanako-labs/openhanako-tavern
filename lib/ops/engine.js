// lib/ops/engine.js — 操作与结算引擎（C2）
//
// 三件事：
//   1. parseOpsReport(text)   从模型正文里挑出 [结算 ...] 标记
//   2. settleOps(...)         把结算里的 delta / set 落到 variableRepo，
//                             并从 pending 里划掉对应的项
//   3. composePendingBlock(...)  把待执行项拼成系统提示词的一段
//
// 结算标记格式（写在正文里，被这条管线吃掉，不给玩家看）：
//   [结算 攻击 delta:hp=-20]
//   [结算 攻击 set:hp=50,mp=0]
//   [结算 攻击 delta:hp=-20 set:mp=0 失败:体力不足]
//
// 解析失败的策略（与 director 一致）：
//   · 单个标记解析不了 → 保留原文、加入 rejected 列表，不丢
//   · 变量不存在 / 减成负数 → 抛出来让 settleOps 上报（不吞）
//
// 红线（与 C1 同纪律）：
//   1. 变量账「从状态长出来」——settle 只调 variableRepo.updateVariables
//   2. 结算失败不吞错——返回 rejected + errors，让上层能看见

/** 结算标记正则：抓 [结算 <name><rest>] 一整条 */
const SETTLE_RE = /\[\s*结算\s*([^\s\]]+)((?:\s+[^\]]+)*)\s*\]/g;

/**
 * 解析模型正文里的结算标记。
 * 返回 { reports: [{name, deltas, sets, failed, failedReason}], text: 已摘除标记的正文 }
 */
export function parseOpsReport(text) {
  const t = String(text ?? "");
  const reports = [];
  const bad = [];
  let cleaned = t;

  SETTLE_RE.lastIndex = 0;
  let m;
  while ((m = SETTLE_RE.exec(t)) !== null) {
    const name = m[1].trim();
    const rest = (m[2] || "").trim();
    const deltas = {};
    const sets = {};
    let failed = false;
    let failedReason = null;

    // 分块解析：delta: / set: / 失败: 三种前缀
    for (const block of rest.split(/(?=(?:delta|set|失败)\s*:)/i)) {
      const b = block.trim();
      if (!b) continue;
      const match = b.match(/^(delta|set|失败)\s*:\s*(.*)$/i);
      if (!match) {
        bad.push(`无法解析：「${b}」`);
        continue;
      }
      const kind = match[1].toLowerCase();
      const body = match[2];
      if (kind === "失败") {
        failed = true;
        failedReason = body.trim() || null;
      } else if (kind === "set") {
        parsePairs(body, (k, v) => { sets[k] = v; }, bad);
      } else {
        // delta
        parsePairs(body, (k, v) => {
          const n = Number(v);
          if (Number.isFinite(n)) deltas[k] = n;
        }, bad);
      }
    }

    if (!name) {
      bad.push(`结算名空：「${m[0]}」`);
      continue;
    }
    reports.push({
      name,
      deltas,
      sets,
      failed,
      failedReason,
      raw: m[0]
    });
  }

  // 摘除已识别的标记（保留失败解析的原文，方便排查）
  for (const r of reports) {
    cleaned = cleaned.split(r.raw).join("");
  }

  return { reports, bad, text: cleaned.trim() };
}

/**
 * 解析形如 `hp=-20,mp=+10` 的键值对。
 * 允许 `=` 或 `:` 两种分隔符（模型常见两种写法）。
 * 坏行进入 bads。
 */
function parsePairs(body, onPair, bads) {
  const trimmed = String(body ?? "").trim();
  if (!trimmed) return;
  // 允许中英文逗号分隔
  const parts = trimmed.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  for (const p of parts) {
    const m = p.match(/^([^=:\s]+)\s*[=:\s]\s*(.+)$/);
    if (!m) {
      bads.push(`无法解析的键值：「${p}」`);
      continue;
    }
    onPair(m[1].trim(), m[2].trim());
  }
}

/**
 * 结算操作。
 * @param {object} opts
 * @param {object} opts.reports           parseOpsReport 的 reports
 * @param {object} opts.ops               opsRepo.listOps() 的结果
 * @param {string|null} opts.conversationId
 * @param {object} opts.conversationRepo  提供 updateVariables + removePendingByOp
 * @param {object} opts.varsBefore        结算前 conv.variables 快照
 * @returns {Promise<{applied: [], rejected: [], errors: []}>}
 */
export async function settleOps({ reports = [], ops = [], conversationId, conversationRepo, varsBefore = {} } = {}) {
  const applied = [];
  const rejected = [];
  const errors = [];
  if (!reports.length) return { applied, rejected, errors };

  const opsByName = new Map(ops.map(o => [o.name, o]));

  for (const r of reports) {
    const op = opsByName.get(r.name);
    if (!op) {
      rejected.push({ name: r.name, reason: `未知操作：「${r.name}」` });
      continue;
    }
    if (r.failed) {
      // 失败也记录并抹掉 pending——「一次结算一次」，
      // 不抹会让同一个失败项下一轮又进上下文。
      applied.push({ name: r.name, opId: op.id, failed: true, reason: r.failedReason || null });
      if (conversationId && conversationRepo?.removePendingByOp) {
        await conversationRepo.removePendingByOp(conversationId, op.id);
      }
      continue;
    }
    // 有 deltas 或 sets 才需要动变量
    if (!Object.keys(r.deltas).length && !Object.keys(r.sets).length) {
      rejected.push({ name: r.name, reason: `结算里既没有 delta 也没有 set：「${r.raw}」` });
      continue;
    }

    try {
      const patch = {};
      // deltas：按当前值加减；没变量就按 0 起
      for (const [k, v] of Object.entries(r.deltas)) {
        const cur = Number(varsBefore?.[k] ?? 0);
        const n = Number.isFinite(cur) ? cur : 0;
        patch[k] = String(n + v);
      }
      // sets：直接赋值
      for (const [k, v] of Object.entries(r.sets)) {
        patch[k] = String(v);
      }

      if (conversationId && conversationRepo?.updateVariables) {
        await conversationRepo.updateVariables(conversationId, patch);
      }
      // 结算了 → 从 pending 里划掉这一条
      if (conversationId && conversationRepo?.removePendingByOp) {
        await conversationRepo.removePendingByOp(conversationId, op.id);
      }
      applied.push({ name: r.name, opId: op.id, deltas: r.deltas, sets: r.sets });
    } catch (e) {
      errors.push({ name: r.name, reason: e?.message || String(e) });
    }
  }

  return { applied, rejected, errors };
}

/**
 * 拼待执行项系统提示词段。
 * @param {object[]} ops       操作定义列表
 * @param {object[]} pending   pending 列表（每项 {opId, note}）
 * @returns {{text:string, count:number} | {text:"", count:0}}
 */
export function composePendingBlock(ops = [], pending = []) {
  if (!pending.length) return { text: "", count: 0 };
  const opById = new Map(ops.map(o => [o.id, o]));
  const lines = pending.map((p, i) => {
    const op = opById.get(p.opId);
    if (!op) return null;
    const cost = op.costVar ? `，消耗 ${op.costVar}` : "";
    const note = p.note ? `，备注：${p.note}` : "";
    return `${i + 1}. ${op.name}（${op.summary || "（无简述）"}${cost}${note}）`;
  }).filter(Boolean);
  if (!lines.length) return { text: "", count: 0 };

  const text =
    "## 待执行项\n" +
    "玩家本轮勾选了以下待执行操作。请按顺序在正文里结算；" +
    "结算完在正文里写一条 `[结算 操作名 ...]` 标记（会被管线吃掉，不显示给玩家）。\n\n" +
    lines.join("\n") + "\n\n" +
    "结算标记语法：\n" +
    "- 增量：`[结算 操作名 delta:变量=数值,变量2=数值]`\n" +
    "- 直设：`[结算 操作名 set:变量=数值,变量2=数值]`\n" +
    "- 失败：`[结算 操作名 失败:原因]`（不改变量）";

  return { text, count: pending.length };
}
