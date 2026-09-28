// lib/director/repo.js — 导演实体的仓储
//
// 一个盘：dataDir/directors.json。实体是**纯配置**——
// 它不含进度，所以不是一场一份，而是全局一份、谁都能绑。
//
// 与 BoardRepo 同一种走法（readJsonSafe / mutateJson，同一路径即同一把锁）：
// 数量少、整读整写，不需要给每个实体开一个文件。
//
// 写侧一律过 validateDirectorEntity：写错的规则不会报错，只会**静默失效**
// ——剧情照走，只是永远不按作者想的走。这种错必须挡在保存那一步。

import path from "node:path";
import { randomUUID } from "node:crypto";
import { mutateJson, readJsonSafe } from "../atomic.js";
import { createDirectorEntity, validateDirectorEntity } from "./model.js";

function cleanId(id) {
  const s = String(id ?? "").trim();
  if (!s || s.includes("..") || s.includes("/") || s.includes("\\")) {
    throw new Error("Invalid director id");
  }
  return s;
}

/** 把一份来路不明的记录补齐成完整实体（老文件缺字段也能读）。 */
function normalize(record) {
  if (!record || typeof record !== "object") return null;
  return createDirectorEntity({
    ...record,
    id: String(record.id || ""),
    name: String(record.name || "未命名公式"),
    characterId: String(record.characterId || ""),
    state: record.state && typeof record.state === "object" ? record.state : {},
    rules: Array.isArray(record.rules) ? record.rules : [],
    enabled: record.enabled !== false
  });
}

export class DirectorRepo {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "directors.json");
  }

  async init() {
    await mutateJson(this.file, [], (current) => (Array.isArray(current) ? current : []));
    return this;
  }

  async #readAll() {
    const raw = await readJsonSafe(this.file, []);
    return (Array.isArray(raw) ? raw : []).map(normalize).filter(Boolean);
  }

  /** 列全部。界面上的顺序 = 创建顺序。 */
  async list() {
    return this.#readAll();
  }

  async get(id) {
    let key;
    try { key = cleanId(id); } catch { return null; }
    return (await this.#readAll()).find(d => d.id === key) || null;
  }

  /**
   * 建一个实体。
   *
   * 校验不过**直接抛**并带上问题清单：存下去一半、界面上又看着像成功了，
   * 是最坏的结果——作者以为配方在跑，其实某条规则从来没生效过。
   */
  async create(input = {}) {
    const entity = createDirectorEntity({
      ...input,
      id: String(input.id || "").trim() || randomUUID()
    });
    const problems = validateDirectorEntity(entity);
    if (problems.length) {
      const err = new Error("配方有问题：" + problems.join("；"));
      err.problems = problems;
      throw err;
    }

    let created = entity;
    await mutateJson(this.file, [], (current) => {
      const list = Array.isArray(current) ? current : [];
      if (list.some(d => d?.id === entity.id)) throw new Error("配方 id 已存在");
      created = entity;
      return [...list, entity];
    });
    return created;
  }

  async update(id, patch = {}) {
    const key = cleanId(id);
    let updated = null;

    await mutateJson(this.file, [], (current) => {
      const list = Array.isArray(current) ? current : [];
      const idx = list.findIndex(d => d?.id === key);
      if (idx < 0) throw new Error("配方不存在");

      const merged = createDirectorEntity({ ...normalize(list[idx]), ...patch, id: key });
      const problems = validateDirectorEntity(merged);
      if (problems.length) {
        const err = new Error("配方有问题：" + problems.join("；"));
        err.problems = problems;
        throw err;
      }
      updated = merged;
      const next = list.slice();
      next[idx] = merged;
      return next;
    });

    return updated;
  }

  async remove(id) {
    const key = cleanId(id);
    let removed = false;
    await mutateJson(this.file, [], (current) => {
      const list = Array.isArray(current) ? current : [];
      const next = list.filter(d => d?.id !== key);
      removed = next.length !== list.length;
      return next;
    });
    return removed;
  }

  /** 只试算不落盘：给界面一个「这条规则现在会命中吗」的入口。 */
  async validate(entity) {
    return validateDirectorEntity(createDirectorEntity(entity || {}));
  }
}

export function createDirectorRepo(dataDir) {
  return new DirectorRepo(dataDir);
}
