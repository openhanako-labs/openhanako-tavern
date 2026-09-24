// lib/board/repo.js — 黑板仓储
//
// 两个盘，按「寿命」分：
//   world 级 → dataDir/board-cells.json（跨对话）
//   chat  级 → 各自对话文件里的 boardCells 字段（只在这一场）
//
// 对话文件由 ConversationRepo 持有。这里跟变量仓储一样，直接对同一个文件
// 走 atomic 的锁——同一路径即同一把锁，两边不会互相踩。
//
// 读侧一律 normalize：老文件没有这些字段也能读，且不改写盘上文件（不做迁移）。

import path from "node:path";
import { mutateJson, readJsonSafe } from "../atomic.js";
import {
  createBoardCell,
  normalizeBoardCell,
  sortBoardCells,
  BoardLifespan
} from "./model.js";

export class BoardRepo {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.worldFile = path.join(dataDir, "board-cells.json");
    this.conversationsDir = path.join(dataDir, "conversations");
  }

  async init() {
    await mutateJson(this.worldFile, [], (current) => (Array.isArray(current) ? current : []));
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

  // ── 读 ──

  /** 世界级（跨对话）的格子。 */
  async listWorldCells() {
    const raw = await readJsonSafe(this.worldFile, []);
    const list = Array.isArray(raw) ? raw : [];
    return sortBoardCells(list.map(normalizeBoardCell));
  }

  /** 某场对话的格子。对话不存在时返回空数组，不抛。 */
  async listChatCells(conversationId) {
    if (!conversationId) return [];
    const conv = await readJsonSafe(this.#convFile(conversationId), null);
    const list = Array.isArray(conv?.boardCells) ? conv.boardCells : [];
    return sortBoardCells(list.map(normalizeBoardCell));
  }

  /** 合并两块盘：世界级在前，对话级在后。 */
  async listCells(conversationId = null) {
    const world = await this.listWorldCells();
    const chat = await this.listChatCells(conversationId);
    return [...world, ...chat];
  }

  /** 按 id 找一格（先世界级，再对话级）。 */
  async getCell(id, conversationId = null) {
    if (!id) return null;
    const world = await this.listWorldCells();
    const hit = world.find(c => c.id === id);
    if (hit) return hit;
    const chat = await this.listChatCells(conversationId);
    return chat.find(c => c.id === id) || null;
  }

  // ── 写 ──

  async #upsertWorld(cell) {
    await mutateJson(this.worldFile, [], (current) => {
      const list = Array.isArray(current) ? current : [];
      const idx = list.findIndex(c => c.id === cell.id);
      if (idx >= 0) list[idx] = cell;
      else list.push(cell);
      return list;
    });
    return cell;
  }

  async #removeWorld(id) {
    await mutateJson(this.worldFile, [], (current) => {
      const list = Array.isArray(current) ? current : [];
      return list.filter(c => c.id !== id);
    });
  }

  async #upsertChat(conversationId, cell) {
    const filePath = this.#convFile(conversationId);
    await mutateJson(filePath, null, (conv) => {
      if (!conv) throw new Error(`Conversation not found: ${conversationId}`);
      const list = Array.isArray(conv.boardCells) ? conv.boardCells : [];
      const idx = list.findIndex(c => c.id === cell.id);
      if (idx >= 0) list[idx] = cell;
      else list.push(cell);
      conv.boardCells = list;
      conv.updatedAt = new Date().toISOString();
      return conv;
    });
    return cell;
  }

  async #removeChat(conversationId, id) {
    const filePath = this.#convFile(conversationId);
    await mutateJson(filePath, null, (conv) => {
      if (!conv) return conv;
      const list = Array.isArray(conv.boardCells) ? conv.boardCells : [];
      conv.boardCells = list.filter(c => c.id !== id);
      return conv;
    });
  }

  /**
   * 新建一格。寿命决定它落哪块盘——chat 级必须给 conversationId。
   */
  async createCell(input = {}, conversationId = null) {
    const cell = createBoardCell(input);
    if (cell.lifespan === BoardLifespan.WORLD) return this.#upsertWorld(cell);
    if (!conversationId) {
      throw new Error("对话级黑板格需要一个 conversationId（或者把 lifespan 设成 world）");
    }
    return this.#upsertChat(conversationId, cell);
  }

  /**
   * 更新一格。寿命从 world 改成 chat（或反过来）时会搬家——
   * 不搬家的话，改了寿命的格子会留在旧盘上，读出来寿命跟位置对不上。
   */
  async updateCell(id, updates = {}, conversationId = null) {
    // 注意：不能先把局部更新单独 normalize——缺字段会被补成 public，
    // 再盖到原格上，改一下标题就把私密格变成公开了。
    // 必须先把原格和补丁合并，再整体归一。
    const patch = { ...(updates || {}), updatedAt: new Date().toISOString() };

    const world = await this.listWorldCells();
    const beforeWorld = world.find(c => c.id === id);
    if (beforeWorld) {
      const next = normalizeBoardCell({ ...beforeWorld, ...patch });
      if (next.lifespan === BoardLifespan.CHAT) {
        if (!conversationId) throw new Error("把寿命改成对话级需要一个 conversationId");
        await this.#removeWorld(id);
        return this.#upsertChat(conversationId, next);
      }
      return this.#upsertWorld(next);
    }

    const chat = await this.listChatCells(conversationId);
    const beforeChat = chat.find(c => c.id === id);
    if (!beforeChat) return null;

    const nextChat = normalizeBoardCell({ ...beforeChat, ...patch });
    if (nextChat.lifespan === BoardLifespan.WORLD) {
      await this.#removeChat(conversationId, id);
      return this.#upsertWorld(nextChat);
    }
    return this.#upsertChat(conversationId, nextChat);
  }

  /** 开关一格。返回更新后的格子；找不到返回 null。 */
  async toggleCell(id, enabled = null, conversationId = null) {
    const cell = await this.getCell(id, conversationId);
    if (!cell) return null;
    const next = enabled === null || enabled === undefined ? !cell.enabled : !!enabled;
    return this.updateCell(id, { enabled: next }, conversationId);
  }

  /** 删除一格。返回是否真的删掉了。 */
  async deleteCell(id, conversationId = null) {
    const world = await this.listWorldCells();
    if (world.some(c => c.id === id)) {
      await this.#removeWorld(id);
      return true;
    }
    const chat = await this.listChatCells(conversationId);
    if (chat.some(c => c.id === id)) {
      await this.#removeChat(conversationId, id);
      return true;
    }
    return false;
  }
}

export function createBoardRepo(dataDir) {
  return new BoardRepo(dataDir);
}
