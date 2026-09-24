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
import { prepareHistory, allocateBudget, estimateTokens } from "../llm/history.js";
import { cellApplies, sortBoardCells, BoardActivation } from "../board/model.js";

// 宏处理器（无状态，可复用）
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
  const convId = conv?.id || "no-conv";

  // 一次性宏**先冻结再替换**：
  //   卡字段最终落进**静态前缀**，而前缀里一旦有会变的东西，
  //   从它出现的位置往后整段都对不上缓存——不是只损失那几个字符。
  //   冻结之后同一场对话里前缀逐字节不动。
  const prefrozen = { ...character };
  for (const f of CHARACTER_MACRO_FIELDS) {
    if (typeof character[f] === "string" && character[f].includes("{{")) {
      prefrozen[f] = freezeVolatileInText(character[f], ctx, convId);
    }
  }

  return macros.processFields(prefrozen, CHARACTER_MACRO_FIELDS, ctx);
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
 * 黑板分拣：按**缓存稳定性**分，不按可见性分。
 *
 * 这是这条链上最容易做错的一处，所以说清楚为什么。
 *
 * 直觉的分法是「公开的进静态前缀、私密的进动态尾部」。但真正决定命中率的是
 * **这一轮会不会变**，不是谁看得见：
 *
 *   常驻 + 公开  → 静态前缀的尾巴。只要没人改黑板，同角色逐字节常量。
 *   关键词激活   → 动态尾部。命不命中逐轮不同，放前缀等于每轮砸一次缓存。
 *   私密的       → 动态尾部。它按说话者变，放进前缀会让「谁在说话」污染前缀。
 *
 * 一句话：**稳定性和可见性是两回事**。把它们混成一个判断，就会出现
 * 「一个公开的关键词格每次命中都把前缀重置」这种安静烧钱的形态。
 *
 * 另外两条来自审计的纪律（现在还不适用——群聊是第二期——但改到这里时别忘了）：
 *   ② 批量组 prompt 必须按稳定 key（characterId 字典序）排，
 *      不能用「上一个说话者优先」：顺序一漂，前缀全废。
 *   ③ 角色身份（「你是 XX」）不能写进最外层前缀。
 *
 * @returns {{prefix: object[], tail: object[], total: number}}
 */
export async function collectBoardCells(boardRepo, conv, opts = {}) {
  const empty = { prefix: [], tail: [], total: 0 };
  if (!boardRepo) return empty;

  let cells;
  try {
    cells = await boardRepo.listCells(conv?.id || null);
  } catch {
    return empty;   // 黑板读不到不该毁掉整次生成
  }

  const viewer = opts.characterId ? { characterId: opts.characterId } : {};
  const scanText = opts.scanText || "";
  const applicable = (cells || []).filter(c => cellApplies(c, { text: scanText, viewer }));

  const prefix = [];
  const tail = [];
  for (const c of applicable) {
    const isPublic = !c.visible || c.visible === "public";
    const isConstant = c.activation === BoardActivation.CONSTANT;
    (isPublic && isConstant ? prefix : tail).push(c);
  }

  return {
    prefix: sortBoardCells(prefix),
    tail: sortBoardCells(tail),
    total: applicable.length
  };
}

/**
 * 把格子渲染成一段文本。
 * 逐字节稳定：只由格子内容与顺序决定，不掺时间戳、不掺 id。
 * （前缀缓存的命中和「模板里带了个 new Date()」是不能共存的。）
 */
export function renderBoardCells(cells) {
  const list = Array.isArray(cells) ? cells : [];
  if (list.length === 0) return "";
  return list.map(c => `### ${c.title}\n${c.body}`).join("\n\n");
}

/**
 * 一次性宏：每次求值都不同。
 *
 * 它们分两族，混在一起处理就会选错策略：
 *
 *   抽签族（roll / random）—— 一次**事件**。发生了就该冻，
 *     之后每读一次都是同一个结果。
 *   时间族（time / date / datetime / weekday）—— **环境读数**。
 *     它本身就是「现在」，但一旦进了静态前缀，
 *     从它出现的位置往后整段都对不上缓存。
 *
 * 两族的解法是同一句话：**在首算时结算一次，之后整场不再变**。
 * 区别在语义：抽签本就不该变；时间则是为了缓存接受了
 * 「这场戏的时刻停在开场」这个代价。
 */
const VOLATILE_RE = /\{\{\s*(roll|random|time|date|datetime|weekday)\b[^}]*\}\}/gi;

/** 卡上要过宏的字段。 */
const CHARACTER_MACRO_FIELDS = [
  "description", "personality", "scenario", "first_mes", "mes_example",
  "system_prompt", "post_history_instructions"
];

/**
 * 一次性宏的结算缓存，key = `对话 id + 宏原文`。
 *
 * 为什么按对话隔离：抽签与时刻都属于「这一场」。
 * 不隔离的话，第二场对话会继承第一场的骰子。
 *
 * 为什么只要内存、不落盘：落盘要动数据模型（加字段、加迁移、加路由），
 * 而收益只是「重启后不用重算一次」。重启等于换一次前缀缓存，
 * 本来就要重建——为它加一整个字段不划算。
 *
 * 上限只是防无限增长：超了就整锅清掉（重算一次而已）。
 */
const macroFreezeCache = new Map();
const FREEZE_CACHE_LIMIT = 500;

function freezeOnce(convId, source, evaluate) {
  const key = `${convId}\u0000${source}`;
  if (macroFreezeCache.has(key)) return macroFreezeCache.get(key);
  const value = evaluate(source);
  if (macroFreezeCache.size >= FREEZE_CACHE_LIMIT) macroFreezeCache.clear();
  macroFreezeCache.set(key, value);
  return value;
}

/** 测试用：清掉结算缓存。 */
export function resetMacroFreezeCache() {
  macroFreezeCache.clear();
}

/**
 * 把文本里的一次性宏换成「这一场的结算值」（首次调用时算一次）。
 *
 * 做在文本层而不是改宏处理器，有两个好处：
 *   1. 不用动 lib/macros —— 那里有一份前端孪生镜像，
 *      改一边不改另一边会被 check-macro-twin 抳住，
 *      而改两边是两倍的风险换零收益
 *   2. 结算点显式可数：一眼能看出「哪些宏是会被冻的」
 */
export function freezeVolatileInText(text, ctx, convId = "no-conv") {
  const t = String(text ?? "");
  if (!VOLATILE_RE.test(t)) return t;
  VOLATILE_RE.lastIndex = 0;   // 带 g 的正则 test() 会推 lastIndex
  return t.replace(VOLATILE_RE, (m) => freezeOnce(convId, m, (src) => macros.process(src, ctx)));
}

/**
 * 落盘前冻结一次性宏（消息路径）。
 *
 * 消息是原样落盘的，而历史在每次装配时又会重新过一遍宏处理器
 * （buildRawLlmMessages 里的 macros.process）。不冻的话：
 *   · 上一轮掷出的 42，这一轮变成 7 —— 已经发生的事被改写
 *   · 历史逐字节在变 → provider 侧前缀签名对不上 → 缓存被骰子吃掉
 *
 * 修法不是「让随机数稳定」，而是承认一句更简单的话：
 * **掷骰在它发生的那一刻结算，之后它是事实。**
 * 所以消息路径的冻结点是**落盘**；卡字段的冻结点是**首算**
 *（它每轮都会重算，所以只能在结算缓存里定住）。
 *
 * 只处理含一次性宏的文本：其余消息原样通过，行为与从前一模一样
 *（{{char}}/{{user}}/变量这些本来就与读取时刻无关）。
 */
export function freezeVolatileMacros(text, character, conv, extra = {}) {
  const t = String(text ?? "");
  if (!VOLATILE_RE.test(t)) return t;
  VOLATILE_RE.lastIndex = 0;
  try {
    return macros.process(t, macroContextFor(character, conv, extra));
  } catch {
    return t;   // 宏坏了不该拦住一条消息落盘
  }
}

/**
 * 构建一次生成的全部输入（历史裁剪 + 世界书激活 + 系统提示 + 正则 + 锚点分流）。
 *
 * 这是唯一的生成入口——HTTP 路由与 Agent 工具都必须调它，
 * 否则两条路径会再次分叉。
 *
 * @param {{ conversationRepo, characterRepo, settingRepo, regexRepo, boardRepo? }} repos
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

  // 扫描文本：世界书与黑板共用。两处各算一次的话，将来只改一处就会出现
  //「世界书按新文本激活、黑板按旧文本激活」这种诡异的不一致。
  const scanText = buildScanText(conv, currentInput);

  // 1. 世界书（按角色隔离后激活）
  const lore = await activateLore(settingRepo, conv, scanText, {
    budget: budget.lore,
    characterId: character?.id || conv?.characterId || null,
    characterName: character?.name || null,
    characterTags: character?.tags || []
  });

  // 2. 系统提示：静态链与动态世界书分层组装。
  //
  //    组装阶段不掺激活集（loreText: ""），拿到纯静态的块序列，
  //    再把本轮激活的世界书固定追加到尾部。发给 provider 的字节序就是
  //      [静态前缀：主提示/描述/性格/场景/人设/收尾指令][动态尾巴：本轮世界书]
  //    前缀一动不动 → prefix cache 命中；只有换角色/改预设才允许它变。
  //
  //    世界书置尾不牺牲质量，反而合注入影响力逻辑（越靠后影响越大）；
  //    代价是 LORE 块与收尾指令（order 60）的字面相对位置反转——
  //    收尾指令读在世界书之前，作为框架性约束反而更靠前，可接受。
  //
  //    尊重预设开关：预设里禁用了 lore 块 = 用户关了世界书，尾部也不拼。
  const loreBlockOn = !preset || (preset.blocks || [])
    .some(b => b && b.source === "lore" && b.enabled !== false);

  const composed = composeWithPreset(preset, {
    character,
    loreText: "",
    persona: options.persona || conv?.persona || "",
    authorNote: options.authorNote || ""
  });

  // 1b. 黑板：这个世界此刻的样子。
  //      分拣按缓存稳定性（见 collectBoardCells 的注释），不按可见性。
  const board = await collectBoardCells(repos.boardRepo, conv, {
    characterId: character?.id || conv?.characterId || null,
    scanText
  });

  let systemPrompt = composed.systemPrompt;

  // 2a. 静态前缀的尾巴：常驻公开格。
  //      它属于「底色」——只要没人改黑板，同角色逐字节不变，
  //      prefix cache 照常命中；改一次只失效一次。
  const boardPrefix = renderBoardCells(board.prefix);
  if (boardPrefix) {
    systemPrompt += `${systemPrompt ? "\n\n" : ""}## 世界 · 常驻\n${boardPrefix}`;
  }

  // 2b. 动态尾部：本轮世界书 + 本轮可见的格子（关键词格、私密格）。
  //      关键词格逐轮不同、私密格按说话者不同，都属于"会变的那部分"，
  //      放前缀等于每轮砸一次缓存。
  const tailParts = [];
  const dynamicLore = loreBlockOn ? String(lore?.anchoredText || "").trim() : "";
  if (dynamicLore) tailParts.push(`## 世界设定\n${dynamicLore}`);
  const boardTail = renderBoardCells(board.tail);
  if (boardTail) tailParts.push(`## 世界 · 本轮\n${boardTail}`);

  // 分隔符归尾部，不归前缀。
  //   写成 `前缀 += "\n\n" + 尾部` 的话，本轮没有尾巴时前缀少两个字节、
  //   有尾巴时多两个字节——静态前缀的**字节边界**就跟着尾巴在动。
  //   只差 2 字节，最长公共前缀照样命中，损失可以忽略；但「前缀」就变成
  //   一个依赖尾巴是否存在的量，是那种一旦被后人当真就会出事的表述。
  //   分界钉死在前缀的最后一位，两边都干净。
  if (tailParts.length) {
    const tailText = tailParts.join("\n\n");
    systemPrompt = systemPrompt ? `${systemPrompt}\n\n${tailText}` : tailText;
  }

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
      boardCount: board.total,
      boardPrefixCount: board.prefix.length,
      boardTailCount: board.tail.length,
      boardTitles: [...board.prefix, ...board.tail].map(c => c.title),
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
