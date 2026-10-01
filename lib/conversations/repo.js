// lib/conversations/repo.js — 对话仓储
//
// 基于 IndexedStore：索引常驻内存、写操作原子化、并发安全。
// 所有"读对话 → 改 → 存 → 更新索引"的序列都走 #mutateConv()，避免散落的重复逻辑。

import crypto from "node:crypto";
import { IndexedStore } from "../store.js";
import { ensureDir, readJsonSafe, writeJsonAtomic, withLock } from "../atomic.js";
import { createEmptyConversation, createMessage, MessageRole } from "./model.js";
import { normalizeDirectorIds } from "../director/binding.js";

export class ConversationRepo extends IndexedStore {
  constructor(dataDir) {
    super(dataDir, "conversations");
    this.dataDir = dataDir;
    this.conversationsDir = this.dir; // 兼容旧字段名
  }

  // ── 索引项投影 ──

  #toIndexEntry(conv) {
    return {
      id: conv.id,
      characterId: conv.characterId,
      title: conv.title || conv.characterName || "（无标题）",
      messageCount: conv.messages?.length || 0,
      updatedAt: conv.updatedAt
    };
  }

  // ── 读 ──

  /** 列出所有对话（摘要）。 */
  async list() {
    const index = await this.load();
    return index.map(c => ({
      id: c.id,
      characterId: c.characterId,
      title: c.title || c.characterName || "（无标题）",
      messageCount: c.messageCount || 0,
      updatedAt: c.updatedAt
    }));
  }

  /** 获取对话详情。 */
  async get(id) {
    IndexedStore.assertSafeId(id, "conversation id");
    return readJsonSafe(this.recordPath(id), null);
  }

  // ── 写（统一走原子序列） ──

  /**
   * 原子地"读对话 → 改 → 存 → 更新索引"。
   * 整个过程持有该对话文件的锁，并发调用会串行。
   *
   * @param {string} id
   * @param {(conv: object) => any} mutator - 直接改 conv；返回值作为函数结果
   */
  async #mutateConv(id, mutator) {
    IndexedStore.assertSafeId(id, "conversation id");
    const filePath = this.recordPath(id);

    return withLock(filePath, async () => {
      const conv = await readJsonSafe(filePath, null);
      if (!conv) throw new Error(`Conversation not found: ${id}`);

      const result = await mutator(conv);
      conv.updatedAt = new Date().toISOString();

      await ensureDir(this.dir);
      await writeJsonAtomic(filePath, conv);
      this.upsert(this.#toIndexEntry(conv));
      await this.persist();

      return result;
    });
  }

  /** 创建对话。 */
  async create(characterId, options = {}) {
    if (!characterId) throw new Error("characterId is required");
    const conv = createEmptyConversation(characterId, options);
    await this.#saveConv(conv);
    return conv;
  }

  /**
   * 原样恢复一个对话（用于迁移导入）。
   *
   * 与 create() 的关键区别：保留传入的 id / messages / variables / 时间戳，
   * 不生成新 id、不清空消息。create(conv) 会把整个对话对象当成 characterId，
   * 且 createEmptyConversation 会重置 messages —— 那是导入丢数据的根因。
   */
  async restore(conv) {
    if (!conv || typeof conv !== "object") {
      throw new Error("conversation object is required");
    }

    const id = conv.id || crypto.randomUUID();
    IndexedStore.assertSafeId(id, "conversation id");

    const characterId = typeof conv.characterId === "string" ? conv.characterId : "";
    const restored = {
      ...createEmptyConversation(characterId),
      ...conv,
      id,
      characterId,
      messages: Array.isArray(conv.messages) ? conv.messages : [],
      variables: conv.variables && typeof conv.variables === "object" ? conv.variables : {},
      createdAt: conv.createdAt || new Date().toISOString(),
      updatedAt: conv.updatedAt || new Date().toISOString()
    };

    await this.#saveConv(restored);
    return restored;
  }

  /** 落盘一个完整对话对象 + 更新索引（内部共用）。 */
  async #saveConv(conv) {
    await ensureDir(this.dir);
    await writeJsonAtomic(this.recordPath(conv.id), conv);
    this.upsert(this.#toIndexEntry(conv));
    await this.persist();
    return conv;
  }

  /** 更新对话的顶层字段。 */
  async update(id, updates) {
    return this.#mutateConv(id, (conv) => {
      Object.assign(conv, updates, { id });
      return conv;
    });
  }

  /**
   * 更新用户人设（userName / persona）。
   *
   * 只允许改这两个字段：update() 是全字段合并，
   * 直接把前端传来的对象塞进去可以让调用方顺手改掉 id / messages。
   */
  async setPersona(id, { userName, persona }) {
    const patch = {};
    if (typeof userName === "string") patch.userName = userName;
    if (typeof persona === "string") patch.persona = persona;
    if (Object.keys(patch).length === 0) return this.get(id);
    return this.#mutateConv(id, (conv) => {
      Object.assign(conv, patch);
      return conv;
    });
  }

  /**
   * 绑定 / 解绑导演公式。
   *
   * 单开一个方法而不是走 update()：update 是全字段合并，
   * 让调用方直接塞一个对象进去，就能顺手改掉 id / messages
   *（同 setPersona 的理由——那两个字段的护栏不能只靠调用方自觉）。
   *
   * 单值入口保留：内部转调 setDirectors，等价于「只绑这一个」。
   * 传空串 = 全解绑。
   */
  async setDirector(id, directorId) {
    const next = String(directorId || "").trim();
    return this.setDirectors(id, next ? [next] : []);
  }

  /**
   * 绑定一串导演公式（多条）。
   *
   * 同时维护 directorIds（新）与 directorId（旧，取第一条）——
   * 老版本的读侧只看 directorId，保留它能避免降级时看不到绑定。
   * 归一逻辑在 lib/director/binding.js，那里同时管着「旧文件怎么读」。
   */
  async setDirectors(id, directorIds) {
    const { directorIds: list, directorId: first } = normalizeDirectorIds(directorIds);
    return this.#mutateConv(id, (conv) => {
      conv.directorIds = list;
      conv.directorId = first;
      return conv;
    });
  }

  /** 添加消息。 */
  async addMessage(id, role, content, options = {}) {
    return this.#mutateConv(id, (conv) => {
      const msg = createMessage(role, content, options);
      conv.messages.push(msg);
      if (!conv.title && role === MessageRole.USER) {
        conv.title = (content || "").slice(0, 50) || "新对话";
      }
      return msg;
    });
  }

  /** 编辑单条消息。编辑 assistant 时旧内容进 variants，保留可回溯性。 */
  async editMessage(id, messageId, content) {
    return this.#mutateConv(id, (conv) => {
      const msg = conv.messages.find(m => m.id === messageId);
      if (!msg) throw new Error(`Message not found: ${messageId}`);

      if (msg.role === MessageRole.ASSISTANT && msg.content !== content) {
        if (!Array.isArray(msg.variants)) msg.variants = [];
        if (!msg.variants.includes(msg.content)) msg.variants.push(msg.content);
        msg.variantIndex = msg.variants.length;
      }

      msg.content = content;
      msg.editedAt = new Date().toISOString();
      return msg;
    });
  }

  /** 删除单条消息。 */
  async deleteMessage(id, messageId) {
    return this.#mutateConv(id, (conv) => {
      const before = conv.messages.length;
      conv.messages = conv.messages.filter(m => m.id !== messageId);
      if (conv.messages.length === before) {
        throw new Error(`Message not found: ${messageId}`);
      }
      return conv;
    });
  }

  /**
   * 回写单条消息的用量与原始回合。
   *
   * 这是缓存链路的落盘端：没有它，usage 与签名每轮都被丢弃，
   * provider 无法复用前缀，缓存命中率恒为 0。
   *
   * 注意：有效性**不在写入时维护**，而在读取时由
   * assistantContentFor() 比对 content 与 rawContent 判定。
   * 所以这里不需要在编辑/切变体时清字段。
   *
   * @param {string} id 对话 id
   * @param {string} messageId 消息 id
   * @param {{usage?, rawContent?, model?, reasoning?}} patch
   */
  async setMessageUsage(id, messageId, patch = {}) {
    return this.#mutateConv(id, (conv) => {
      const msg = conv.messages.find(m => m.id === messageId);
      if (!msg) throw new Error(`Message not found: ${messageId}`);
      if (patch.usage !== undefined) msg.usage = patch.usage;
      if (patch.rawContent !== undefined) msg.rawContent = patch.rawContent;
      if (patch.model !== undefined) msg.model = patch.model;
      if (patch.reasoning !== undefined) msg.reasoning = patch.reasoning;
      return msg;
    });
  }

  /**
   * 把剧情卡协议的解析结果挂到某条消息上（lib/story/protocol.js）。
   *
   * 与 setMessageSuggestions 同一条纪律：跟着消息走，编辑/删除/回退
   * 那条消息时它自然一起走。content 原文一字不动——解析结果只是
   * 渲染层的线索：msg.story.found 为真时画剧情卡，否则普通气泡。
   */
  async setMessageStory(id, messageId, story) {
    return this.#mutateConv(id, (conv) => {
      const msg = conv.messages.find(m => m.id === messageId);
      if (!msg) throw new Error(`Message not found: ${messageId}`);
      msg.story = story ?? null;
      return msg;
    });
  }

  /**
   * 把行动候选项挂到某条消息上。
   *
   * 为什么挂在消息上、不挂在对话上：候选项是「**这一轮之后**能做什么」。
   * 跟着消息走，编辑 / 删除 / 回退那条消息时它自然一起走，
   * 不会出现「三轮前的选项还挂在输入框上方」。
   */
  async setMessageSuggestions(id, messageId, items) {
    return this.#mutateConv(id, (conv) => {
      const msg = conv.messages.find(m => m.id === messageId);
      if (!msg) throw new Error(`Message not found: ${messageId}`);
      msg.suggestions = Array.isArray(items)
        ? items
            .map(x => ({ text: String(x?.text ?? "").slice(0, 120) }))
            .filter(x => x.text)
            .slice(0, 8)
        : [];
      return msg;
    });
  }

  /**
   * 为 assistant 消息追加一个变体（swipe 的存储侧）。
   * variants 存历史内容，当前内容单独放 msg.content。
   */
  async addVariant(id, messageId, content) {
    return this.#mutateConv(id, (conv) => {
      const msg = conv.messages.find(m => m.id === messageId);
      if (!msg) throw new Error(`Message not found: ${messageId}`);

      if (!Array.isArray(msg.variants)) {
        msg.variants = msg.content ? [msg.content] : [];
      }
      if (content && !msg.variants.includes(content)) msg.variants.push(content);
      msg.variantIndex = msg.variants.length - 1;
      msg.content = content;
      return msg;
    });
  }

  /**
   * 一次性设置变体列表（供开场白播种使用）。
   *
   * 与 addVariant 的区别：这里给定完整列表和当前下标，
   * 因为开场白的多条备选是同时确定的，不是逐条追加。
   */
  async setVariants(id, messageId, variants, index = 0) {
    return this.#mutateConv(id, (conv) => {
      const msg = conv.messages.find(m => m.id === messageId);
      if (!msg) throw new Error(`Message not found: ${messageId}`);

      const list = (Array.isArray(variants) ? variants : []).filter(v => typeof v === "string");
      if (list.length === 0) throw new Error("variants must be a non-empty array");

      const i = Math.min(Math.max(0, Number(index) || 0), list.length - 1);
      msg.variants = list;
      msg.variantIndex = i;
      msg.content = list[i];
      return msg;
    });
  }

  /** 切换 assistant 消息到某个变体。 */
  async switchVariant(id, messageId, index) {
    return this.#mutateConv(id, (conv) => {
      const msg = conv.messages.find(m => m.id === messageId);
      if (!msg) throw new Error(`Message not found: ${messageId}`);

      const variants = Array.isArray(msg.variants) ? msg.variants : [];
      if (index < 0 || index >= variants.length) {
        throw new Error(`Variant index out of range: ${index}`);
      }

      msg.content = variants[index];
      msg.variantIndex = index;
      return msg;
    });
  }

  /** 截断到最后一条 user 消息之后（供"重新生成"使用）。 */
  async truncateAfterLastUser(id) {
    let removed = 0;
    const conv = await this.#mutateConv(id, (c) => {
      let lastUserIdx = -1;
      for (let i = c.messages.length - 1; i >= 0; i--) {
        if (c.messages[i].role === MessageRole.USER) {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx === -1) return c;
      removed = c.messages.length - (lastUserIdx + 1);
      c.messages = c.messages.slice(0, lastUserIdx + 1);
      return c;
    });
    return { removed, conv };
  }

  /** 删除对话。 */
  async delete(id) {
    IndexedStore.assertSafeId(id, "conversation id");
    const { rm } = await import("node:fs/promises");
    await rm(this.recordPath(id), { force: true });
    await this.mutateIndex((index) => index.filter(c => c.id !== id));
  }

  /**
   * 回写插图消息的字段（第 2 批 2.5）。
   *
   * 与 setMessageUsage / setMessageSuggestions 同一条纪律：单独一个方法，
   * 不改 content。理由是插图消息的 content 恒为 null，而 mediaId / status /
   * failReason / prompt 是**这条消息的实体**——它们和文本 content 不是一回事，
   * 不该被 editMessage 那条链路一起改。
   *
   * 允许的字段：mediaId / status / failReason / prompt / refNote / degraded。
   * 其他字段一律忽略（不抛）——避免前端在保存回复之外多传点东西就把插图状态改坏。
   *
   * refNote / degraded 是**参考图那条路的可观察信号**：
   * 后端一直在返回它们，可这里不收、消息上没落，前端就永远拿不到——
   * 降级成了一个隐形事件（用户只觉得“模型画得不像”）。
   * 【2026-09-27 补：不落消息的字段，UI 再想显示也显示不出来】
   */
  async setIllustrationStatus(id, messageId, patch = {}) {
    return this.#mutateConv(id, (conv) => {
      const msg = conv.messages.find(m => m.id === messageId);
      if (!msg) throw new Error(`Message not found: ${messageId}`);
      if (patch.mediaId !== undefined) msg.mediaId = patch.mediaId == null ? null : String(patch.mediaId);
      if (patch.status !== undefined) msg.status = String(patch.status);
      if (patch.failReason !== undefined) msg.failReason = patch.failReason == null ? null : String(patch.failReason);
      if (patch.prompt !== undefined) msg.prompt = patch.prompt == null ? null : String(patch.prompt);
      if (patch.refNote !== undefined) msg.refNote = patch.refNote == null ? null : String(patch.refNote);
      if (patch.degraded !== undefined) msg.degraded = patch.degraded === true;
      return msg;
    });
  }

  /**
   * 把「这一轮变量变化」挂到消息上。
   *
   * 挂消息不挂对话：它属于「这一轮发生了什么」，编辑/删除/回退那条消息时
   * 会跟着一起走，不会出现「三轮前的变量变化还挂在这一轮下面」。
   * 上限 12 条、长值截断——账是给人读的，不是归档。
   *
   * 返回**消息本身**（调用方要把它当作 saved 继续传下去），
   * 不依赖 #mutateConv 的返回值——那个约定没写在名字里，不该拿来做接口。
   */
  async setMessageVarDiff(id, messageId, diff) {
    const list = (Array.isArray(diff) ? diff : [])
      .slice(0, 12)
      .map((d) => ({
        name: String(d?.name ?? "").slice(0, 60),
        change: ["add", "set", "remove"].includes(d?.change) ? d.change : "set",
        from: d?.from == null ? null : String(d.from).slice(0, 120),
        to: d?.to == null ? null : String(d.to).slice(0, 120),
        // 服务端拼好的那句话。前端直接印，不再自己拼一份
        text: d?.text == null ? "" : String(d.text).slice(0, 160)
      }))
      .filter((d) => d.name);

    let updated = null;
    await this.#mutateConv(id, (conv) => {
      const msg = (conv.messages || []).find((m) => m.id === messageId);
      if (!msg) throw new Error(`Message not found: ${messageId}`);
      if (list.length === 0) delete msg.varDiff;
      else msg.varDiff = list;
      updated = msg;
      return conv;
    });
    return updated;
  }

  /** 更新对话变量。 */
  async updateVariables(id, variables) {
    return this.#mutateConv(id, (conv) => {
      conv.variables = { ...conv.variables, ...variables };
      return conv;
    });
  }
}

export function createConversationRepo(dataDir) {
  return new ConversationRepo(dataDir);
}
