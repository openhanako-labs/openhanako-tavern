// lib/settings/repo.js — 设定库仓储
//
// 设定存在单个 JSON 数组文件里，不是索引型仓储。
// 写操作统一走 mutateJson：读→改→原子写，全程持锁，杜绝并发覆盖与半截文件。

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mutateJson, readJsonSafe, writeJsonAtomic } from "../atomic.js";
import { createSetting, contentFingerprint } from "./model.js";

/** 隔离区：装那些「没法用、但舍不得丢」的条目。 */
const QUARANTINE_FILE = "settings.malformed.json";

/** 世界书存单。与 settings.json 同目录。 */
const BOOKS_FILE = "books.json";

/** 全局散置条目所属的书名（回填时自动创建，不建重复）。 */
export const SCATTERED_BOOK_NAME = "散置条目";

/**
 * 把 settings.json 抄一份到宿主侧 host-backups/ 下。
 * 删书 / 回填前各存一份，备份路径也回传给调用者写日志。
 *
 * 命名规范跟手工备份一致：settings.<YYYYMMDD-HHMMSS>-<原因>.json。
 * 失败不抛：备份是保命，不是业务；就算失败，删书仍然跑。
 */
async function backupSettingsForBooks(settingsFile, reason) {
  try {
    // repo.js 在 lib/settings/ 下——app 根目录需上溯三级。
    // lib/settings/repo.js -> app/lib -> app -> host-backups
    // 用 fileURLToPath 而不是 import.meta.url 的 pathname——Windows 上后者的 pathname
    // 会丢掉盘符（返回 /C:/...），path.resolve 拼上去就成 "C:\\C:/..." 那种乱路径。
    const here = path.dirname(fileURLToPath(import.meta.url));
    const appRoot = path.resolve(here, "..", "..");
    const backupDir = path.join(appRoot, "host-backups");
    await fs.mkdir(backupDir, { recursive: true });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const dest = path.join(backupDir, `settings.${stamp}-${reason}.json`);
    await fs.copyFile(settingsFile, dest);
    return dest;
  } catch (e) {
    console.warn(`[settings] 备份失败（不影响后续操作）: ${e?.message}`);
    return null;
  }
}

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
    this.booksFile = path.join(dataDir, BOOKS_FILE);
  }

  async init() {
    // 文件不存在时建一个空数组，保证后续读到的形状稳定
    await mutateJson(this.settingsFile, [], (current) => {
      return Array.isArray(current) ? current : [];
    });
    // 书表同样保证存在——删书 / 列书都直接读它，不能因为空目录报 ENOENT。
    await mutateJson(this.booksFile, [], (current) => {
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
   * 内部改走 listEffective——书关了 = 整书条目从激活里消失（不是一层层往后传一个 flag）。
   * 预核算账、导出、任何「要生效条目」的地方都应该走 listEffective 而不是 list。
   *
   * @param {object} context
   * @param {object} variables
   * @param {object} [scope] - { characterId, characterName, characterTags } 用于角色隔离
   */
  async getActive(context, variables, scope = null) {
    const { getActiveSettings, filterForCharacter } = await import("./model.js");
    let settings = await this.listEffective();
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
   * 世界书（B）：导入时确保该卡的书存在，所有新条目自动挂上 bookId。
   * 卡重导一次只是刷内容——书本身（及其开关）不会动。
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

    // 确保该卡的书存在，然后才挂 bookId——顺序不能反（bookId 先引用一个已存在的书）。
    const book = await this.ensureBookForCharacter(characterId, opts.characterNameOf);
    for (const s of list) {
      s.characterId = characterId;
      s.bookId = book.id;
    }
    const result = await this.importSettings(list);
    return { ...result, removed };
  }

  // ═════════ 世界书（B）：书 → 条目 两级结构 ═════════

  /** 读书表（内部用；外部走 listBooks 拿带计数的视图）。 */
  async _readBooks() {
    const raw = await readJsonSafe(this.booksFile, []);
    return Array.isArray(raw) ? raw : [];
  }

  /** 在锁内改书表。 */
  async _mutateBooks(fn) {
    return mutateJson(this.booksFile, [], fn);
  }

  /** 列出所有书（带每书条目数）。 */
  async listBooks() {
    const books = await this._readBooks();
    const settings = await this.list();
    const counter = new Map();
    for (const s of settings) {
      const bid = String(s?.bookId || "").trim();
      if (!bid) continue;
      counter.set(bid, (counter.get(bid) || 0) + 1);
    }
    return books.map(b => ({ ...b, entryCount: counter.get(b.id) || 0 }));
  }

  /** 建书。characterId 非空 = 卡的书，空 = 全局书。 */
  async createBook({ name, characterId, source } = {}) {
    const book = {
      id: crypto.randomUUID(),
      name: String(name || "").trim() || "（未命名书）",
      enabled: true,
      characterId: characterId ? String(characterId).trim() : "",
      source: source || "native",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await this._mutateBooks((current) => {
      const list = Array.isArray(current) ? current : [];
      list.push(book);
      return list;
    });
    return book;
  }

  /** 改名。 */
  async renameBook(id, name) {
    const n = String(name || "").trim();
    if (!n) throw new Error("book name is required");
    let updated = null;
    await this._mutateBooks((current) => {
      const list = Array.isArray(current) ? current : [];
      const idx = list.findIndex(b => b.id === id);
      if (idx === -1) throw new Error(`Book not found: ${id}`);
      list[idx] = { ...list[idx], name: n, updatedAt: new Date().toISOString() };
      updated = list[idx];
      return list;
    });
    return updated;
  }

  /** 开/关整书。 */
  async toggleBook(id, enabled) {
    let updated = null;
    await this._mutateBooks((current) => {
      const list = Array.isArray(current) ? current : [];
      const idx = list.findIndex(b => b.id === id);
      if (idx === -1) throw new Error(`Book not found: ${id}`);
      list[idx] = { ...list[idx], enabled: !!enabled, updatedAt: new Date().toISOString() };
      updated = list[idx];
      return list;
    });
    return updated;
  }

  /**
   * 删书 + 连带删条目。
   *
   * 顺序（不可换）：
   *   1. 备份 settings.json 到 host-backups/
   *   2. 删条目（连带）
   *   3. 删书本身
   *
   * 备份必须最早——如果后续步骤抛了，用户至少能手工恢复；
   * 备份在删除之后做就完全没意义了。
   */
  async deleteBook(id) {
    const bid = String(id || "").trim();
    if (!bid) throw new Error("book id is required");
    // 先验存在——与 renameBook / toggleBook 同口径，非存在就报错而不是静默 no-op
    // （否则 UI 上「删了」与「本来就没」无法区分，用户会以为删除成功了）
    const books = await this._readBooks();
    if (!books.some(b => b.id === bid)) {
      throw new Error(`Book not found: ${bid}`);
    }
    const backupPath = await backupSettingsForBooks(this.settingsFile, `delete-book-${bid.slice(0,8)}`);
    let removedEntries = 0;
    await mutateJson(this.settingsFile, [], (current) => {
      const list = Array.isArray(current) ? current : [];
      const kept = list.filter(s => String(s?.bookId || "") !== bid);
      removedEntries = list.length - kept.length;
      return kept;
    });
    let removedBook = 0;
    await this._mutateBooks((current) => {
      const list = Array.isArray(current) ? current : [];
      const kept = list.filter(b => b.id !== bid);
      removedBook = list.length - kept.length;
      return kept;
    });
    return { bookId: bid, removedEntries, removedBook, backupPath };
  }

  /**
   * 生效条目：书开着 / 书不存在 / 未归档 都算开；
   * 只有 bookId 指向一本明确「enabled=false」的书时才算关。
   *
   * 这个判定写在 repo 里而不是 model 里，是因为书表在 repo 手里——
   * 不该让 model 知道书的存在。
   */
  async listEffective() {
    const books = await this._readBooks();
    const enabledOf = new Map(books.map(b => [b.id, b.enabled !== false]));
    const all = await this.list();
    return all.filter(s => {
      const bid = String(s?.bookId || "").trim();
      if (!bid) return true;
      return enabledOf.get(bid) !== false;
    });
  }

  /**
   * 确保「这张卡的书」存在（character_book 来源、绑 characterId）。
   * 找不到就建一本，书名取 charNameOf(id) 或退化为「角色书 <短 id>」。
   *
   * @param {string} characterId
   * @param {(id:string)=>string|Promise<string>} [charNameOf]
   */
  async ensureBookForCharacter(characterId, charNameOf) {
    const cid = String(characterId || "").trim();
    if (!cid) throw new Error("characterId is required");
    const books = await this._readBooks();
    const hit = books.find(b => b.characterId === cid && b.source === "character_book");
    if (hit) return hit;
    let name = "";
    try {
      if (typeof charNameOf === "function") {
        name = String(await charNameOf(cid) || "").trim();
      }
    } catch { /* 名字取不到不影响建书 */ }
    if (!name) name = `角色书 ${cid.slice(0,8)}`;
    return await this.createBook({ name, characterId: cid, source: "character_book" });
  }

  /**
   * 确保「全局书」存在（characterId 空、按名字去重）。
   * import-st 用这个：同名书不再建新的，重复导入挂到已有书。
   */
  async ensureBookByName(name) {
    const n = String(name || "").trim() || SCATTERED_BOOK_NAME;
    const books = await this._readBooks();
    const hit = books.find(b => !b.characterId && String(b.name).trim() === n);
    if (hit) return hit;
    return await this.createBook({ name: n, source: "native" });
  }

  /**
   * 回填：把现存条目按 source + characterId 归档到书里。
   *
   * 幂等——重复调用不会产生重复书或重复 bookId：
   *   · 卡书按 (characterId, source=character_book) 唯一
   *   · 全局书按 name=SCATTERED_BOOK_NAME（且 characterId 空）唯一
   *   · 已挂 bookId 且指向现存书的条目直接跳过
   *
   * 副作用：
   *   1. 新建的书写进 books.json（幂等）
   *   2. 未归档条目的 bookId 就地改（只在有改动时才写 settings.json）
   *
   * 备份：动 settings.json 前先备份到 host-backups/。
   *
   * @param {(id:string)=>string|Promise<string>} [charNameOf] 角色 id → 名字
   * @returns {Promise<{createdBooks:number, updatedEntries:number, backupPath:string|null}>}
   */
  async backfillBooks(charNameOf) {
    const backupPath = await backupSettingsForBooks(this.settingsFile, "books-backfill");
    let createdBooks = 0;
    let updatedEntries = 0;

    await mutateJson(this.settingsFile, [], async (current) => {
      const list = Array.isArray(current) ? current : [];
      const books = await this._readBooks();
      const bookByCharId = new Map(books.filter(b => b.characterId).map(b => [b.characterId, b]));
      const bookByName = new Map(books.filter(b => !b.characterId).map(b => [String(b.name).trim(), b]));
      const newBooks = [];
      let touched = 0;

      for (const s of list) {
        const curBid = String(s?.bookId || "").trim();
        if (curBid) {
          // 已挂的：指向现存书就跳过；指向已删的当未归档重挂
          const exists = books.some(b => b.id === curBid) || newBooks.some(b => b.id === curBid);
          if (exists) continue;
        }

        let book;
        const cid = String(s?.characterId || "").trim();
        if (cid && s?.source === "character_book") {
          book = bookByCharId.get(cid);
          if (!book) {
            let name = "";
            try {
              if (typeof charNameOf === "function") name = String(await charNameOf(cid) || "").trim();
            } catch { /* ignore */ }
            if (!name) name = `角色书 ${cid.slice(0,8)}`;
            const now = new Date().toISOString();
            book = { id: crypto.randomUUID(), name, enabled: true, characterId: cid, source: "character_book", createdAt: now, updatedAt: now };
            bookByCharId.set(cid, book);
            newBooks.push(book);
            createdBooks++;
          }
        } else {
          book = bookByName.get(SCATTERED_BOOK_NAME);
          if (!book) {
            const now = new Date().toISOString();
            book = { id: crypto.randomUUID(), name: SCATTERED_BOOK_NAME, enabled: true, characterId: "", source: "native", createdAt: now, updatedAt: now };
            bookByName.set(SCATTERED_BOOK_NAME, book);
            newBooks.push(book);
            createdBooks++;
          }
        }
        s.bookId = book.id;
        touched++;
      }

      if (newBooks.length > 0) {
        await this._mutateBooks((cur) => {
          const list2 = Array.isArray(cur) ? cur : [];
          list2.push(...newBooks);
          return list2;
        });
      }

      // 没改就返回 undefined——mutateJson 不写盘
      if (touched > 0) {
        updatedEntries = touched;
        return list;
      }
      return undefined;
    });

    return { createdBooks, updatedEntries, backupPath };
  }

  // ═════════ 世界书结束 ═════════
}

export function createSettingRepo(dataDir) {
  return new SettingRepo(dataDir);
}
