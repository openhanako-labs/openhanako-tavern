// lib/llm/service.js — LLM 服务（真流式：sdk.models.stream + readAppModelStream）
//
// 契约要点（sdk/app-contract/models.d.ts）：
//   - models.stream(request) → Promise<Response>（NDJSON body），不是 async iterable
//   - request 必填 requestId / provider / model；system 走 systemPrompt 参数，不在 messages 里
//   - user.content 可以是 string；assistant.content 必须是 [{type:"text",text}] 数组
//   - 事件流用 readAppModelStream(response) 解码（宿主提供，含 UTF-8 / 分片 / 终止校验）
//
// 降级：stream 不可用时退回 models.utility()（辅助模型，不支持 provider/model 选择）。

import { readAppModelStream } from "../../sdk/app-contract/model-stream.js";

const DEFAULT_SYSTEM_PROMPT = `你是一个角色扮演 AI。根据角色设定和对话历史，生成符合角色性格的回复。

规则：
- 保持角色一致性
- 回复自然流畅
- 避免跳出角色
- 使用角色设定的语言和风格`;

const CATALOG_TTL_MS = 60_000;

/**
 * 等待模型开始响应的上限。
 *
 * 宿主模型层异常时，models.stream() / utility() 都会静默挂住——
 * 没有这个上限，用户点发送后界面会无限期转圈。
 * 实测（2026-09-23）两个不同 provider 的调用都超 60s 未返回。
 */
const STREAM_START_TIMEOUT_MS = 60_000;

/**
 * 从宿主模型目录条目里提取 provider / model 标识。
 *
 * 实测字段形状（models.list() 返回）：
 *   { id, name, provider, input, reasoning, contextWindow, maxTokens, ... }
 * 注意：模型标识在 `id`，**不是** `model`。
 */
function pickTarget(info) {
  if (!info || typeof info !== "object") return null;
  const provider = info.provider ?? info.providerId ?? info.provider_id;
  const model = info.id ?? info.model ?? info.modelId ?? info.model_id;
  if (typeof provider === "string" && provider && typeof model === "string" && model) {
    return { provider, model, info };
  }
  return null;
}

/**
 * 标识符是否可直接送 stream。
 *
 * 宿主 stream 契约：provider 与 model 都要求 1-128 个 ASCII 标识符字符。
 * 实测目录里会出现：
 *   provider: "新疆幻城"、"command code"   ← 宿主拒绝
 *   model:    "BAAI/bge-m3"、"deepseek/deepseek-v4.1-flash"  ← 宿主拒绝
 * 这些条目在目录里合法存在，但**送进 stream 会被拒**，所以优先避开。
 */
function isStreamSafe(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

/**
 * 明显不能用于角色对话的模型。
 *
 * ⚠️ 只按“能力”判，不按字符集判——字符集的事交给 isStreamSafe。
 */
const NON_CHAT_PATTERN = /(embed|embedding|rerank|bge-|whisper|tts|moderation|\bocr\b)/i;

function looksNonChat(model, info) {
  if (NON_CHAT_PATTERN.test(String(model || ""))) return true;

  const i = info || {};
  // 目录条目声明的模态：input 只有非 text 的
  if (Array.isArray(i.input) && i.input.length > 0 && !i.input.includes("text")) return true;
  if (i.maxTokens === null || i.maxOutput === null) return true;

  return false;
}

/**
 * 从目录里挑出可用于对话的候选，按优先级排序。
 *
 * ⚠️ 不能盲选第一个：真实目录第一项是 `BAAI/bge-m3`（embedding），
 *    盲选会让每次生成都失败。
 *
 * 优先级：
 *   1. 对话模型 + 标识符 stream-safe
 *   2. 对话模型（标识符不 safe，但至少不是 embedding）
 *   3. 任意条目（完全不降级）
 */
export function pickChatTargets(catalog) {
  const all = (Array.isArray(catalog) ? catalog : []).map(pickTarget).filter(Boolean);
  const chat = all.filter(t => !looksNonChat(t.model, t.info));
  const safe = chat.filter(t => isStreamSafe(t.provider) && isStreamSafe(t.model));

  if (safe.length > 0) return safe;
  if (chat.length > 0) return chat;
  return all;
}

/**
 * 把内部消息数组转换为 stream 契约要求的形状。
 * - system 角色消息合并进 systemPrompt（契约的 messages 里没有 system role）
 * - assistant 的 content 转为 [{type:"text", text}]
 * - 跳过空内容
 */
export function toStreamMessages(messages = [], opts = {}) {
  const systemParts = [];
  const converted = [];

  for (const m of messages) {
    const text = typeof m?.content === "string" ? m.content : "";
    if (!text) continue;

    if (m.role === "system") {
      systemParts.push(text);
      continue;
    }
    if (m.role === "assistant") {
      // 回传原始回合（含各段 textSignature / reasoning）是缓存复用的前提。
      // assistantContentFor 会在文本被改过时自动回退成无签名的纯文本——
      // 带错的签名比不带更糟：provider 会拿它去命中一个对不上的前缀。
      converted.push({
        role: "assistant",
        content: assistantContentFor(m, { currentModel: opts.currentModel || null })
      });
      continue;
    }
    converted.push({ role: "user", content: text });
  }

  return { messages: converted, extraSystem: systemParts.join("\n\n") };
}

/**
 * 从完整 assistant 回合中提取文本签名。
 *
 * @deprecated 单签名 + join 文本会失配（多段 text 时）。
 *   新代码用 assistantContentFor() 回传整段原始回合。
 */
export function extractSignature(assistant) {
  if (!assistant?.content) return null;
  const texts = assistant.content.filter(c => c.type === "text" && c.textSignature);
  if (!texts.length) return null;
  return texts[texts.length - 1].textSignature || null;
}

/**
 * 从原始回合里抽出纯文本（用于与当前 content 比对）。
 */
export function textOfAssistantContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter(c => c?.type === "text")
    .map(c => c.text || "")
    .join("");
}

/**
 * 判断一条已存消息的原始回合是否仍可回传。
 *
 * 这是签名有效性的**唯一判定点**。不依赖写入方记得清字段：
 * 只要 content 与原始回合的文本不一致，就说明文本被改过
 * （宏替换 / 用户编辑 / 切换变体 / 世界书前缀注入），签名失效。
 *
 * 另外还检查 _prefixBroken：头部被裁剪或插入摘要后，
 * 保留消息前面接的不再是原来那段，签名同样失效。
 *
 * @param {{content?: string, rawContent?: unknown, _prefixBroken?: boolean}} msg
 * @returns {boolean}
 */
export function isRawContentValid(msg) {
  if (!msg || !Array.isArray(msg.rawContent) || msg.rawContent.length === 0) return false;
  // 前缀被破坏 → 签名描述的序列已经不在了。
  // 宁可不带，也不带一个可能命中错误缓存的指纹。
  if (msg._prefixBroken) return false;
  const original = textOfAssistantContent(msg.rawContent);
  if (!original) return false;
  return typeof msg.content === "string" && msg.content === original;
}

/**
 * 为一条消息组装可回传的 assistant content。
 *
 * 优先用原始回合（含各段签名与推理）；失效或缺失时回退成
 * 单段纯文本——不带签名，但至少内容对。
 *
 * @param {{role?: string, content?: string, rawContent?: unknown}} msg
 * @param {{model?: string|null, currentModel?: string|null}} [opts]
 * @returns {Array<{type: string, [k: string]: unknown}>}
 */
export function assistantContentFor(msg, opts = {}) {
  const text = typeof msg?.content === "string" ? msg.content : "";

  // 换模型后旧签名语义不通，直接回退纯文本
  if (opts.currentModel && msg?.model && msg.model !== opts.currentModel) {
    return [{ type: "text", text }];
  }

  if (isRawContentValid(msg)) {
    return msg.rawContent.map(c => ({ ...c }));
  }

  return [{ type: "text", text }];
}

/**
 * 从完整 assistant 回合中提取推理内容。
 * 保留 signature 与 redacted，供支持推理回放的 provider 使用。
 */
export function extractReasoning(assistant) {
  if (!assistant?.content) return null;
  const rs = assistant.content.filter(c => c.type === "reasoning");
  if (!rs.length) return null;
  return rs.map(r => ({
    reasoning: r.reasoning,
    signature: r.signature ?? null,
    redacted: r.redacted ?? false
  }));
}

/** 转换为 utility 契约要求的形状（支持 system role，content 可为 string）。 */
export function toUtilityMessages(messages = [], systemPrompt = "") {
  const out = [];
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });
  for (const m of messages) {
    if (!m?.content) continue;
    out.push({ role: m.role, content: String(m.content) });
  }
  return out;
}

export class LLMService {
  constructor(sdk) {
    this.sdk = sdk;
    this.models = sdk?.models;
    this.streamAvailable = !!this.models && typeof this.models.stream === "function";
    this.utilityAvailable = !!this.models && typeof this.models.utility === "function";
    this.available = this.streamAvailable || this.utilityAvailable;

    this._catalog = null;
    this._catalogAt = 0;
    this._activeRequestId = null;
    this._lastTarget = null;
  }

  /** 拉取宿主模型目录（默认缓存 60 秒）。 */
  async listModels(force = false) {
    if (!this.streamAvailable) return [];
    const now = Date.now();
    if (!force && this._catalog && now - this._catalogAt < CATALOG_TTL_MS) {
      return this._catalog;
    }
    const result = await this.models.list();
    const models = Array.isArray(result?.models) ? result.models : [];
    this._catalog = models;
    this._catalogAt = now;
    return models;
  }

  /** 解析可用的 {provider, model}。preferred 可传 {provider, model} 或 model 字符串。 */
  async resolveTarget(preferred = null) {
    const models = await this.listModels();
    // ⚠️ 过滤掉 embedding / 图像 / 视频模型与非法模型名——
    //    目录第一项常是 embedding，盲选会让每次生成都失败。
    const targets = pickChatTargets(models);

    if (targets.length === 0) {
      throw new Error("宿主模型目录里没有可用于对话的模型（可能只配置了 embedding / 图像 / 视频模型）");
    }

    if (preferred) {
      const wantProvider = typeof preferred === "string" ? null : preferred.provider;
      const wantModel = typeof preferred === "string" ? preferred : preferred.model;
      const hit = targets.find(t =>
        (!wantProvider || t.provider === wantProvider) &&
        (!wantModel || t.model === wantModel)
      );
      if (hit) return { provider: hit.provider, model: hit.model };
      // 指定的模型不存在时退回第一个，并记录，避免整条链路挂掉
    }

    const first = targets[0];
    return { provider: first.provider, model: first.model };
  }

  /**
   * 真流式生成。逐事件 yield。
   * @returns AsyncGenerator<{type, ...}>
   */
  async *streamEvents(messages, options = {}) {
    if (!this.streamAvailable) {
      throw new Error("sdk.models.stream() 不可用");
    }

    const {
      systemPrompt = DEFAULT_SYSTEM_PROMPT,
      maxTokens = 1000,
      temperature = 0.8,
      target = null,
      signal = undefined
    } = options;

    const resolved = await this.resolveTarget(target);
    this._lastTarget = resolved;

    // 传当前模型标识：与消息上记录的模型不一致时，
    // assistantContentFor 会自动放弃旧签名（换了模型，旧签名语义不通）。
    const { messages: converted, extraSystem } = toStreamMessages(messages, {
      currentModel: resolved.model
    });
    const fullSystem = [systemPrompt, extraSystem].filter(Boolean).join("\n\n");

    const requestId = `eleckoi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._activeRequestId = requestId;

    const request = {
      requestId,
      provider: resolved.provider,
      model: resolved.model,
      messages: converted,
      systemPrompt: fullSystem,
      maxTokens,
      temperature
    };

    let response;
    try {
      response = await this._withTimeout(
        this.models.stream(request),
        STREAM_START_TIMEOUT_MS,
        "模型未响应"
      );
    } catch (e) {
      this._activeRequestId = null;
      throw new Error(`models.stream() 调用失败: ${e?.message || e}`);
    }

    try {
      for await (const event of readAppModelStream(response, signal ? { signal } : undefined)) {
        yield event;
      }
    } finally {
      this._activeRequestId = null;
    }
  }

  /**
   * 流式生成并逐块回调（保持旧签名兼容）。
   * @returns {Promise<{content, usage, stopReason, target}>}
   */
  async generateStream(messages, options = {}, onChunk) {
    const { target = null, ...rest } = options;
    let content = "";
    let usage = null;
    let stopReason = null;
    let assistant = null;

    try {
      for await (const event of this.streamEvents(messages, { ...rest, target })) {
        if (event.type === "text-delta") {
          content += event.delta;
          try {
            onChunk?.(event.delta);
          } catch { /* 回调异常不影响生成 */ }
        } else if (event.type === "done") {
          stopReason = event.stopReason;
          usage = event.usage ?? null;
          // done 事件带完整 assistant 轮次；以它为准回填，避免分片丢字
          assistant = event.assistant ?? null;
          const full = (assistant?.content || [])
            .filter(c => c.type === "text")
            .map(c => c.text)
            .join("");
          if (full) content = full;
        }
      }
      return {
        content,
        usage,
        stopReason,
        assistant,
        // 原始回合：含各段 textSignature / reasoning，存下来供下轮回传。
        // 不再只存"最后一段的签名"——那是钥匙和锁不配对。
        rawContent: Array.isArray(assistant?.content) ? assistant.content.map(c => ({ ...c })) : null,
        model: this._lastTarget?.model || null,
        reasoning: extractReasoning(assistant),
        target: this._lastTarget
      };
    } catch (e) {
      // 已收到部分内容时保留，避免用户白等
      if (content) {
        return { content, usage, stopReason: "error", error: e?.message, target: this._lastTarget };
      }
      // 完全没内容 → 降级到 utility
      if (this.utilityAvailable) {
        return await this._generateViaUtility(messages, rest, onChunk);
      }
      throw e;
    }
  }

  /** 一次性生成（内部走流式，聚合结果）。 */
  async generate(messages, options = {}) {
    if (this.streamAvailable) {
      return await this.generateStream(messages, options);
    }
    if (this.utilityAvailable) {
      return await this._generateViaUtility(messages, options);
    }
    throw new Error("无可用的模型能力（stream / utility 均不可用）");
  }

  /** 降级路径：辅助文本模型（不支持 provider/model 选择）。 */
  async _generateViaUtility(messages, options = {}, onChunk) {
    const {
      systemPrompt = DEFAULT_SYSTEM_PROMPT,
      maxTokens = 1000,
      temperature = 0.8
    } = options;

    const requestId = `eleckoi-utility-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._activeRequestId = requestId;

    try {
      const result = await this._withTimeout(
        this.models.utility({
          requestId,
          scope: "app",
          messages: toUtilityMessages(messages, systemPrompt),
          maxTokens,
          temperature
        }),
        STREAM_START_TIMEOUT_MS,
        "辅助模型未响应"
      );
      const text = result?.text || "";
      if (text) {
        try {
          onChunk?.(text);
        } catch { /* ignore */ }
      }
      return { content: text, usage: null, stopReason: "stop", degraded: "utility" };
    } finally {
      this._activeRequestId = null;
    }
  }

  /** 当前/最近一次解析出的目标（供调用方回写模型标识）。 */
  get lastTarget() {
    return this._lastTarget;
  }

  /**
   * 给一个 Promise 加超时。
   *
   * 为什么必须有：宿主模型层不响应时，models.stream() 会**永远挂着**——
   * 没有超时保护的话，用户点发送后界面无限期转圈，连错误都看不到。
   * 实测宿主层异常时，stream 与 utility 两条路径都会静默挂住。
   */
  _withTimeout(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label}（超过 ${Math.round(ms / 1000)} 秒）`));
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /** 取消当前进行中的请求。 */
  async cancel() {
    const id = this._activeRequestId;
    if (!id || typeof this.models?.cancel !== "function") return false;
    try {
      await this.models.cancel(id);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 解析当前目标模型的真实上下文窗口。
   *
   * 过去调用方写死 8000，而目录里模型动辄 32K–128K——
   * 等于自愿只用零头。取不到时返回 null，由调用方兜底。
   */
  async resolveContextWindow(preferred = null) {
    try {
      const target = await this.resolveTarget(preferred);
      const models = await this.listModels();
      const hit = models.find(m => pickTarget(m)?.model === target?.model);
      const win = Number(hit?.contextWindow);
      return Number.isFinite(win) && win > 0 ? win : null;
    } catch {
      return null;
    }
  }

  /** 诊断信息（供探针 / 管理界面使用）。 */
  async describe() {
    const info = {
      streamAvailable: this.streamAvailable,
      utilityAvailable: this.utilityAvailable,
      activeRequestId: this._activeRequestId,
      lastTarget: this._lastTarget
    };
    if (this.streamAvailable) {
      try {
        const models = await this.listModels(true);
        info.catalogSize = models.length;
        info.catalogSample = models.slice(0, 3);
        info.resolvedTargets = models.map(pickTarget).filter(Boolean).slice(0, 5);
      } catch (e) {
        info.catalogError = e?.message || String(e);
      }
    }
    return info;
  }
}

export function createLLMService(sdk) {
  return new LLMService(sdk);
}
