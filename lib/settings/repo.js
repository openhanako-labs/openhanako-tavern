// lib/settings/repo.js — 设定库仓储
//
// 设定存在单个 JSON 数组文件里，不是索引型仓储。
// 写操作统一走 mutateJson：读→改→原子写，全程持锁，杜绝并发覆盖与半截文件。

import crypto from "node:crypto";
import path from "node:path";
import { mutateJson, readJsonSafe, writeJsonAtomic } from "../atomic.js";
import { createSetting, contentFingerprint } from "./model.js";

/** 隔离区：装那些「没法用、但舍不得丢」的条目。 */
const QUARANTINE_FILE = "settings.malformed.json";

/**
 * 一条设定能不能安全使用。
 *
 * 只卡两件事：是个对象，且有非空 id。
 * 缺 content / 缺 keywords 都不算坏——那些照常用得了，只是空。
 * 没有 id 就定位不了（改不了也删不掉），留着只会在每次写盘时被原样搬运。
 *
 * @param {unknown} s
 * @returns {boolean}
 */
function isUsableSetting(s) {
  return !!s && typeof s === "object" && !Array.isArray(s)
    && typeof s.id === "string" && s.id.trim() !== "";
}

/**
 * 认出「同一条设定」。
 *
 * 优先用原始 id（ST 世界书的 uid）——它比名字稳，也比内容稳：
 * 用户改了内容，它仍认得出是同一条。
 * 没有原始 id（用户手建、老数据）时才退到内容指纹。
 *
 * **名字不算身份**：改名会让同一条认不出来（堆重复），
 * 重名会让两条互相吞（丢数据）。上一版注释写的是「加归属就够了」，
 * 但同一个角色名下同样会重名。
 *
 * @param {object} s - 设定条目
 * @returns {string} 身份键
 */
function identityOf(s) {
  const src = s?.source || "native";
  const cid = s?.characterId || "";
  const ext = String(s?.externalId || "").trim();
  if (ext) return `${src}|ext:${ext}|${cid}`;
  return `${src}|sha:${contentFingerprint(s)}|${cid}`;
}

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
    // 启动时扫一次：把没法用的条目挪进隔离区。
    // 一条坏数据不该带走整表——这是 settings.json 这种「一个大数组」最脆的地方。
    await this.quarantineMalformedEntries();
    return this;
  }

  /**
   * 把没法用的条目从 settings.json 挪进隔离区，返回搬走的条数。
   *
   * 为什么是「挪」不是「删」：坏条目是证据——用户会想知道自己丢了什么、
   * 为什么丢。删了就查无此据。（跟 atomic.js 把整个坏文件改名备份同一个态度。）
   *
   * @returns {Promise<number>}
   */
  async quarantineMalformedEntries() {
    const moved = [];

    await mutateJson(this.settingsFile, [], (current) => {
      const arr = Array.isArray(current) ? current : [];
      const good = [];
      for (const s of arr) {
        if (isUsableSetting(s)) good.push(s);
        else moved.push(s);
      }
      // 没坏的就不写盘——避免每次启动都白写一次
      return moved.length > 0 ? good : undefined;
    });

    if (moved.length === 0) return 0;

    try {
      const file = path.join(this.dataDir, QUARANTINE_FILE);
      const prev = await readJsonSafe(file, []);
      const list = Array.isArray(prev) ? prev : [];
      const now = new Date().toISOString();
      for (const entry of moved) {
        list.push({ quarantinedAt: now, source: "settings.json", entry });
      }
      await writeJsonAtomic(file, list);
      console.warn(`[settings] ${moved.length} 条损坏条目已移入隔离区 ${QUARANTINE_FILE}`);
    } catch (e) {
      // 隔离失败不阻断启动：条目已经从主表里拿出来了，总比整表坏强。
      // 但要说出来——不然就成了另一种静默吞数据。
      console.error(`[settings] 隔离区写入失败，这 ${moved.length} 条将丢失: ${e?.message}`);
    }

    return moved.length;
  }

  /** 获取所有设定（按 order 排序）。 */
  async list() {
    const settings = await readJsonSafe(this.settingsFile, []);
    const arr = Array.isArray(settings) ? settings : [];
    // 读的时候也过滤一道：文件可能被外部改坏，没走 init 那条路。
    // 只过滤不写盘——读操作不该有副作用。
    return arr.filter(isUsableSetting).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
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
    const updated = [];
    const skipped = [];

    await mutateJson(this.settingsFile, [], (current) => {
      const list = Array.isArray(current) ? current : [];
      const byIdentity = new Map(list.map(s => [identityOf(s), s]));
      let order = list.length > 0 ? Math.max(...list.map(s => s.order || 0)) + 1 : 1;

      for (const item of items) {
        const setting = createSetting(item);
        const key = identityOf(setting);
        const existing = byIdentity.get(key);

        if (existing) {
          // 同一条：刷新内容，而不是跳过。
          //
          // 以前这里直接 `skipped.push` + continue——用户重新导入一份
          // 更新过的世界书，改动全丢，界面还告诉他“导入完成”。
          // 判重的目的从来不是「挡住重复」，是「认出同一条」。
          //
          // enabled 不刷：用户可能手动关过某一条，那是他的选择，不是卡的数据。
          const keptEnabled = existing.enabled;
          Object.assign(existing, setting, {
            id: existing.id,
            order: existing.order ?? order++,
            enabled: keptEnabled
          });
          updated.push(existing);
          continue;
        }

        setting.order = order++;
        list.push(setting);
        byIdentity.set(key, setting);
        added.push(setting);
      }
      return list;
    });

    return { added: added.length, updated: updated.length, skipped };
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
   * 与裸 importSettings 的区别：这里会先清掉**这张卡先前带来的**条目
   * （source="character_book"），保证重复导入同一张卡不会堆出一串重复条目。
   * 用户手动建的、从独立世界书导入的，都不在这刀范围内。
   *
   * @returns {{added:number, skipped:string[], removed:number}}
   */
  async importCharacterBook(characterId, settings, opts = {}) {
    if (!characterId) throw new Error("characterId is required");
    const list = Array.isArray(settings) ? settings : [];
    if (list.length === 0) return { added: 0, skipped: [], removed: 0 };

    // 先移除**这张卡先前带来的**条目。
    //
    // 这里以前是 `s?.characterId === characterId`——只要条目绑到这个角色就删。
    // 于是用户手动给这个角色建的设定（source="native"）重导一次卡就没了。
    // 归属（对谁生效）和来源（谁带来的）是两件事，删除只能按来源判。
    // 只认明确的 character_book；source 缺失的老数据一律保留（宁可留着，不可误删）。
    let removed = 0;
    await mutateJson(this.settingsFile, [], (current) => {
      const arr = Array.isArray(current) ? current : [];
      const kept = arr.filter(s => {
        const fromThisCard = s?.characterId === characterId && s?.source === "character_book";
        if (fromThisCard) removed++;
        return !fromThisCard;
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
