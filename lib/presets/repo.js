// lib/presets/repo.js — 提示词预设仓储
//
// 存储形态：单文件数组（dataDir/presets/presets.json）。
// 写操作统一走 mutateJson，读→改→原子写全程持锁。
//
// 三条不可破的规则（背后都是真实事故）：
//   1. 内置 default 预设不可删 —— 删了之后所有不显式指定预设的生成
//      都会回退到旧行为，等于这套预设系统白做
//   2. update 不许把预设改成 builtin —— 否则用户能"解锁"内置预设再删掉它
//   3. importPresets 幂等 —— 同 id 覆盖而非追加，重复导入不会堆出一串

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { mutateJson, readJsonSafe, ensureDir } from "../atomic.js";
import {
  createEmptyPreset,
  createDefaultPreset,
  createStoryProtocolPreset,
  validatePreset
} from "./model.js";

const DEFAULT_ID = "default";
const STORY_PROTOCOL_ID = "story-cwv1";

export class PresetRepo {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dir = path.join(dataDir, "presets");
    this.file = path.join(this.dir, "presets.json");
  }

  /** 首次初始化：建目录 + 装内置预设（幂等） */
  async init() {
    await ensureDir(this.dir);
    await mutateJson(this.file, [], async (current) => {
      const list = Array.isArray(current) ? current : [];
      if (!list.some(p => p.id === DEFAULT_ID)) {
        list.unshift(createDefaultPreset());
      }
      // 剧情卡协议预设：内置但默认不挂，用户在哪场用就挂到那场（幂等补装）
      if (!list.some(p => p.id === STORY_PROTOCOL_ID)) {
        list.push(createStoryProtocolPreset());
      }
      return list;
    });
    return this;
  }

  async list() {
    const list = await readJsonSafe(this.file, []);
    const arr = Array.isArray(list) ? list : [];
    // 内置排最前，其中「默认」钉在第一位（它是不指定预设时的回退），
    // 其余按名字稳定排序。
    return arr.slice().sort((a, b) => {
      if (a.id === DEFAULT_ID) return -1;
      if (b.id === DEFAULT_ID) return 1;
      if (!!a.builtin !== !!b.builtin) return a.builtin ? -1 : 1;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
  }

  async get(id) {
    const list = await this.list();
    return list.find(p => p.id === id) || null;
  }

  async create(overrides = {}) {
    const preset = createEmptyPreset(overrides);
    const errors = validatePreset(preset);
    if (errors.length > 0) throw new Error(errors.join("; "));

    await mutateJson(this.file, [], (current) => {
      const list = Array.isArray(current) ? current : [];
      if (list.some(p => p.id === preset.id)) {
        throw new Error(`Preset id already exists: ${preset.id}`);
      }
      list.push(preset);
      return list;
    });
    return preset;
  }

  async update(id, updates = {}) {
    if (id === DEFAULT_ID && updates.blocks !== undefined) {
      // 允许改内置预设的块（用户常想微调默认顺序），但 id / builtin 不动
    }
    let result = null;
    await mutateJson(this.file, [], (current) => {
      const list = Array.isArray(current) ? current : [];
      const idx = list.findIndex(p => p.id === id);
      if (idx === -1) throw new Error(`Preset not found: ${id}`);

      const merged = { ...list[idx], ...updates, id };
      // builtin 是宿主标记，外部不可写入（否则可删内置）
      merged.builtin = list[idx].builtin === true;
      merged.updated_at = new Date().toISOString();

      const errors = validatePreset(merged);
      if (errors.length > 0) throw new Error(errors.join("; "));

      list[idx] = merged;
      result = merged;
      return list;
    });
    return result;
  }

  /** 内置预设拒绝删除（规则 1） */
  async delete(id) {
    let existed = false;
    await mutateJson(this.file, [], (current) => {
      const list = Array.isArray(current) ? current : [];
      const target = list.find(p => p.id === id);
      if (!target) return list;
      if (target.builtin === true) {
        throw new Error(`内置预设不可删除: ${id}`);
      }
      existed = true;
      return list.filter(p => p.id !== id);
    });
    if (!existed) throw new Error(`Preset not found: ${id}`);
    return true;
  }

  /** 复制一套（内置也能复制，复制出来是可改可删的普通预设） */
  async duplicate(id) {
    const src = await this.get(id);
    if (!src) throw new Error(`Preset not found: ${id}`);

    const copy = createEmptyPreset({
      name: `${src.name || "预设"} 副本`,
      description: src.description || "",
      blocks: (src.blocks || []).map(b => ({ ...b })),
      sampling: { ...(src.sampling || {}) },
      builtin: false
    });

    await mutateJson(this.file, [], (current) => {
      const list = Array.isArray(current) ? current : [];
      list.push(copy);
      return list;
    });
    return copy;
  }

  /**
   * 导入预设（幂等）。
   * @returns {Promise<Array<{id,name,ok,mode?,error?}>>}
   */
  async importPresets(items) {
    if (!Array.isArray(items)) throw new Error("presets array is required");

    const results = [];
    await mutateJson(this.file, [], (current) => {
      const list = Array.isArray(current) ? current : [];

      for (const raw of items) {
        try {
          if (!raw || typeof raw !== "object") throw new Error("必须是对象");
          const incoming = {
            ...raw,
            id: typeof raw.id === "string" && raw.id ? raw.id : crypto.randomUUID(),
            // 导入不会把东西变成内置（规则 2）
            builtin: false,
            created_at: raw.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString()
          };
          const errors = validatePreset(incoming);
          if (errors.length > 0) throw new Error(errors.join("; "));

          const idx = list.findIndex(p => p.id === incoming.id);
          if (idx >= 0) {
            list[idx] = incoming;
            results.push({ id: incoming.id, name: incoming.name, ok: true, mode: "update" });
          } else {
            list.push(incoming);
            results.push({ id: incoming.id, name: incoming.name, ok: true, mode: "create" });
          }
        } catch (e) {
          results.push({ id: raw?.id ?? null, name: raw?.name ?? null, ok: false, error: e.message });
        }
      }
      return list;
    });
    return results;
  }
}

export function createPresetRepo(dataDir) {
  return new PresetRepo(dataDir);
}
