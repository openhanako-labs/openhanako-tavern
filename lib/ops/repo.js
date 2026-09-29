// lib/ops/repo.js — 操作与结算仓储（C2）
//
// 两块盘：
//   ops     → <dataDir>/ops.json（跨对话共享）
//   pending → 各自对话文件里的 pending 字段（conv.json）
//
// 与 board/repo.js 同构：对话文件走 atomic 锁，同一路径即同一把锁。
// 读侧一律 normalize：老文件没有字段也能读，且不改写盘上文件。

import path from "node:path";
import { mutateJson, readJsonSafe } from "../atomic.js";
import {
  createOp, normalizeOp, sortOps,
  createPending, normalizePending, sortPending
} from "./model.js";

export class OpsRepo {
  constructor(dataDir) {
    if (!dataDir) throw new Error("OpsRepo 需要 dataDir");
    this.dataDir = dataDir;
    this.worldFile = path.join(dataDir, "ops.json");
    this.conversationsDir = path.join(dataDir, "conversations");
  }

  async init() {
    await mutateJson(this.worldFile, [], (cur) => (Array.isArray(cur) ? cur : []));
    return this;
  }

  #convFile(conversationId) {
    if (!conversationId || typeof conversationId !== "string") {
      throw new Error("Invalid conversation id");
    }
    if (conversationId.includes("..") || conversationId.includes("/") || conversationId.includes("\\")) {
      throw new Error("Invalid conversation id");
    }
    return path.join(this.conversationsDir, `${conversationId}.json`);
  }

  // ── ops：世界级 ──

  async listOps() {
    const raw = await readJsonSafe(this.worldFile, []);
    return sortOps((Array.isArray(raw) ? raw : []).map(normalizeOp));
  }

  async getOp(id) {
    if (!id) return null;
    return (await this.listOps()).find(o => o.id === id) || null;
  }

  async #upsertWorld(op) {
    await mutateJson(this.worldFile, [], (cur) => {
      const list = Array.isArray(cur) ? cur : [];
      const idx = list.findIndex(x => x.id === op.id);
      if (idx >= 0) list[idx] = op;
      else list.push(op);
      return list;
    });
    return op;
  }

  async #removeWorld(id) {
    await mutateJson(this.worldFile, [], (cur) => {
      const list = Array.isArray(cur) ? cur : [];
      return list.filter(x => x.id !== id);
    });
  }

  async createOp(input = {}) {
    const op = createOp(input);
    return this.#upsertWorld(op);
  }

  async updateOp(id, updates = {}) {
    if (!id) return null;
    const patch = { ...(updates || {}), updatedAt: new Date().toISOString() };
    const all = await this.listOps();
    const before = all.find(o => o.id === id);
    if (!before) return null;
    // 先合并再 normalize：单独归一 patch 会把缺字段补成默认值，
    // 再盖回原条目就会把 costVar / summary 全清空。
    const next = normalizeOp({ ...before, ...patch });
    return this.#upsertWorld(next);
  }

  async deleteOp(id) {
    if (!id) return false;
    const all = await this.listOps();
    if (!all.some(o => o.id === id)) return false;
    await this.#removeWorld(id);
    return true;
  }

  // ── pending：对话级 ──

  async listPending(conversationId) {
    if (!conversationId) return [];
    const conv = await readJsonSafe(this.#convFile(conversationId), null);
    const list = Array.isArray(conv?.pending) ? conv.pending : [];
    return sortPending(list.map(normalizePending));
  }

  async addPending(conversationId, input = {}) {
    if (!conversationId) throw new Error("pending 需要一个 conversationId");
    const p = createPending(input);
    await mutateJson(this.#convFile(conversationId), null, (conv) => {
      if (!conv) throw new Error(`Conversation not found: ${conversationId}`);
      const list = Array.isArray(conv.pending) ? conv.pending : [];
      list.push(p);
      conv.pending = list;
      conv.updatedAt = new Date().toISOString();
      return conv;
    });
    return p;
  }

  async removePending(conversationId, pendingId) {
    if (!conversationId || !pendingId) return false;
    let removed = false;
    await mutateJson(this.#convFile(conversationId), null, (conv) => {
      if (!conv) return conv;
      const list = Array.isArray(conv.pending) ? conv.pending : [];
      const next = list.filter(p => p.id !== pendingId);
      if (next.length !== list.length) {
        removed = true;
        conv.pending = next;
        conv.updatedAt = new Date().toISOString();
      }
      return conv;
    });
    return removed;
  }

  /** 清空待执行项（结算后调用）。返回被清掉的条数。 */
  async clearPending(conversationId) {
    if (!conversationId) return 0;
    let removed = 0;
    await mutateJson(this.#convFile(conversationId), null, (conv) => {
      if (!conv) return conv;
      const list = Array.isArray(conv.pending) ? conv.pending : [];
      if (list.length > 0) {
        removed = list.length;
        conv.pending = [];
        conv.updatedAt = new Date().toISOString();
      }
      return conv;
    });
    return removed;
  }

  /**
   * 按 opId 移除待执行项。
   * 用于「结算了某操作后从待执行里划掉」——
   * 一次正文里可能只结算其中几个，剩下的等下一轮。
   */
  async removePendingByOp(conversationId, opId) {
    if (!conversationId || !opId) return 0;
    let removed = 0;
    await mutateJson(this.#convFile(conversationId), null, (conv) => {
      if (!conv) return conv;
      const list = Array.isArray(conv.pending) ? conv.pending : [];
      const next = list.filter(p => p.opId !== opId);
      removed = list.length - next.length;
      if (removed > 0) {
        conv.pending = next;
        conv.updatedAt = new Date().toISOString();
      }
      return conv;
    });
    return removed;
  }
}

export function createOpsRepo(dataDir) {
  return new OpsRepo(dataDir);
}
