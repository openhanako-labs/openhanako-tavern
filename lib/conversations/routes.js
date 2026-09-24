// lib/conversations/routes.js — 对话 HTTP 路由
//
// 统一用 route() 包装；SSE 端点用 raw() 绕过 JSON 包装。

import { route, raw, notFound } from "../respond.js";
import { MessageRole } from "./model.js";
import { createMacroProcessor } from "../macros/index.js";
import {
  macroContextFor,
  applyMacrosToCharacter,
  buildGenerationInput as buildGenerationInputShared
} from "./pipeline.js";

// 宏处理器（供消息级宏替换用）
const macros = createMacroProcessor();

export function registerConversationRoutes(app, repo, llm, characterRepo, settingRepo = null, regexRepo = null, presetRepo = null, boardRepo = null) {
  // 列出对话
  app.get("/conversations", route(async () => {
    return repo.list();
  }));

  // 获取对话详情
  app.get("/conversations/:id", route(async (c) => {
    const conv = await repo.get(c.req.param("id"));
    if (!conv) throw notFound("Conversation not found");
    return conv;
  }));

  // 创建对话
  app.post("/conversations", route(async (c) => {
    const body = await c.req.json();
    const { characterId } = body;
    if (!characterId) throw new Error("characterId is required");

    // 读卡拿角色名：列表的兜底链是 title → characterName → （无标题），
    // 不写 characterName 的话，新对话在首条 user 消息出现之前
    // 永远顶着"（无标题）"——存是首条消息触发的，名是创建时就该有的。
    const card = await characterRepo.get(characterId).catch(() => null);
    const conv = await repo.create(characterId, {
      userName: body.userName,
      persona: body.persona,
      characterName: card?.name || ""
    });

    // 开场白：角色卡里写的 first_mes 不该白写。
    //
    // 过去建完对话是空的，要用户先开口——而那段精心写的开场白
    // 一个字都没露面。这里把它作为第一条 assistant 消息发出。
    // 多个开场白时随机选一条，其余存为变体（swipe 可切）。
    if (body.greeting !== false) {
      await seedGreeting(conv.id, characterId);
    }

    return await repo.get(conv.id);
  }));

  /**
   * 给新对话种下开场白。
   *
   * 规则：
   *   - 主开场白 first_mes 作第一条 assistant 消息
   *   - alternate_greetings 全部作为变体附上（含主开场白自己）
   *   - 随机把 variantIndex 指向其中一条，让每次新建对话有变化
   *   - 都没有则不动（保持空对话，不报错）
   */
  async function seedGreeting(convId, characterId) {
    const card = await characterRepo.get(characterId);
    if (!card) return null;

    const primary = String(card.first_mes || "").trim();
    const alternates = (Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [])
      .map(s => String(s || "").trim())
      .filter(Boolean);

    if (!primary && alternates.length === 0) return null;

    // 全部开场白：主开场白优先，去重
    const all = [];
    if (primary) all.push(primary);
    for (const a of alternates) if (!all.includes(a)) all.push(a);
    if (all.length === 0) return null;

    const pick = Math.floor(Math.random() * all.length);
    const chosen = all[pick];

    const msg = await repo.addMessage(convId, MessageRole.ASSISTANT, chosen);

    // 只有多于一条时才建变体列表（单条无需 swipe）
    if (all.length > 1) {
      await repo.setVariants(convId, msg.id, all, pick);
    }
    return msg;
  }

  // 删除对话
  app.delete("/conversations/:id", route(async (c) => {
    await repo.delete(c.req.param("id"));
    return true;
  }));

  // 注：PUT /conversations/:id/variables 曾在此处重复定义（与 lib/variables/routes.js 同名），
  // 两边写同一份数据但返回值不同（conv vs variables），谁生效取决于注册顺序。
  // 已删除此处副本——变量端点归 lib/variables/routes.js 一处。

  // ── 消息级操作 ──

  app.put("/conversations/:id/messages/:messageId", route(async (c) => {
    const id = c.req.param("id");
    const messageId = c.req.param("messageId");
    const { content } = await c.req.json();
    if (typeof content !== "string") throw new Error("content must be a string");
    return repo.editMessage(id, messageId, content);
  }));

  app.delete("/conversations/:id/messages/:messageId", route(async (c) => {
    const id = c.req.param("id");
    const messageId = c.req.param("messageId");
    return repo.deleteMessage(id, messageId);
  }));

  app.put("/conversations/:id/messages/:messageId/variant", route(async (c) => {
    const id = c.req.param("id");
    const messageId = c.req.param("messageId");
    const { index } = await c.req.json();
    return repo.switchVariant(id, messageId, Number(index));
  }));

  /**
   * 更新用户人设。
   *
   * 之前整条链路上只有"建对话时"能传 userName / persona，
   * 之后想改只能删掉重开——而人设本来是会反复调的东西。
   */
  app.put("/conversations/:id/persona", route(async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const conv = await repo.setPersona(id, {
      userName: body.userName,
      persona: body.persona
    });
    if (!conv) throw notFound("Conversation not found");
    return { id: conv.id, userName: conv.userName, persona: conv.persona };
  }));

  // ── 生成 ──

  /** 准备一次生成的公共前置：取对话 + 角色 + 构建请求。 */
  async function prepareGeneration(c) {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const { content, options } = body;

    const conv = await repo.get(id);
    if (!conv) throw notFound("Conversation not found");

    const rawCharacter = await characterRepo.get(conv.characterId);
    if (!rawCharacter) throw notFound("Character not found");

    // 关键：角色卡文本先过宏，后续环节拿到的是已替换的内容
    const character = applyMacrosToCharacter(rawCharacter, conv, {
      userName: body.userName,
      persona: body.persona,
      globalVariables: body.globalVariables
    });

    return { id, content, options, conv, character, rawCharacter, body };
  }

  /** 转发到共享管线（routes 与 Agent 工具共用同一条）。 */
  function buildGenerationInput(conv, character, currentInput, options = {}) {
    return buildGenerationInputShared(
      { settingRepo, regexRepo, conversationRepo: repo, characterRepo, boardRepo },
      conv, character, currentInput, options
    );
  }

  // 发送消息 + 生成回复（非流式）
  app.post("/conversations/:id/messages", route(async (c) => {
    const { id, content, options, conv, character } = await prepareGeneration(c);

    if (!content || typeof content !== "string") {
      throw new Error("content is required");
    }

    await repo.addMessage(id, MessageRole.USER, content);
    const updated = await repo.get(id);

    const opts = await withRealWindow(options || {});
    const input = await buildGenerationInput(updated, character, content, opts);

    let assistantContent = "";
    let genResult = null;
    try {
      genResult = await llm.generate(input.messages, { systemPrompt: input.systemPrompt, ...opts });
      assistantContent = genResult.content;
    } catch (e) {
      assistantContent = `[LLM 错误: ${e.message}]`;
    }

    let saved = await repo.addMessage(id, MessageRole.ASSISTANT, assistantContent);
    saved = await persistUsage(id, saved, genResult);
    persistSummary(id, input.meta);
    return {
      userMessage: updated.messages[updated.messages.length - 1],
      assistantMessage: saved,
      meta: input.meta
    };
  }));

  // 发送消息 + 流式生成回复（SSE）
  app.post("/conversations/:id/messages/stream", route(async (c) => {
    const { id, content, options, conv, character } = await prepareGeneration(c);

    if (!content || typeof content !== "string") {
      throw new Error("content is required");
    }

    await repo.addMessage(id, MessageRole.USER, content);
    const updated = await repo.get(id);

    const opts = await withRealWindow(options || {});
    const input = await buildGenerationInput(updated, character, content, opts);

    return raw(createSseStream(async (send) => {
      let fullContent = "";
      let cancelled = false;
      let doneEvent = null;

      // 客户端断开（用户点停止 / 关闭页面）时通知模型层取消，避免白烧 token
      const onAbort = () => {
        cancelled = true;
        try { llm.cancel?.(); } catch { /* 取消失败不阻塞 */ }
      };
      try {
        c.req.raw.signal?.addEventListener("abort", onAbort, { once: true });
      } catch { /* 拿不到 signal 时降级：只前端断开 */ }

      try {
        for await (const event of llm.streamEvents(input.messages, { systemPrompt: input.systemPrompt, ...opts })) {
          if (cancelled) break;
          if (event.type === "text-delta") {
            fullContent += event.delta;
            send({ type: "delta", content: event.delta });
          } else if (event.type === "reasoning-delta") {
            send({ type: "reasoning", content: event.delta });
          } else if (event.type === "done") {
            doneEvent = event;
            const full = (event.assistant?.content || [])
              .filter(part => part.type === "text")
              .map(part => part.text)
              .join("");
            if (full) fullContent = full;
            send({ type: "usage", usage: event.usage ?? null, stopReason: event.stopReason });
          }
        }
      } catch (e) {
        // 取消导致的异常不当作错误上报
        if (!cancelled) {
          send({ type: "error", error: e?.message || String(e) });
        }
      }

      // 已取消：不落盘（半截回复不入库），只告诉前端停在哪
      if (cancelled) {
        send({ type: "cancelled", content: fullContent });
        return;
      }

      let saved = await repo.addMessage(id, MessageRole.ASSISTANT, fullContent);
      saved = await persistUsage(id, saved, {
        usage: doneEvent?.usage ?? null,
        rawContent: Array.isArray(doneEvent?.assistant?.content)
          ? doneEvent.assistant.content.map(c => ({ ...c }))
          : null,
        model: llm.lastTarget?.model || null,
        reasoning: extractReasoning(doneEvent?.assistant)
      });
      send({ type: "done", content: fullContent, message: saved });
    }), { contentType: "text/event-stream" });
  }));

  // 重新生成（非流式）
  app.post("/conversations/:id/regenerate", route(async (c) => {
    const { id, options, conv, character } = await prepareGeneration(c);

    const lastAssistant = [...conv.messages].reverse().find(m => m.role === MessageRole.ASSISTANT);
    const { removed } = await repo.truncateAfterLastUser(id);
    const fresh = await repo.get(id);

    const lastUser = [...fresh.messages].reverse().find(m => m.role === MessageRole.USER);
    const opts = await withRealWindow(options || {});
    const input = await buildGenerationInput(fresh, character, lastUser?.content || "", opts);

    let assistantContent = "";
    let genResult = null;
    try {
      genResult = await llm.generate(input.messages, { systemPrompt: input.systemPrompt, ...opts });
      assistantContent = genResult.content;
    } catch (e) {
      assistantContent = `[LLM 错误: ${e.message}]`;
    }

    let saved = await repo.addMessage(id, MessageRole.ASSISTANT, assistantContent);
    await attachVariant(repo, id, saved, lastAssistant, assistantContent);
    saved = await persistUsage(id, saved, genResult);
    persistSummary(id, input.meta);

    return { removed, message: saved, content: assistantContent, meta: input.meta };
  }));

  // 重新生成（流式）
  app.post("/conversations/:id/regenerate/stream", route(async (c) => {
    const { id, options, conv, character } = await prepareGeneration(c);

    const lastAssistant = [...conv.messages].reverse().find(m => m.role === MessageRole.ASSISTANT);
    await repo.truncateAfterLastUser(id);
    const fresh = await repo.get(id);

    const lastUser = [...fresh.messages].reverse().find(m => m.role === MessageRole.USER);
    const opts = await withRealWindow(options || {});
    const input = await buildGenerationInput(fresh, character, lastUser?.content || "", opts);

    return raw(createSseStream(async (send) => {
      let fullContent = "";
      let doneEvent = null;

      for await (const event of llm.streamEvents(input.messages, { systemPrompt: input.systemPrompt, ...opts })) {
        if (event.type === "text-delta") {
          fullContent += event.delta;
          send({ type: "delta", content: event.delta });
        } else if (event.type === "done") {
          doneEvent = event;
          const full = (event.assistant?.content || [])
            .filter(part => part.type === "text")
            .map(part => part.text)
            .join("");
          if (full) fullContent = full;
        }
      }

      let saved = await repo.addMessage(id, MessageRole.ASSISTANT, fullContent);
      await attachVariant(repo, id, saved, lastAssistant, fullContent);
      saved = await persistUsage(id, saved, {
        usage: doneEvent?.usage ?? null,
        rawContent: Array.isArray(doneEvent?.assistant?.content)
          ? doneEvent.assistant.content.map(c => ({ ...c }))
          : null,
        model: llm.lastTarget?.model || null,
        reasoning: extractReasoning(doneEvent?.assistant)
      });
      persistSummary(id, input.meta);
      send({ type: "done", content: fullContent, message: saved });
    }), { contentType: "text/event-stream" });
  }));

  // 获取角色列表（用于创建对话）
  app.get("/characters-for-conv", route(async () => {
    return characterRepo.list();
  }));

  /**
   * 世界书激活预览：看“为什么这条被激活 / 为什么没被”。
   * 对应 DiceFrame 的 /api/lorebooks/activation-preview。
   */
  app.post("/conversations/:id/activation-preview", route(async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));

    const conv = await repo.get(id);
    if (!conv) throw notFound("Conversation not found");

    if (!settingRepo) return { available: false, note: "设定库未就绪" };

    // 与真生成同一步：先按角色隔离，再激活。
    // 不过滤的话「预览说没被激活」和「实际没被激活」不是同一件事。
    const rawChar = await characterRepo.get(conv.characterId).catch(() => null);
    let settings = await settingRepo.list();
    const characterId = conv.characterId || null;
    if (characterId) {
      const { filterForCharacter } = await import("../settings/model.js");
      settings = filterForCharacter(settings, {
        characterId,
        characterName: rawChar?.name || null,
        characterTags: rawChar?.tags || []
      });
    }

    const scanText = body.text !== undefined
      ? String(body.text)
      : buildScanText(conv, "");

    const result = activate(settings, scanText, {
      budget: body.budget ?? 2000,
      includeTrace: true
    });

    return {
      available: true,
      scanTextLength: scanText.length,
      totalSettings: settings.length,
      activated: result.entries.map(e => ({
        id: e.id,
        name: e.name,
        anchor: e.anchor,
        depth: e._depth,
        recursive: !!e._recursive
      })),
      trace: result.trace
    };
  }));

  /**
   * 组装预览：看最终会向模型发什么（不含实际生成）。
   * 调试提示词问题的直接手段。
   */
  app.post("/conversations/:id/prompt-preview", route(async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));

    const conv = await repo.get(id);
    if (!conv) throw notFound("Conversation not found");

    const rawCharacter = await characterRepo.get(conv.characterId);
    if (!rawCharacter) throw notFound("Character not found");

    const character = applyMacrosToCharacter(rawCharacter, conv, {
      userName: body.userName,
      persona: body.persona
    });

    // 预览必须和真生成看同一套输入：少了 preset / 真实窗口，
    // 预览出的是另一份 prompt，拿它调提示词等于调错对象。
    const opts = await withGenerationContext({
      contextWindow: body.contextWindow,
      maxTokens: body.maxTokens
    });

    const input = await buildGenerationInput(conv, character, body.text || "", opts);

    return {
      systemPrompt: input.systemPrompt,
      messages: input.messages,
      meta: input.meta,
      estimatedTokens: estimateTokens(input.systemPrompt)
        + input.messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0)
    };
  }));
}

// ── 内部工具 ──

/** 把旧回复存成变体，保留可回溯性。 */
async function attachVariant(repo, convId, savedMsg, lastAssistant, newContent) {
  if (!lastAssistant?.content || lastAssistant.content === newContent) return;

  await repo.addVariant(convId, savedMsg.id, newContent);
  const updated = await repo.get(convId);
  const target = updated.messages.find(m => m.id === savedMsg.id);
  if (target) {
    target.variants = [lastAssistant.content, newContent];
    target.variantIndex = 1;
    await repo.update(convId, { messages: updated.messages });
  }
}

