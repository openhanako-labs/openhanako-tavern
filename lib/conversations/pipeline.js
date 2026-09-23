// lib/conversations/pipeline.js — 生成管线（路由与工具共用）
//
// ⚠️ 为什么抽出来：
//   原先 HTTP 路由与 Agent 工具各有一套生成逻辑，且**已经分叉**——
//   路由走新的世界书引擎（宏替换 / activate / 锚点分流 / 历史预算 / 正则），
//   工具走旧的 getActiveSettings + shouldTrigger（纯子串匹配）。
//   结果：通过工具发消息，整轮 C1/C3/C4/D2 全都不生效。
//
//   两条路径必须共用同一条管线，否则「修好的功能」会有一半入口用不上。

import { createMacroProcessor, contextFromCharacter } from "../macros/index.js";
import { activate, renderEntries, groupByAnchor } from "../lore/index.js";
import { renderAnchoredLore, injectByAnchor } from "../lore/inject.js";
import { composeFromPreset } from "../presets/model.js";
import { prepareHistory, allocateBudget, estimateTokens } from "../llm/history.js";// 宏处理器（无状态，可复用）
const macros = createMacroProcessor();

/** 构建角色卡的宏上下文。 */
export function macroContextFor(character, conv, extra = {}) {
  return contextFromCharacter(character, {
    userName: extra.userName || conv?.userName || "User",
    persona: extra.persona || conv?.persona || "",
    variables: conv?.variables || {},
    globalVariables: extra.globalVariables || {},
    onVariableChange: extra.onVariableChange
  });
}

/** 把角色卡的文本字段做宏替换，返回新卡对象。 */
export function applyMacrosToCharacter(character, conv, extra = {}) {
  if (!character) return character;
  const ctx = macroContextFor(character, conv, extra);
  return macros.processFields(
    character,
    ["description", "personality", "scenario", "first_mes", "mes_example",
     "system_prompt", "post_history_instructions"],
    ctx
  );
}

/** 构建扫描文本：世界书看的是"最近发生了什么"。 */
export function buildScanText(conv, currentInput = "") {
  const recent = (conv?.messages || []).slice(-8)
    .map(m => String(m.content || ""))
    .join("\n");
  return `${recent}\n${currentInput}`.trim();
}

/** 基础系统提示（角色卡没有 system_prompt 时的兜底）。 */
export function buildSystemPrompt(character) {
  const parts = [];
  if (character?.name) parts.push(`你是${character.name}。`);
  if (character?.description) parts.push(character.description);
  if (character?.personality) parts.push(`性格：${character.personality}`);
  if (character?.scenario) parts.push(`场景：${character.scenario}`);
  return parts.join("\n\n") || "你是一个角色扮演 AI。";
}

/** 组装系统提示：角色卡 + 世界书（整体前置类锚点）。 */
export function composeSystemPrompt(character, loreText) {
  const base = character?.system_prompt || buildSystemPrompt(character);
  if (!loreText) return base;
  return `${base}\n\n## 世界设定\n${loreText}`;
}

/**
 * 按预设组装系统提示。
 *
 * 与 composeSystemPrompt 的区别：后者顺序写死，前者由预设的块顺序决定。
 * 未传预设时回退到旧行为，保证不传也不坏。
 *
 * @returns {{ systemPrompt: string, inChatBlocks: object[], usedPreset: string|null }}
 */
export function composeWithPreset(preset, ctx = {}) {
  if (!preset) {
    return {
      systemPrompt: composeSystemPrompt(ctx.character, ctx.loreText),
      inChatBlocks: [],
      usedPreset: null
    };
  }
  const r = composeFromPreset(preset, ctx);
  return { systemPrompt: r.systemPrompt, inChatBlocks: r.inChatBlocks, usedPreset: preset.id || null };
}

/**
 * 世界书激活。
 *
 * 激活前先按角色过滤：绑定到别的角色的条目不该在这里参与匹配。
 *
 * @param {object} settingRepo
 * @param {object} conv
 * @param {string} scanText
 * @param {object} [opts]
 * @param {string} [opts.characterId] - 当前角色 id（用于隔离）
 * @param {string} [opts.characterName]
 * @param {string[]} [opts.characterTags]
 * @returns {null|{text,count,entries,byAnchor,anchoredText,trace,used}}
 */
export async function activateLore(settingRepo, conv, scanText, opts = {}) {
  if (!settingRepo) return null;

  let settings;
  try {
    settings = await settingRepo.list();
  } catch {
    return null;
  }
  if (!settings || settings.length === 0) return null;

  // 角色隔离：不隔离的话，A 卡导入的世界书会在 B 卡的对话里乱触发。
  const characterId = opts.characterId !== undefined ? opts.characterId : conv?.characterId;
  if (characterId) {
    const { filterForCharacter } = await import("../settings/model.js");
    settings = filterForCharacter(settings, {
      characterId,
      characterName: opts.characterName,
      characterTags: opts.characterTags
    });
    if (settings.length === 0) {
      return { text: "", count: 0, byAnchor: null, anchoredText: "", trace: null };
    }
  }

  const { budget = 2000, includeTrace = false } = opts;
  const result = activate(settings, scanText, { budget, includeTrace });

  if (result.entries.length === 0) {
    return { text: "", count: 0, byAnchor: null, anchoredText: "", trace: result.trace };
  }

  const byAnchor = groupByAnchor(result.entries);
  return {
    text: renderEntries(result.entries),
    count: result.entries.length,
    entries: result.entries,
    byAnchor,
    anchoredText: renderAnchoredLore(byAnchor, renderEntries),
    trace: result.trace,
    used: result.used
  };
}

/**
 * Prompt 面正则。规则出错不该毁掉整次生成。
 */
export async function applyPromptRegex(regexRepo, text, ctx = {}) {
  if (!regexRepo) return text;
  try {
    const rules = await regexRepo.listFor(ctx);
    if (!rules.length) return text;
    const { applyRules } = await import("../regex/engine.js");
    return applyRules(text, rules, { surface: "prompt", ...ctx }).text;
  } catch {
    return text;
  }
}

/** 原始消息（含宏处理）。 */
export function buildRawLlmMessages(conv, character) {
  const ctx = character ? macroContextFor(character, conv) : null;
  return (conv?.messages || []).map(m => ({
    role: m.role,
    content: ctx && typeof m.content === "string"
      ? macros.process(m.content, ctx)
      : m.content,
    // 原始回合随消息带出，供读取端判定签名是否仍有效。
    // 这里**不判断**文本有没有被宏改写——判定统一在
    // assistantContentFor()：它比对 content 与 rawContent 抽出的文本，
    // 不一致就自动回退纯文本。一个判定点，所有改写点自动失效。
    rawContent: m.rawContent || null,
    model: m.model || null
  }));
}

/**
 * 构建一次生成的全部输入（历史裁剪 + 世界书激活 + 系统提示 + 正则 + 锚点分流）。
 *
 * 这是唯一的生成入口——HTTP 路由与 Agent 工具都必须调它，
 * 否则两条路径会再次分叉。
 *
 * @param {{ conversationRepo, characterRepo, settingRepo, regexRepo }} repos
 * @param {object} conv - 对话（须含最新消息）
 * @param {object} character - 已做宏替换的角色卡
 * @param {string} currentInput
 * @param {object} [options]
 */
export async function buildGenerationInput(repos, conv, character, currentInput, options = {}) {
  const { settingRepo, regexRepo } = repos;

  // 预设：显式传入优先，否则用对话上挂的，再否则回退旧行为。
  const preset = options.preset || null;

  const budget = allocateBudget(
    Number(options.contextWindow) || 8000,
    { reserveForOutput: Number(options.maxTokens) || 1000 }
  );

  // 1. 世界书（按角色隔离后激活）
  const lore = await activateLore(settingRepo, conv, buildScanText(conv, currentInput), {
    budget: budget.lore,
    characterId: character?.id || conv?.characterId || null,
    characterName: character?.name || null,
    characterTags: character?.tags || []
  });

  // 2. 系统提示（按预设组装；无预设时保持旧行为）
  const composed = composeWithPreset(preset, {
    character,
    loreText: lore?.anchoredText || "",
    persona: options.persona || conv?.persona || "",
    authorNote: options.authorNote || ""
  });
  const systemPrompt = composed.systemPrompt;

  // 3. 历史裁剪（带上前次存下的摘要，长对话不必每轮重压骨架）
  const systemTokens = estimateTokens(systemPrompt);
  const historyBudget = Math.max(500, budget.history - systemTokens);
  const history = prepareHistory(
    buildRawLlmMessages(conv, character),
    {
      maxTokens: historyBudget,
      previousSummary: conv?.summary?.text ? conv.summary : null
    }
  );

  // 4. Prompt 面正则
  const regexCtx = { characterId: conv?.characterId, presetId: options.presetId || null };
  const finalSystem = await applyPromptRegex(regexRepo, systemPrompt, regexCtx);

  // 5. 按锚点插历史
  const { messages: anchoredMessages, injected } = injectByAnchor(
    history.messages,
    lore?.byAnchor,
    Number(options.loreDepth) || 4
  );

  const finalMessages = [];
  for (const m of anchoredMessages) {
    const afterRegex = await applyPromptRegex(regexRepo, m.content, regexCtx);
    const out = {
      role: m.role,
      content: afterRegex
    };
    // 签名只在文本未被改写时回传。
    // 签名是 provider 侧的「前缀指纹」：文本变了，指纹就对不上，
    // 带上只会让缓存失配——不如不带。
    if (m.signature && afterRegex === m.content) out.signature = m.signature;

    // 原始回合与模型必须透传。少了这两个，toStreamMessages 里的
    // isRawContentValid() 永远判否，整条链路就退化成无签名纯文本——
    // 缓存命中率归零，而且是静默的。
    if (m.rawContent !== undefined) out.rawContent = m.rawContent;
    if (m.model !== undefined) out.model = m.model;
    if (m._prefixBroken) out._prefixBroken = true;

    finalMessages.push(out);
  }

  return {
    systemPrompt: finalSystem,
    messages: finalMessages,
    meta: {
      loreCount: lore?.count || 0,
      loreTokens: lore ? estimateTokens(lore.text) : 0,
      loreInjected: injected,
      droppedMessages: history.dropped,
      summaryAttached: history.summaryAttached,
      historyBudget,
      presetId: composed.usedPreset,
      // 摘要写回的建议值——由路由落盘，管线本身不写仓库。
      summaryPatch: history.summaryRecord || null,
      summaryAttached: history.summaryAttached,
      summaryReused: !!(history.summaryRecord?.coveredCount
        && history.summaryRecord.coveredCount > 0),
      loreAnchors: lore?.byAnchor
        ? Object.fromEntries(
            Object.entries(lore.byAnchor)
              .filter(([, v]) => v.length > 0)
              .map(([k, v]) => [k, v.map(e => e.name)])
          )
        : null
    }
  };
}

/**
 * 一步到位：从对话与角色卡算出生成输入。
 * 工具路径的便捷入口。
 */
export async function prepareGenerationInput(repos, conversationId, currentInput, options = {}) {
  const { conversationRepo, characterRepo } = repos;

  const conv = await conversationRepo.get(conversationId);
  if (!conv) throw new Error("Conversation not found");

  const rawCharacter = await characterRepo.get(conv.characterId);
  if (!rawCharacter) throw new Error("Character not found");

  const character = applyMacrosToCharacter(rawCharacter, conv, options);

  return {
    conv,
    character,
    input: await buildGenerationInput(repos, conv, character, currentInput, options)
  };
}
