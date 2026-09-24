// lib/conversations/pipeline.js — 生成管线（路由与工具共用）
//
// ⚠️ 为什么抽出来：
//   原先 HTTP 路由与 Agent 工具各有一套生成逻辑，且**已经分叉**——
//   路由走新的世界书引擎（宏替换 / activate / 锚点分流 / 历史预算 / 正则），
//   工具走旧的 getActiveSettings + shouldTrigger（纯子串匹配）。
//   结果：通过工具发消息，整轮 C1/C3/C4/D2 全都不生效。
//
//   两条路径必须共用同一条管线，否则「修好的功能」会有一半入口用不上。

import { createHash } from "node:crypto";
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

  // 两族分开处理，因为出路不同：
  //   时间族 → **搬出前缀**：卡里留指路标记，真值每轮由尾部提供
  //     （卡字段最终落进静态前缀，而前缀里一旦有会变的东西，
  //       从它出现的位置往后整段都对不上缓存）
  //   抽签族 → **按对话冻结**：一次抽签，整场有效
  const prepared = { ...character };
  for (const f of CHARACTER_MACRO_FIELDS) {
    const v = character[f];
    if (typeof v !== "string" || !v.includes("{{")) continue;
    prepared[f] = freezeDrawMacros(relocateTimeMacros(v), ctx, convId);
  }

  return macros.processFields(prepared, CHARACTER_MACRO_FIELDS, ctx);
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
 * 一次性宏：每次求值都不同。它们分两族，**两族的出路完全不同**。
 *
 *   抽签族（roll / random）—— 一次**事件**。
 *     发生了就该冻，之后每读一次都是同一个结果。
 *     出路：按对话结算一次（冻在值上）。
 *
 *   时间族（time / date / datetime / weekday）—— **环境读数**。
 *     它本身就是「现在」，冻死它等于把一个哑钟摆在卡里。
 *     但一旦进了静态前缀，从它出现的位置往后整段都对不上缓存。
 *     出路：**搬出前缀**——卡里留一个常量指路标记，
 *     真值每轮由动态尾部提供。
 *
 * 一句话：抽签冻在值上，时间搬到值该在的那一层。
 */
const DRAW_RE = /\{\{\s*(roll|random)\b[^}]*\}\}/gi;
const TIME_RE = /\{\{\s*(time|date|datetime|weekday)\b[^}]*\}\}/gi;

/**
 * 时间宏被搬到尾部后，卡里留下的指路标记。
 *
 * 它是**常量**——所以前缀仍然逐字节稳定。模型看到
 *「场景：〔当前时刻〕，月曦夜 登上哨塔」，
 * 再往后翻到尾部那块「## 当前时刻」就能对上。
 */
export const TIME_MACRO_MARKER = "〔当前时刻〕";

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
 * 时间族宏 → 指路标记。
 *
 * 时间不能待在前缀里（会变），也不该冻死（那样钟就不走了）。
 * 唯一的出路是**搬到动态尾部**：卡里留一个常量标记，尾部每轮给真值。
 * 标记本身是常量，所以前缀仍然逐字节稳定。
 *
 * 代价：卡里原来那个位置不再是「一个具体时刻」，而是「去看下面」。
 * 这是这条路必须付的账，不是 bug。
 */
export function relocateTimeMacros(text) {
  const t = String(text ?? "");
  if (!TIME_RE.test(t)) return t;
  TIME_RE.lastIndex = 0;   // 带 g 的正则 test() 会推 lastIndex
  return t.replace(TIME_RE, TIME_MACRO_MARKER);
}

/**
 * 处理过的卡里还有没有指路标记——也就是「这一场要不要给活的时间」。
 *
 * 用标记本身当信号，不另加一份并行状态：
 * 另加一份就要保证它跟文本总是一致，而那正是最容易腐掉的地方。
 */
export function needsTimeBlock(character) {
  if (!character) return false;
  return CHARACTER_MACRO_FIELDS.some(
    f => typeof character[f] === "string" && character[f].includes(TIME_MACRO_MARKER)
  );
}

/**
 * 动态尾部的「当前时刻」块。
 *
 * 每轮重新求值——**这就是那个会走的钟**。它待在尾部，
 * 所以它变了也不影响前缀缓存。
 */
export function renderTimeBlock() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");

  // 格式故意不跟 {{time}}/{{date}} 走：
  //   那两个宏用的是**用户本地区域设置**（“24/9/2026 下午6:38:35”），
  //   用户在自己消息里看到的文本那样写没问题；但这一块是 system prompt，
  //   模需要的是无歧义的读数（“2026-09-24 18:38”），
  //   而不是一个依赖宿主区域设置的字符串。
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + ` ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const weekday = macros.process("{{weekday}}", {});

  return `## 当前时刻\n现在是 ${stamp}（${weekday}）。`;
}

/**
 * 把文本里的**抽签族**宏换成「这一场的结算值」（首次调用时算一次）。
 *
 * 做在文本层而不是改宏处理器，有两个好处：
 *   1. 不用动 lib/macros —— 那里有一份前端孪生镜像，
 *      改一边不改另一边会被 check-macro-twin 抳住，
 *      而改两边是两倍的风险换零收益
 *   2. 结算点显式可数：一眼能看出「哪些宏是会被冻的」
 */
export function freezeDrawMacros(text, ctx, convId = "no-conv") {
  const t = String(text ?? "");
  if (!DRAW_RE.test(t)) return t;
  DRAW_RE.lastIndex = 0;
  return t.replace(DRAW_RE, (m) => freezeOnce(convId, m, (src) => macros.process(src, ctx)));
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
  // 消息路径两族一起冻：一句「现在是 14:32」说的是那一刻的事实，
  // 不管它是抽签还是时间，落盘之后都不该再变。
  // （时间「搬去尾部」只适用于**卡字段**——那是每轮重算的地方。）
  if (!DRAW_RE.test(t) && !TIME_RE.test(t)) return t;
  DRAW_RE.lastIndex = 0;
  TIME_RE.lastIndex = 0;
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
/** 前缀指纹：12 位 sha1。够短，能直接写在界面上看。 */
function fingerprintOf(text) {
  return createHash("sha1").update(String(text ?? ""), "utf8").digest("hex").slice(0, 12);
}

/**
 * 组装**稳定前缀**——这一场里逐字节不变的那一段。
 *
 * 为什么值得给它一个名字：它不是一个「顺便拼出来的字符串」，
 * 它是**前缀缓存命中与否的全部依据**。它有自己的构成、自己的指纹、
 * 自己的失效条件（换角色 / 改预设 / 动常驻格）。
 * 这三件事以前散在拼装流程里，没人能回答「前缀什么时候会变」。
 *
 * 约定（**别改**，改了缓存会静默失效）：
 *   · 块间两行空行；**没有**开头/结尾分隔符——分隔符属于尾部，
 *     否则「前缀」就变成一个依赖尾巴是否存在的量
 *   · 空块直接丢掉，不留空行
 *
 * @param {{kind:string, text:string}[]} parts
 * @returns {{text:string, parts:{kind:string,chars:number,fingerprint:string}[], fingerprint:string}}
 */
export function buildStablePrefix(parts) {
  const kept = (parts || []).filter(p => p && String(p.text ?? "").length > 0);
  const text = kept.map(p => String(p.text)).join("\n\n");
  return {
    text,
    parts: kept.map(p => ({
      kind: p.kind,
      chars: String(p.text).length,
      fingerprint: fingerprintOf(String(p.text))
    })),
    fingerprint: fingerprintOf(text)
  };
}

/**
 * 上一轮的前缀指纹，key = 对话 id。
 *
 * 内存里、不落盘——和宏结算缓存同一个理由：落盘要动数据模型
 *（加字段、加迁移、加路由），而收益只是「重启后不用重算一次」。
 * 重启后第一轮我们**没有基线**，那就如实说「未知」，
 * 而不假装「没变」——估不准的读数比没有读数更坏。
 */
const prefixWatch = new Map();
const PREFIX_WATCH_LIMIT = 200;

/** 测试用：清掉前缀基线。 */
export function resetPrefixWatch() {
  prefixWatch.clear();
}

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

  // ── 审计账 ────────────────────────────────────────
  //
  // 为什么要把「账」当返回值，而不是让人自己看拼好的文本：
  // 文本对不出「该进没进」和「不该进进了」。这里分两栏：
  //   included — 谁进了、多大、是不是必需（chars 是**正则改写前**的长度）
  //   omitted  — 谁没进、**为什么**。理由不能省：省了就等于「忘了」
  // 账只从**真实拼装**里长出来——旁边另算一遍，迟早会和真发出去的不一致。
  const audit = { included: [], omitted: [], warnings: [], totalChars: 0, totalTokens: 0 };
  const addSection = (kind, where, text, opts = {}) => {
    // chars 可以直接给（如历史：只要个数，不必把正文再留一份）
    const chars = opts.chars != null ? opts.chars : String(text ?? "").length;
    if (chars === 0) return false;
    audit.included.push({ kind, where, chars, required: opts.required !== false, note: opts.note || "" });
    return true;
  };
  const omit = (kind, reason) => audit.omitted.push({ kind, reason });

  addSection(
    "base", "system", composed.systemPrompt,
    { note: preset
      ? `预设「${preset.name || preset.id}」的块序列`
      : "卡自身的 system_prompt（没写则名称/描述/性格/场景四段）" }
  );
  if (!preset) omit("preset", "这一场没有绑定预设（预设跟随对话，可在预设抽屉里点「这一场用它」）");

  // ── 稳定前缀 ────────────────────────────────────
  //
  // 它 = 底子（预设或卡） + 常驻公开格。
  // 以前这两块是在流程里现拼的，没有名字、没有指纹、没有失效条件；
  // 现在它是一次明确的构建：
  //   · 有自己的指纹（前缀究竟变没变，不再靠肉眼）
  //   · 变的时候能说出**是哪一块变的**（「变了」本身没用）
  const boardPrefix = renderBoardCells(board.prefix);
  const boardStaticPart = boardPrefix ? `## 世界 · 常驻\n${boardPrefix}` : "";
  const prefix = buildStablePrefix([
    { kind: "base", text: composed.systemPrompt },
    { kind: "board-static", text: boardStaticPart }
  ]);

  // 跟上一轮比。没有基线时如实说「未知」。
  const prev = prefixWatch.get(String(conv?.id || ""));
  let prefixChanged = null;
  if (prev) {
    const wasBy = new Map((prev.parts || []).map(p => [p.kind, p.fingerprint]));
    const nowBy = new Map(prefix.parts.map(p => [p.kind, p.fingerprint]));
    const which = [...new Set([...wasBy.keys(), ...nowBy.keys()])]
      .filter(k => wasBy.get(k) !== nowBy.get(k));
    if (which.length > 0) prefixChanged = { from: prev.fingerprint, parts: which };
  }
  if (conv?.id) {
    if (prefixWatch.size >= PREFIX_WATCH_LIMIT) prefixWatch.clear();
    prefixWatch.set(String(conv.id), { fingerprint: prefix.fingerprint, parts: prefix.parts });
  }

  let systemPrompt = prefix.text;

  if (boardPrefix) {
    addSection("board-static", "system", boardStaticPart, {
      note: `${board.prefix.length} 格常驻公开，属于稳定前缀`
    });
  } else {
    omit("board-static", "这个世界没有常驻公开的格子");
  }

  audit.prefix = {
    fingerprint: prefix.fingerprint,
    parts: prefix.parts,
    changed: prefixChanged,
    baseline: prev ? "已知" : "未知（本进程第一次见到这一场）"
  };
  if (prefixChanged) {
    audit.warnings.push(
      `稳定前缀本轮变了（${prefixChanged.parts.join(" + ")}）` +
      `——前缀缓存必然不命中，而且从变化点往后全部作废`
    );
  }

  // 2b. 动态尾部：本轮世界书 + 本轮可见的格子（关键词格、私密格）。
  //      关键词格逐轮不同、私密格按说话者不同，都属于"会变的那部分"，
  //      放前缀等于每轮砸一次缓存。
  const tailParts = [];

  // 会走的钟：卡里用过时间宏才拼（不留指路标记就不白占 token）。
  // 放尾部第一位——它描述的是「现在」，是接下来所有内容的背景。
  if (needsTimeBlock(character)) {
    const t = renderTimeBlock();
    tailParts.push(t);
    addSection("time", "system", t, { note: "卡里用了时间宏，真值每轮重算（在尾部，不伤前缀）" });
  } else {
    omit("time", "卡里没有时间宏（{{time}} / {{date}} / {{weekday}} 等），按设计不拼时间块");
  }

  const dynamicLore = loreBlockOn ? String(lore?.anchoredText || "").trim() : "";
  if (dynamicLore) {
    tailParts.push(`## 世界设定\n${dynamicLore}`);
    addSection("lore-dynamic", "system", dynamicLore, { note: `本轮激活 ${lore?.count || 0} 条` });
  } else if (!loreBlockOn) {
    omit("lore-dynamic", "预设里关掉了世界书块（用户关了它），尾部也不拼");
  } else {
    omit("lore-dynamic", "本轮没有世界书条目被激活");
  }

  const boardTail = renderBoardCells(board.tail);
  if (boardTail) {
    tailParts.push(`## 世界 · 本轮\n${boardTail}`);
    addSection("board-dynamic", "system", boardTail, { note: `${board.tail.length} 格本轮（关键词激活 / 私密）` });
  } else {
    omit("board-dynamic", "本场没有关键词格被激活，也没有私密格");
  }

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

  // 历史与会话也入账（它们不在 system 里，用 where 分开）
  {
    const msgChars = (history.messages || []).reduce((n, m) => n + String(m.content ?? "").length, 0);
    addSection("history", "messages", null, {
      chars: msgChars,
      note: `${(history.messages || []).length} 条，约 ${historyBudget} token 预算`
    });
    if (history.summaryAttached) {
      addSection("summary", "messages", null, {
        chars: String(conv?.summary?.text || "").length,
        note: `覆盖前 ${history.summaryRecord?.coveredCount || 0} 条`
      });
    } else {
      omit("summary", "历史还没到压缩阈值，不需要摘要");
    }
    if ((history.dropped || 0) > 0) {
      audit.warnings.push(`历史超出预算，丢了最早的 ${history.dropped} 条`);
    }
  }

  // 前缀里还有没结算的宏 → 前缀每轮会变，缓存白给。静态就能查，入账当警告。
  {
    const prefixOnly = systemPrompt.split(/\n\n## /)[0];
    const leftover = prefixOnly.match(/\{\{[^}]*\}\}/g);
    if (leftover) {
      audit.warnings.push(`静态前缀里还留着未结算的宏（${[...new Set(leftover)].slice(0, 3).join(" ")}）——前缀每轮会变，前缀缓存白给`);
    }
  }

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
    audit: {
      ...audit,
      // 总数按**真正发出去**的那份算：正则可能改写过系统提示。
      totalChars: finalSystem.length + finalMessages.reduce((n, m) => n + String(m.content ?? "").length, 0),
      totalTokens: estimateTokens(finalSystem)
        + finalMessages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0),
      systemCharsPreRegex: systemPrompt.length,
      regexChanged: finalSystem !== systemPrompt
    },
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
