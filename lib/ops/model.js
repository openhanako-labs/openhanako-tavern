// lib/ops/model.js — 操作与结算（C2）
//
// 两层结构：
//   ops      可执行操作清单——世界级（<dataDir>/ops.json），跨对话共享
//            字段：name / costVar / summary / tags / source / timestamps
//   pending  待执行项——对话级（conv.json.pending 字段），随正文推进
//            字段：opId / selectedAt / note
//
// 为什么 ops 是世界级：
//   一个世界里的「可执行操作」是共通的（攻击 / 施法 / 潜行……），
//   跨对话复用一份比每场复制一份合理——与设定库、黑板的 world 层同形。
//
// 为什么 pending 是对话级：
//   待执行项是「这一场还没做的事」，与对话同生命周期——
//   结算了就从列表里移除，对话删了它就没了。
//
// 与 lib/board/ 的差异：
//   · board 是「此刻的世界记录」，操作是「能做哪些事」
//   · 操作没有可见性 / 激活条件——它就是待办
//
// 与 lib/codex/ 的差异：
//   · codex 是世界 Wiki 累计，操作是「这一场能推哪些变量」
//   · 操作没有 notes 追加制——它会被「结算」，历史由变量账记录
//
// 两条红线（与 C1 同纪律）：
//   1. 变量账「从状态长出来」——settle 只调 variableRepo.updateVariables，不另开账
//   2. 结算失败不吞错——解析失败、变量不存在都抛出来，让上层能看见
//
// source 字段本期只写 "manual"——extract 是二期。

import crypto from "node:crypto";

export const OpSource = {
  MANUAL: "manual",
  EXTRACT: "extract",
  IMPORT: "import"
};

const SOURCES = new Set(Object.values(OpSource));

/** 新建一个操作。id 由外部生成，这里补默认字段。 */
export function createOp(overrides = {}) {
  return normalizeOp({
    id: crypto.randomUUID(),
    name: "",
    costVar: null,
    summary: "",
    tags: [],
    source: OpSource.MANUAL,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  });
}

export function normalizeOp(o) {
  if (!o || typeof o !== "object") return o;
  const out = { ...o };
  out.id = typeof out.id === "string" && out.id ? out.id : crypto.randomUUID();
  out.name = typeof out.name === "string" ? out.name.trim() : "";
  out.costVar = typeof out.costVar === "string" && out.costVar.trim() ? out.costVar.trim() : null;
  out.summary = typeof out.summary === "string" ? out.summary : "";
  out.tags = Array.isArray(out.tags) ? out.tags.map(t => String(t ?? "").trim()).filter(Boolean) : [];
  out.source = SOURCES.has(out.source) ? out.source : OpSource.MANUAL;
  out.createdAt = typeof out.createdAt === "string" ? out.createdAt : new Date().toISOString();
  out.updatedAt = typeof out.updatedAt === "string" ? out.updatedAt : new Date().toISOString();
  return out;
}

/** 新建一个待执行项。 */
export function createPending(overrides = {}) {
  return normalizePending({
    id: crypto.randomUUID(),
    opId: null,
    selectedAt: new Date().toISOString(),
    note: "",
    ...overrides
  });
}

export function normalizePending(p) {
  if (!p || typeof p !== "object") return p;
  const out = { ...p };
  out.id = typeof out.id === "string" && out.id ? out.id : crypto.randomUUID();
  out.opId = typeof out.opId === "string" && out.opId ? out.opId : null;
  out.selectedAt = typeof out.selectedAt === "string" ? out.selectedAt : new Date().toISOString();
  out.note = typeof out.note === "string" ? out.note : "";
  return out;
}

/** 按 name 升序（同 name 按 id 稳定）。 */
export function sortOps(list) {
  return [...(list || [])].sort((a, b) => {
    const r = String(a?.name || "").localeCompare(String(b?.name || ""));
    return r !== 0 ? r : String(a?.id || "").localeCompare(String(b?.id || ""));
  });
}

/** 按选中时间升序（先入队先结算）。 */
export function sortPending(list) {
  return [...(list || [])].sort((a, b) => {
    const r = String(a?.selectedAt || "").localeCompare(String(b?.selectedAt || ""));
    return r !== 0 ? r : String(a?.id || "").localeCompare(String(b?.id || ""));
  });
}
