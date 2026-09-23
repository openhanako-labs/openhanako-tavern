// lib/variables/repo.js — 变量仓储
//
// 变量定义存在单个 JSON 数组文件里。
// 对话级变量状态存在各自对话文件里（通过 ConversationRepo 读写，避免两处写同一文件）。

import crypto from "node:crypto";
import path from "node:path";
import { mutateJson, readJsonSafe } from "../atomic.js";
import { createVariableDefinition } from "./model.js";

export class VariableRepo {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.definitionsFile = path.join(dataDir, "variable-definitions.json");
    this.conversationsDir = path.join(dataDir, "conversations");
  }

  async init() {
    await mutateJson(this.definitionsFile, [], (current) => {
      return Array.isArray(current) ? current : [];
    });
    return this;
  }

  /** 获取所有变量定义。 */
  async listDefinitions() {
    const defs = await readJsonSafe(this.definitionsFile, []);
    return Array.isArray(defs) ? defs : [];
  }

  /** 按 id 或 name 获取定义。 */
  async getDefinition(idOrName) {
    const definitions = await this.listDefinitions();
    return definitions.find(d => d.id === idOrName || d.name === idOrName) || null;
  }

  /** 创建变量定义。 */
  async createDefinition(overrides = {}) {
    const def = createVariableDefinition(overrides);

    await mutateJson(this.definitionsFile, [], (current) => {
      const list = Array.isArray(current) ? current : [];
      if (list.some(d => d.name === def.name)) {
        throw new Error(`Variable name already exists: ${def.name}`);
      }
      list.push(def);
      return list;
    });

    return def;
  }

  /** 更新变量定义。 */
  async updateDefinition(idOrName, updates) {
    let result = null;
    await mutateJson(this.definitionsFile, [], (current) => {
      const list = Array.isArray(current) ? current : [];
      const idx = list.findIndex(d => d.id === idOrName || d.name === idOrName);
      if (idx === -1) throw new Error(`Variable not found: ${idOrName}`);

      list[idx] = {
        ...list[idx],
        ...updates,
        updatedAt: new Date().toISOString()
      };
      result = list[idx];
      return list;
    });
    return result;
  }

  /** 删除变量定义。 */
  async deleteDefinition(idOrName) {
    await mutateJson(this.definitionsFile, [], (current) => {
      const list = Array.isArray(current) ? current : [];
      return list.filter(d => d.id !== idOrName && d.name !== idOrName);
    });
    return true;
  }

  /** 原样恢复变量定义（用于迁移导入）。保留传入 id。 */
  async restoreDefinition(def) {
    if (!def || typeof def !== "object") {
      throw new Error("variable definition object is required");
    }

    const id = def.id || crypto.randomUUID();
    const restored = {
      ...createVariableDefinition(def),
      ...def,
      id,
      updatedAt: def.updatedAt || new Date().toISOString()
    };

    await mutateJson(this.definitionsFile, [], (current) => {
      const list = Array.isArray(current) ? current : [];
      const idx = list.findIndex(d => d.id === id);
      if (idx >= 0) list[idx] = restored;
      else list.push(restored);
      return list;
    });

    return restored;
  }

  /** 批量导入变量定义。 */
  async importDefinitions(defs) {
    if (!Array.isArray(defs)) throw new Error("defs must be an array");

    const added = [];
    const skipped = [];

    await mutateJson(this.definitionsFile, [], (current) => {
      const list = Array.isArray(current) ? current : [];
      const nameSet = new Set(list.map(d => d.name));

      for (const def of defs) {
        if (nameSet.has(def.name)) {
          skipped.push(def.name);
          continue;
        }
        const created = createVariableDefinition(def);
        list.push(created);
        nameSet.add(created.name);
        added.push(created);
      }
      return list;
    });

    return { added: added.length, skipped };
  }

  // ── 对话级变量状态 ──
  // 注意：这里直接操作对话文件。为避免与 ConversationRepo 的锁冲突，
  // 统一通过 atomic 的 withLock 走同一个锁键。

  #convFile(conversationId) {
    if (!conversationId || typeof conversationId !== "string") {
      throw new Error("Invalid conversation id");
    }
    if (conversationId.includes("..") || conversationId.includes("/") || conversationId.includes("\\")) {
      throw new Error("Invalid conversation id");
    }
    return path.join(this.conversationsDir, `${conversationId}.json`);
  }

  /** 获取对话变量状态。 */
  async getConversationVariables(conversationId) {
    const filePath = this.#convFile(conversationId);
    const conv = await readJsonSafe(filePath, null);
    return conv?.variables || {};
  }

  /** 更新单个对话变量。 */
  async setConversationVariable(conversationId, name, value) {
    return this.setConversationVariables(conversationId, { [name]: value });
  }

  /** 批量更新对话变量。 */
  async setConversationVariables(conversationId, variables) {
    const filePath = this.#convFile(conversationId);

    let result = null;
    await mutateJson(filePath, null, (conv) => {
      if (!conv) throw new Error(`Conversation not found: ${conversationId}`);
      conv.variables = { ...(conv.variables || {}), ...variables };
      conv.updatedAt = new Date().toISOString();
      result = conv.variables;
      return conv;
    });

    return result;
  }
}

export function createVariableRepo(dataDir) {
  return new VariableRepo(dataDir);
}
