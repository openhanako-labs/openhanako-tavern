// lib/codex/repo.js — 图鉴仓储（人物 / 地点 / 势力）
//
// 两块盘，按「寿命」分：
//   world 级 → <dataDir>/codex/{persons,places,factions}.json（跨对话，世界的 Wiki）
//   chat  级 → 各自对话文件里的 codexPersons / codexPlaces / codexFactions 字段
//
// 与 board 同构：对话文件由 ConversationRepo 持有，这里直接对同一文件走 atomic 锁。
// 同一路径即同一把锁，不会互相踩。
//
// 读侧一律 normalize：老文件没有字段也能读，且不改写盘上文件。
// 三条不做的事：不做 lifespan 迁移（改了寿命会留在旧盘）、不做批量操作、
// 不做 pending 区（extract 二期才开）。

import path from "node:path";
import { mutateJson, readJsonSafe } from "../atomic.js";
import {
  CodexLifespan,
  createPerson, normalizePerson,
  createPlace, normalizePlace,
  createFaction, normalizeFaction,
  sortByName
} from "./model.js";

// 每张表对应的（世界文件名，对话文件里的字段名）。字段名分开是为了以后要单独统计时不打架。
const TABLES = {
  persons: {
    file: "persons.json",
    convKey: "codexPersons",
    create: createPerson, normalize: normalizePerson
  },
  places: {
    file: "places.json",
    convKey: "codexPlaces",
    create: createPlace, normalize: normalizePlace
  },
  factions: {
    file: "factions.json",
    convKey: "codexFactions",
    create: createFaction, normalize: normalizeFaction
  }
};

function tableOf(key) {
  const t = TABLES[key];
  if (!t) throw new Error(`Unknown codex table: ${key}`);
  return t;
}

export class CodexRepo {
  constructor(dataDir) {
    if (!dataDir) throw new Error("CodexRepo 需要 dataDir");
    this.dataDir = dataDir;
    this.dir = path.join(dataDir, "codex");
    this.conversationsDir = path.join(dataDir, "conversations");
  }

  async init() {
    // 三张表都初始化成空数组——文件不存在时 readJsonSafe 也回 []，
    // 但显式 init 一次保证盘上有东西可读，且建目录
    for (const key of Object.keys(TABLES)) {
      const file = path.join(this.dir, TABLES[key].file);
      await mutateJson(file, [], (cur) => (Array.isArray(cur) ? cur : []));
    }
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

  #worldFile(key) {
    return path.join(this.dir, tableOf(key).file);
  }

  // ── 读 ─────────────────────────────────────────────

  async #listWorld(key) {
    const raw = await readJsonSafe(this.#worldFile(key), []);
    const list = Array.isArray(raw) ? raw : [];
    const norm = tableOf(key).normalize;
    return sortByName(list.map(norm));
  }

  async #listChat(key, conversationId) {
    if (!conversationId) return [];
    const conv = await readJsonSafe(this.#convFile(conversationId), null);
    const field = tableOf(key).convKey;
    const list = Array.isArray(conv?.[field]) ? conv[field] : [];
    const norm = tableOf(key).normalize;
    return sortByName(list.map(norm));
  }

  /** 世界级。 */
  async listWorld(key) {
    return this.#listWorld(key);
  }

  /** 对话级。对话为空 → []。 */
  async listChat(key, conversationId) {
    return this.#listChat(key, conversationId || null);
  }

  /** 合并两块盘：世界级在前，对话级在后。 */
  async list(key, conversationId = null) {
    const world = await this.#listWorld(key);
    const chat = await this.#listChat(key, conversationId);
    return [...world, ...chat];
  }

  /** 按 id 找一条（先世界级，再对话级）。 */
  async get(key, id, conversationId = null) {
    if (!id) return null;
    const world = await this.#listWorld(key);
    const hit = world.find(x => x.id === id);
    if (hit) return hit;
    const chat = await this.#listChat(key, conversationId);
    return chat.find(x => x.id === id) || null;
  }

  // ── 写 ─────────────────────────────────────────────

  async #upsertWorld(key, item) {
    const file = this.#worldFile(key);
    const norm = tableOf(key).normalize;
    const next = norm(item);
    await mutateJson(file, [], (cur) => {
      const list = Array.isArray(cur) ? cur : [];
      const idx = list.findIndex(x => x.id === next.id);
      if (idx >= 0) list[idx] = next;
      else list.push(next);
      return list;
    });
    return next;
  }

  async #removeWorld(key, id) {
    const file = this.#worldFile(key);
    await mutateJson(file, [], (cur) => {
      const list = Array.isArray(cur) ? cur : [];
      return list.filter(x => x.id !== id);
    });
  }

  async #upsertChat(key, conversationId, item) {
    const file = this.#convFile(conversationId);
    const field = tableOf(key).convKey;
    const norm = tableOf(key).normalize;
    const next = norm(item);
    await mutateJson(file, null, (conv) => {
      if (!conv) throw new Error(`Conversation not found: ${conversationId}`);
      const list = Array.isArray(conv[field]) ? conv[field] : [];
      const idx = list.findIndex(x => x.id === next.id);
      if (idx >= 0) list[idx] = next;
      else list.push(next);
      conv[field] = list;
      conv.updatedAt = new Date().toISOString();
      return conv;
    });
    return next;
  }

  async #removeChat(key, conversationId, id) {
    const file = this.#convFile(conversationId);
    const field = tableOf(key).convKey;
    await mutateJson(file, null, (conv) => {
      if (!conv) return conv;
      const list = Array.isArray(conv[field]) ? conv[field] : [];
      conv[field] = list.filter(x => x.id !== id);
      return conv;
    });
  }

  /**
   * 新建一条。寿命决定落哪块盘——chat 级必须给 conversationId。
   */
  async create(key, input = {}, conversationId = null) {
    const t = tableOf(key);
    const item = t.create(input);
    if (item.lifespan === CodexLifespan.WORLD) return this.#upsertWorld(key, item);
    if (!conversationId) {
      throw new Error("对话级图鉴条目需要一个 conversationId（或者把 lifespan 设成 world）");
    }
    return this.#upsertChat(key, conversationId, item);
  }

  /**
   * 更新一条。寿命从 world 改成 chat（或反过来）时会搬家——
   * 不搬家的话，改完寿命的条目会留在旧盘上，读出来寿命跟位置对不上。
   *
   * 与 board 一样：**不先把局部更新单独 normalize**——
   * 缺字段会被补成默认值，再盖到原条目上，改一下 lifespan 就把其它字段全清了。
   * 必须先合并，再整体归一。
   */
  async update(key, id, updates = {}, conversationId = null) {
    const t = tableOf(key);
    const patch = { ...(updates || {}), updatedAt: new Date().toISOString() };

    const world = await this.#listWorld(key);
    const beforeWorld = world.find(x => x.id === id);
    if (beforeWorld) {
      const next = t.normalize({ ...beforeWorld, ...patch });
      if (next.lifespan === CodexLifespan.CHAT) {
        if (!conversationId) throw new Error("把寿命改成对话级需要一个 conversationId");
        await this.#removeWorld(key, id);
        return this.#upsertChat(key, conversationId, next);
      }
      return this.#upsertWorld(key, next);
    }

    const chat = await this.#listChat(key, conversationId);
    const beforeChat = chat.find(x => x.id === id);
    if (!beforeChat) return null;

    const nextChat = t.normalize({ ...beforeChat, ...patch });
    if (nextChat.lifespan === CodexLifespan.WORLD) {
      await this.#removeChat(key, conversationId, id);
      return this.#upsertWorld(key, nextChat);
    }
    return this.#upsertChat(key, conversationId, nextChat);
  }

  /** 删除。返回是否真的删掉了。 */
  async delete(key, id, conversationId = null) {
    const world = await this.#listWorld(key);
    if (world.some(x => x.id === id)) {
      await this.#removeWorld(key, id);
      return true;
    }
    const chat = await this.#listChat(key, conversationId);
    if (chat.some(x => x.id === id)) {
      await this.#removeChat(key, conversationId, id);
      return true;
    }
    return false;
  }

  // ── persons 特有的追加制操作 ─────────────────────────

  /**
   * 给某个人物追加一条记录（notes 追加制，不覆写）。
   * 只支持 persons 表——其它两张表没这格。
   * 返回更新后的条目，或 null（找不到）。
   */
  async appendNote(id, note = {}, conversationId = null) {
    const entry = note && typeof note === "object" ? note : {};
    const normalized = {
      at: typeof entry.at === "string" ? entry.at : new Date().toISOString(),
      convId: typeof entry.convId === "string" && entry.convId ? entry.convId : null,
      text: typeof entry.text === "string" ? entry.text : ""
    };
    if (!normalized.text.trim()) return null;

    const world = await this.#listWorld("persons");
    const worldHit = world.find(x => x.id === id);
    if (worldHit) {
      const next = normalizePerson({
        ...worldHit,
        notes: [...(Array.isArray(worldHit.notes) ? worldHit.notes : []), normalized],
        updatedAt: new Date().toISOString()
      });
      return this.#upsertWorld("persons", next);
    }

    const chat = await this.#listChat("persons", conversationId);
    const chatHit = chat.find(x => x.id === id);
    if (!chatHit) return null;
    const next = normalizePerson({
      ...chatHit,
      notes: [...(Array.isArray(chatHit.notes) ? chatHit.notes : []), normalized],
      updatedAt: new Date().toISOString()
    });
    return this.#upsertChat("persons", conversationId, next);
  }
}

export function createCodexRepo(dataDir) {
  return new CodexRepo(dataDir);
}
