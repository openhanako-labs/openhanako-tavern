// lib/characters/repo.js — 角色卡仓储
//
// 布局：dataDir/characters/<id>/card.json + index.json
// 基于 IndexedStore：索引常驻内存、写操作原子化。
// 注意：角色卡是"目录 + card.json"结构（目录里还有 avatar.png），
//       所以 recordPath 覆写为目录形式，写操作自己处理路径。

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { IndexedStore } from "../store.js";
import { ensureDir, readJsonSafe, writeJsonAtomic, withLock } from "../atomic.js";
import { createEmptyCharacter, validateCharacter, getCharacterSummary } from "./model.js";

export class CharacterRepo extends IndexedStore {
  constructor(dataDir) {
    super(dataDir, "characters");
    this.dataDir = dataDir;
    this.charactersDir = this.dir; // 兼容旧字段名
  }

  /** 角色卡是目录结构，覆写记录路径。 */
  cardPath(id) {
    return path.join(this.charactersDir, id, "card.json");
  }

  /** 头像目录（供 transfer 使用）。 */
  characterDir(id) {
    return path.join(this.charactersDir, id);
  }

  // ── 读 ──

  /** 列出所有角色卡摘要。 */
  async list() {
    const index = await this.load();
    return index.map(c => ({
      id: c.id,
      name: c.name,
      created_at: c.created_at,
      updated_at: c.updated_at
    }));
  }

  /** 获取角色卡详情。 */
  async get(id) {
    IndexedStore.assertSafeId(id, "character id");
    return readJsonSafe(this.cardPath(id), null);
  }

  /** 获取角色卡摘要。 */
  async getSummary(id) {
    const card = await this.get(id);
    if (!card) return null;
    return getCharacterSummary(card);
  }

  // ── 写 ──

  /** 原子落盘一张卡 + 更新索引。 */
  async #saveCard(card) {
    const cardPath = this.cardPath(card.id);
    await ensureDir(path.dirname(cardPath));
    await writeJsonAtomic(cardPath, card);

    const now = new Date().toISOString();
    const existing = this.find(card.id);
    this.upsert({
      id: card.id,
      name: card.name || "（无名称）",
      created_at: existing?.created_at || card.created_at || now,
      updated_at: now
    });
    await this.persist();
    return card;
  }

  /** 创建角色卡。 */
  async create(card) {
    if (!card) throw new Error("Card is required");

    const errors = validateCharacter(card);
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${errors.join(", ")}`);
    }

    const id = card.id || crypto.randomUUID();
    IndexedStore.assertSafeId(id, "character id");

    const now = new Date().toISOString();
    const cardWithId = {
      ...createEmptyCharacter(),
      ...card,
      id,
      created_at: now,
      updated_at: now
    };

    return this.#saveCard(cardWithId);
  }

  /** 更新角色卡。 */
  async update(id, updates) {
    IndexedStore.assertSafeId(id, "character id");

    const card = await this.get(id);
    if (!card) throw new Error(`Character not found: ${id}`);

    const updated = {
      ...card,
      ...updates,
      id, // id 不可变
      updated_at: new Date().toISOString()
    };

    const errors = validateCharacter(updated);
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${errors.join(", ")}`);
    }

    return this.#saveCard(updated);
  }

  /**
   * 原样恢复角色卡（用于迁移导入）。保留传入的 id，不重新生成。
   * 与 create() 的区别：create 会重算时间戳；restore 保留原时间戳。
   */
  async restore(card) {
    if (!card || typeof card !== "object") {
      throw new Error("card object is required");
    }

    const id = card.id || crypto.randomUUID();
    IndexedStore.assertSafeId(id, "character id");

    const now = new Date().toISOString();
    const restored = {
      ...createEmptyCharacter(),
      ...card,
      id,
      created_at: card.created_at || now,
      updated_at: card.updated_at || now
    };

    return this.#saveCard(restored);
  }

  /** 删除角色卡（连同目录里的头像）。 */
  async delete(id) {
    IndexedStore.assertSafeId(id, "character id");
    await fs.rm(this.characterDir(id), { recursive: true, force: true });
    await this.mutateIndex((index) => index.filter(c => c.id !== id));
  }

  /**
   * 批量删除。
   * 索引只落盘一次（原实现是每个 id 一次全量读写 → O(n²)）。
   */
  async deleteBatch(ids) {
    const results = [];
    const removed = [];

    for (const id of ids) {
      try {
        IndexedStore.assertSafeId(id, "character id");
        await fs.rm(this.characterDir(id), { recursive: true, force: true });
        removed.push(id);
        results.push({ id, success: true });
      } catch (e) {
        results.push({ id, success: false, error: e.message });
      }
    }

    if (removed.length > 0) {
      const set = new Set(removed);
      await this.mutateIndex((index) => index.filter(c => !set.has(c.id)));
    }

    return results;
  }
}

// 导出单例工厂
export function createCharacterRepo(dataDir) {
  return new CharacterRepo(dataDir);
}
