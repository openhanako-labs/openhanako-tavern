// lib/settings/repo.js — 设定库仓储
//
// 设定存在单个 JSON 数组文件里，不是索引型仓储。
// 写操作统一走 mutateJson：读→改→原子写，全程持锁，杜绝并发覆盖与半截文件。

import crypto from "node:crypto";
import path from "node:path";
import { mutateJson, readJsonSafe } from "../atomic.js";
import { createSetting } from "./model.js";

export class SettingRepo {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.settingsFile = path.join(dataDir, "settings.json");
  }

  async init() {
    // 文件不存在时建一个空数组，保证后续读到的形状稳定
    await mutateJson(this.settingsFile, [], (current) => {
      return Array.isArray(current) ? current : [];
    });
    return this;
  }

  /** 获取所有设定（按 order 排序）。 */
  async list() {
    const settings = await readJsonSafe(this.settingsFile, []);
    const arr = Array.isArray(settings) ? settings : [];
    return arr.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  /** 获取设定详情。 */
  async get(id) {
    const settings = await this.list();
    return settings.find(s => s.id === id) || null;
  }

  /** 创建设定。 */
  async create(overrides = {}) {
    const setting = createSetting(overrides);
    await mutateJson(this.settingsFile, [], (current) => {
      const list = Array.isArray(current) ? current : [];
      setting.order = list.length > 0
        ? Math.max(...list.map(s => s.order || 0)) + 1
        : 1;
      list.push(setting);
      return list;
    });
    return setting;
  }

  /** 更新设定。 */
  async update(id, updates) {
    let result = null;
    await mutateJson(this.settingsFile, [], (current) => {
      const list = Array.isArray(current) ? current : [];
      const idx = list.findIndex(s => s.id === id);
      if (idx === -1) throw new Error(`Setting not found: ${id}`);

      list[idx] = {
        ...list[idx],
        ...updates,
        id, // id 不可变
        updatedAt: new Date().toISOString()
      };
      result = list[idx];
      return list;
    });
    return result;
  }

  /** 删除设定。 */
  async delete(id) {
    await mutateJson(this.settingsFile, [], (current) => {
      const list = Array.isArray(current) ? current : [];
      return list.filter(s => s.id !== id);
    });
    return true;
  }

  /**
   * 原样恢复设定（用于迁移导入）。保留传入 id。
   * 已存在同 id → 覆盖；否则追加。
   */
  async restore(setting) {
    if (!setting || typeof setting !== "object") {
      throw new Error("setting object is required");
    }

    const id = setting.id || crypto.randomUUID();
    const restored = {
      ...createSetting(setting),
      ...setting,
      id,
      updatedAt: setting.updatedAt || new Date().toISOString()
    };

    await mutateJson(this.settingsFile, [], (current) => {
      const list = Array.isArray(current) ? current : [];
      if (!restored.order) {
        restored.order = list.length > 0
          ? Math.max(...list.map(s => s.order || 0)) + 1
          : 1;
      }
      const idx = list.findIndex(s => s.id === id);
      if (idx >= 0) list[idx] = restored;
      else list.push(restored);
      return list;
    });

    return restored;
  }

  /** 批量导入设定。 */
  async importSettings(items) {
    if (!Array.isArray(items)) throw new Error("items must be an array");

    const added = [];
    const skipped = [];

    await mutateJson(this.settingsFile, [], (current) => {
      const list = Array.isArray(current) ? current : [];
      // 去重键必须带归属：
      //   两张角色卡都有一条叫「世界观」的条目时，只按 name 去重会把
      //   第二张卡的那条静默吞掉——卡导入成功但设定凭空少一半。
      const keyOf = (s) => `${s?.name ?? ""}::${s?.characterId || ""}`;
      const nameSet = new Set(list.map(keyOf));
      let order = list.length > 0 ? Math.max(...list.map(s => s.order || 0)) + 1 : 1;

      for (const item of items) {
        const setting = createSetting(item);
        const key = keyOf(setting);
        if (nameSet.has(key)) {
          skipped.push(item.name);
          continue;
        }
        setting.order = order++;
        list.push(setting);
        nameSet.add(key);
        added.push(setting);
      }
      return list;
    });

    return { added: added.length, skipped };
  }

  /** 启用/禁用设定。 */
  async toggle(id, enabled) {
    return this.update(id, { enabled });
  }

  /**
   * 获取活跃设定（基于上下文）。
   *
   * @param {object} context
   * @param {object} variables
   * @param {object} [scope] - { characterId, characterName, characterTags } 用于角色隔离
   */
  async getActive(context, variables, scope = null) {
    const { getActiveSettings, filterForCharacter } = await import("./model.js");
    let settings = await this.list();
    if (scope?.characterId) settings = filterForCharacter(settings, scope);
    return getActiveSettings(settings, context, variables);
  }

  /** 列出属于某角色的条目 + 全局条目（供 UI 分级展示）。 */
  async listForCharacter(characterId, opts = {}) {
    const { filterForCharacter } = await import("./model.js");
    const settings = await this.list();
    if (!characterId) return settings;
    return filterForCharacter(settings, { characterId, ...opts });
  }

  /**
   * 把一个角色的内嵌世界书落地为设定条目。
   *
   * 与裸 importSettings 的区别：这里会先清掉该角色已有的同名条目，
   * 保证重复导入同一张卡不会堆出一串重复条目。
   *
   * @returns {{added:number, skipped:string[], removed:number}}
   */
  async importCharacterBook(characterId, settings, opts = {}) {
    if (!characterId) throw new Error("characterId is required");
    const list = Array.isArray(settings) ? settings : [];
    if (list.length === 0) return { added: 0, skipped: [], removed: 0 };

    // 先移除该角色先前导入的条目（不碰全局与他人条目）
    let removed = 0;
    await mutateJson(this.settingsFile, [], (current) => {
      const arr = Array.isArray(current) ? current : [];
      const kept = arr.filter(s => {
        const same = s?.characterId === characterId;
        if (same) removed++;
        return !same;
      });
      return kept;
    });

    for (const s of list) s.characterId = characterId;
    const result = await this.importSettings(list);
    return { ...result, removed };
  }
}

export function createSettingRepo(dataDir) {
  return new SettingRepo(dataDir);
}
