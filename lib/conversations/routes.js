// lib/conversations/routes.js — 对话 HTTP 路由
//
// 统一用 route() 包装；SSE 端点用 raw() 绕过 JSON 包装。

import { route, raw, notFound } from "../respond.js";
import { MessageRole } from "./model.js";
import { createMacroProcessor } from "../macros/index.js";
import { activate } from "../lore/index.js";
import { estimateTokens } from "../llm/history.js";
import {
  macroContextFor,
  applyMacrosToCharacter,
  freezeVolatileMacros,
  buildScanText,
  buildGenerationInput as buildGenerationInputShared
} from "./pipeline.js";
import { buildSuggestionInput, parseSuggestions } from "./suggestions.js";

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
  // 设置这一场用哪套预设（null / 空串 = 取消）
  //
  // 校验存在性：挂一个不存在的预设 id，表现是「什么也没发生」——
  // 那是最难查的一类（生成不报错，只是安静地不用预设）。
  app.put("/conversations/:id/preset", route(async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) || {};

    if (!(await repo.get(id))) throw notFound("Conversation not found");

    const presetId = body.presetId ? String(body.presetId) : null;
    if (presetId) {
      if (!presetRepo) throw new Error("预设仓储未就绪");
      const p = await presetRepo.get(presetId).catch(() => null);
      if (!p) throw notFound(`预设不存在: ${presetId}`);
    }

    const updated = await repo.update(id, { presetId });
    return { id: updated.id, presetId: updated.presetId ?? null };
  }));

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

    // 用户输入也先冻结一次性宏——一个咽喉点搞定四条生成路由。
    // 不冻的话落盘的是原文、扫描的是原文、发出去的是原文，
    // 而**读回来**时骰子会重掷一次，三处三个值。
    const frozenContent = freezeVolatileMacros(content, character, conv, {
      userName: body.userName,
      persona: body.persona,
      globalVariables: body.globalVariables
    });

    return { id, content: frozenContent, options, conv, character, rawCharacter, body };
  }

  /**
   * 把「模型真实的上下文窗口」与「这一场的预设」填进 options。
   *
   * 两件事放同一个函数，是因为它们都是「调用方不知道 / 不该知道，
   * 但每次生成都必须一致」的东西：
   *
   *   窗口：调用方给的 contextWindow 往往是界面上的期望值，真正决定能塞多少
   *     的是**当前目标模型自己报的窗口**——目录里模型动辄 32K–128K，
   *     写死 8000 等于自愿只用零头。拿不到就退回调用方给的值。
   *
   *   预设：**跟随对话**（conv.presetId），调用方显式给了就听调用方的。
   *     解析放在这里而不是各个路由里，是为了让**生成与预览走同一条**。
   *     两边各解析一次的话，预览出来的 prompt 不是真发出去的那份，
   *     拿它调提示词等于调错对象。
   *
   * ⚠️ 这个函数一度只剩调用、定义整段消失（重建时被 read 分页截掉）。
   * 于是四条生成路由一被调用就 ReferenceError——也就是说
   * **发消息这个主操作从路由层整个是死的**，而工具路径不经过它，
   * 所以从工具那边看一切正常。
   * 教训：难测的那一段（需要真 llm）正是最容易烂掉的那一段。
   */
  async function withRealWindow(options = {}, conv = null) {
    const opts = { ...(options || {}) };

    try {
      const win = await llm?.resolveContextWindow?.(opts.model || null);
      if (Number(win) > 0) opts.contextWindow = Number(win);
    } catch {
      /* 拿不到就用调用方给的 */
    }

    if (!opts.preset && presetRepo) {
      const pid = opts.presetId || conv?.presetId || null;
      if (pid) {
        try {
          const p = await presetRepo.get(pid);
          if (p) {
            opts.preset = p;
            opts.presetId = p.id;
          }
        } catch {
          /* 预设读不到就按无预设走，不阻塞生成 */
        }
      }
    }

    return opts;
  }

  /**
   * 落盘本轮用量（usage / 签名 / 模型 / 推理）。
   *
   * 失败不抛：用量是**观测面**，写不进去不该毁掉一整轮已经生成好的回复
   *（那才是用户真在乎的东西）。
   */
  async function persistUsage(convId, savedMsg, genResult) {
    if (!savedMsg?.id) return savedMsg;
    const patch = {};
    if (genResult?.usage !== undefined) patch.usage = genResult.usage;
    if (genResult?.rawContent !== undefined) patch.rawContent = genResult.rawContent;
    if (genResult?.model !== undefined) patch.model = genResult.model;
    if (genResult?.reasoning !== undefined) patch.reasoning = genResult.reasoning;
    if (Object.keys(patch).length === 0) return savedMsg;
    try {
      return await repo.setMessageUsage(convId, savedMsg.id, patch);
    } catch (e) {
      console.error("[usage] 落盘失败（不阻塞本轮）:", e);
      return savedMsg;
    }
  }

  /**
   * 摘要写回。管线只给出建议值（meta.summaryPatch），落盘是路由的事。
   *
   * 调用点是 fire-and-forget（没有 await），所以这里的 try/catch
   * 不是为了「返回值」，是为了**不让一个未处理的 rejection 掀掉进程**。
   */
  async function persistSummary(convId, meta) {
    const patch = meta?.summaryPatch;
    if (!patch) return;
    try {
      await repo.update(convId, { summary: patch });
    } catch (e) {
      console.error("[summary] 落盘失败（不影响本轮）:", e);
    }
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

    const opts = await withRealWindow(options || {}, conv);
    const input = await buildGenerationInput(updated, character, content, opts);

    let assistantContent = "";
    let genResult = null;
    try {
      genResult = await llm.generate(input.messages, { systemPrompt: input.systemPrompt, ...opts });
      assistantContent = genResult.content;
    } catch (e) {
      assistantContent = `[LLM 错误: ${e.message}]`;
    }

    let saved = await repo.addMessage(id, MessageRole.ASSISTANT, freezeVolatileMacros(assistantContent, character, conv));
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

    const opts = await withRealWindow(options || {}, conv);
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

      let saved = await repo.addMessage(id, MessageRole.ASSISTANT, freezeVolatileMacros(fullContent, character, conv));
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
    const opts = await withRealWindow(options || {}, conv);
    const input = await buildGenerationInput(fresh, character, lastUser?.content || "", opts);

    let assistantContent = "";
    let genResult = null;
    try {
      genResult = await llm.generate(input.messages, { systemPrompt: input.systemPrompt, ...opts });
      assistantContent = genResult.content;
    } catch (e) {
      assistantContent = `[LLM 错误: ${e.message}]`;
    }

    let saved = await repo.addMessage(id, MessageRole.ASSISTANT, freezeVolatileMacros(assistantContent, character, conv));
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
    const opts = await withRealWindow(options || {}, conv);
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

      let saved = await repo.addMessage(id, MessageRole.ASSISTANT, freezeVolatileMacros(fullContent, character, conv));
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

    // 预览必须和真生成看同一套输入：两边各拼一次的话，预览出来的 prompt
    // 不是真发出去的那份，拿它调提示词等于调错对象。
    // 预设跟对话走，所以这里也把 conv 传进去——预览看到的就是这一场真会用的。
    const opts = await withRealWindow({
      contextWindow: body.contextWindow,
      maxTokens: body.maxTokens
    }, conv);

    const input = await buildGenerationInput(conv, character, body.text || "", opts);

    return {
      systemPrompt: input.systemPrompt,
      messages: input.messages,
      meta: input.meta,
      // 账：谁进了（+多大+是不是必需）、谁没进（+为什么）、有什么警告。
      // 验收看账不看正文——人眼看拼好的文本，对不出「该进没进」。
      audit: input.audit,
      estimatedTokens: estimateTokens(input.systemPrompt)
        + input.messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0)
    };
  }));

  // 行动候选项：**独立一次调用**，结果挂在消息上，**不进正文 prompt**。
  //
  // 这条界线不能移：候选项一旦进了正文 prompt，每轮前面就多一段会变的东西，
  // 前缀缓存从那里往后全废，而且是静默的（没人报错，只会发现命中率莫名很低）。
  // 它不是「正文的一部分」，是「正文之后可选的岔路」。
  app.post("/conversations/:id/suggestions", route(async (c) => {
    const id = c.req.param("id");
    const conv = await repo.get(id);
    if (!conv) throw notFound("Conversation not found");

    const character = await characterRepo?.get?.(conv.characterId);
    const input = buildSuggestionInput(character, conv, {});

    const r = await llm.generate(input.messages, {
      systemPrompt: input.systemPrompt,
      maxTokens: 400,
      temperature: 1.0
    });
    const parsed = parseSuggestions(r?.content || "");

    // 挂在最后一条 assistant 消息上：它属于「这一轮之后能做什么」。
    // 解析失败就不挂——空手比挂一堆「旁白」强。
    //
    // 没有 assistant 消息时（新对话、还一句都没说）候选项无处可存：
    // 那就如实说，而不是返回一堆界面根本没地方挂的选项。
    const lastAssistant = [...(conv.messages || [])].reverse().find(m => m.role === MessageRole.ASSISTANT);
    if (!lastAssistant) {
      return {
        items: [],
        dropped: [],
        note: "这一场还没有回复——候选项是「这一轮之后能做什么」，先发一条消息",
        attachedTo: null,
        model: null
      };
    }

    let attachedTo = null;
    if (parsed.items.length > 0) {
      await repo.setMessageSuggestions(id, lastAssistant.id, parsed.items);
      attachedTo = lastAssistant.id;
    }

    return {
      items: parsed.items,
      dropped: parsed.dropped,
      note: parsed.note,
      attachedTo,
      model: r?.target?.model || llm.lastTarget?.model || null
    };
  }));
}

// ── 内部工具 ──
//
// ⚠️ 这一段曾经整段消失过（重建时被 read 分页截掉），只留下 6 处调用，
// 而它们都在同一个文件的另一端：
//   persistUsage / persistSummary / createSseStream / extractReasoning /
//   withGenerationContext / withRealWindow
// 于是四条生成路由一被调用就 ReferenceError——**「发消息」这个主操作
// 从路由层整个是死的**；而 Agent 工具路径不经过它们，所以从那边看一切正常。
//
// 教训：定义与调用点分居文件两端时，截断只会带走其中一端。
// 前端有一条 check-undefined-refs 专治这个病，但它只扫 ui/assets/modules/；
// 服务端从来没查过。现已补上同名检查（test/check-server-undef.mjs）。

/**
 * 把「往客户端推事件」包成一个 SSE Response。
 *
 * handler 拿到一个 send(obj) 就推；末尾自动收流。
 * handler 抛错时把错误也推成一条事件——前端已有 type:"error" 分支，
 * 静默断流才是最难查的那种（页面停在半截回复上，不知道发生了什么）。
 *
 * 与 respond.js 的分工：返回 Response 时 raw() 会原样交出，
 * 所以这里自己造 response，不走 c.body 的字符串路径。
 * 前端按 `data: {json}\n\n` 逐行解（chat.js 的 reader 里就是 split("\n") +
 * startsWith("data: ")），格式必须与它对齐。
 */
function createSseStream(handler) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;

      const send = (obj) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true;   // 客户端已断开：后面再推也不用试了
        }
      };

      try {
        await handler(send);
      } catch (e) {
        send({ type: "error", error: e?.message || String(e) });
      } finally {
        closed = true;
        try { controller.close(); } catch { /* 已经关了 */ }
      }
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no"
    }
  });
}

/**
 * 从 assistant 的结构化内容里取推理段。
 * 没有 reasoning 段返回 null——「没有」与「空」要能分开。
 */
function extractReasoning(assistant) {
  const parts = assistant?.content;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .filter(p => p?.type === "reasoning")
    .map(p => String(p.text ?? ""))
    .join("");
  return text || null;
}

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

