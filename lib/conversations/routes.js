// lib/conversations/routes.js — 对话 HTTP 路由
//
// 统一用 route() 包装；SSE 端点用 raw() 绕过 JSON 包装。

import { route, raw, notFound } from "../respond.js";
import { MessageRole } from "./model.js";
import { createMacroProcessor } from "../macros/index.js";
import { activate } from "../lore/index.js";
import { estimateTokens, trimHistory, allocateBudget } from "../llm/history.js";
import {
  macroContextFor,
  applyMacrosToCharacter,
  freezeVolatileMacros,
  buildScanText,
  buildGenerationInput as buildGenerationInputShared
} from "./pipeline.js";
import { buildSuggestionInput, parseSuggestions } from "./suggestions.js";
import { buildSummaryInput, parseSummary, SUMMARY_MAX_CHARS } from "./summary-llm.js";
import { participantsOf } from "./model.js";
import { parsePrivateMarker } from "./whisper.js";
import { snapshotVars, diffVars, describeVarDiff } from "../variables/diff.js";
import { extractSceneMarker, sceneMarkerInstruction } from "../illustration/scene-marker.js";
import { generateSceneIllustration, shouldAutoIllustrate } from "../illustration/service.js";
import { readSceneConfig } from "../illustration/config.js";
import { DIRECTOR_VAR_KEY, normalizeDirectorState } from "../director/model.js";
import { settleMany, sortByOrder } from "../director/engine.js";
import { parseDirectorReport } from "../director/report.js";
import { directorIdsOf, dirStateOf, writeDirState } from "../director/binding.js";
import { parseOpsReport, settleOps, composePendingBlock } from "../ops/engine.js";
import { readConfig as readModelConfig, resolveTargetFor } from "../models/config.js";
import { readConfig as readMemoryConfig } from "../memory/config.js";
import { recall as runRecall } from "../recall/index.js";
import { extractCodexEntities } from "./extract-codex.js";
import { settleStoryMessage } from "../story/effects.js";
import { bondTitle, bondSystemBlock, parseBondStage } from "../bond/core.js";
import { createBattle, initHp, playerAction, parseBattlePack } from "../battle/protocol.js";
import { recordSegment, maybeRollVolume, maybeRollWorld, composeArchiveContext } from "./archive.js";
import { ensureArchive } from "./archive.js";

// 宏处理器（供消息级宏替换用）
const macros = createMacroProcessor();

export function registerConversationRoutes(app, repo, llm, characterRepo, settingRepo = null, regexRepo = null, presetRepo = null, boardRepo = null, opts = {}) {
  // 导演配方（配方式文游的剧情公式）。没起来时整条线静默不生效，不是错。
  const directorRepo = opts?.directorRepo || null;
  // 操作（C2）：待执行项注入 + 结算。没起来时整条线静默不生效。
  const opsRepo = opts?.opsRepo || null;
  // 图鉴（C1-2）：每轮正文异步抽取候选实体，进待确认区。没起来时整条线静默不生效。
  const codexRepo = opts?.codexRepo || null;
  // 宏处理器（供消息级宏替换用）
  // 见文件顶部 import
  //
  // 场景插图触发（第 2 批 2.5/2.6）：
  // 保存回复前先抽出 [场景] 标记，剥离后的正文写盘；
  // 有标记且 scene.enabled=true 时，后台异步出一张图。
  //
  // 两条硬规矩：
  //   ① 标记始终剥离。模型写了 [场景] 就不让那三个字进回复正文；
  //     否则用户看得到但看不懂，等于把内部信号漏到 UI。
  //   ② 出图不阻塞回复。回复已经存下，插图是另一条消息；
  //     它失败只影响自己，不让「回复」这个动作看起来失败。
  //
  // opts = { sdk, dataDir } 可选：
  //   不传时自动触发完全跳过——只保留剥离行为。这样即使 App 装配里忘了
  //   传，也不会因为引用未定义而抛错，只是失去自动出图能力。
  const illustrationDeps = opts && typeof opts === "object" ? opts : {};
  const sceneDepsReady = !!(illustrationDeps.sdk && illustrationDeps.dataDir);

  /**
   * 抽标记 + 决定是否异步出图。剥离总是做；触发要看配置。
   *
   * @param {string} convId
   * @param {string} settledText       已经过宏结算的回复正文
   * @param {{characterId?: string, speakerId?: string, speakerName?: string}} [replyMeta]
   * @returns {Promise<{text: string, markerPrompt: string|null, illustrationTriggered: boolean}>}
   */
  async function handleSceneMarker(convId, settledText, replyMeta = {}) {
    const info = extractSceneMarker(settledText);
    if (!info.hasMarker) return { text: info.text, markerPrompt: null, illustrationTriggered: false };

    if (!sceneDepsReady) {
      // 剥离照样做：标记不进回复。只是不出图。
      return { text: info.text, markerPrompt: null, illustrationTriggered: false };
    }

    const cfg = await readSceneConfig(illustrationDeps.dataDir).catch(() => null);
    const gate = cfg ? shouldAutoIllustrate(cfg) : null;
    if (!gate || !gate.active) {
      return { text: info.text, markerPrompt: null, illustrationTriggered: false };
    }

    const charId = String(replyMeta.characterId || (await repo.get(convId))?.characterId || "");
    if (!charId) return { text: info.text, markerPrompt: null, illustrationTriggered: false };

    // 异步、不阻塞、不抛——失败也只在日志里留话
    void generateSceneIllustration(
      { sdk: illustrationDeps.sdk, dataDir: illustrationDeps.dataDir, conversationRepo: repo, characterRepo },
      {
        conversationId: convId,
        characterId: charId,
        scene: info.prompt,
        speaker: replyMeta.speakerName || null
      }
    ).catch(e => console.warn(`[illustration] 自动出图失败 conv=${convId}: ${e?.message || e}`));

    return { text: info.text, markerPrompt: info.prompt, illustrationTriggered: true };
  }

  /**
   * 按 id 读卡，任何一张不存在就报错说清是哪一张。
   *
   * 建对话与改参与者共用这条——两处各写一套的话，
   * 迟早会出现"建的时候严、改的时候松"这种分叉，而它很难被测出来。
   */
  async function loadCardsOrThrow(ids) {
    const cards = [];
    for (const cid of ids) {
      const card = await characterRepo.get(cid).catch(() => null);
      if (!card) throw notFound(`角色不存在: ${cid}`);
      cards.push(card);
    }
    return cards;
  }

  // 列出对话
  app.get("/conversations", route(async () => {
    return repo.list();
  }));

  // ── 羁绊（第 6 期）────────────────────────────
  // 羻绊 = 一场带 mode="bond" 的多角色对话：玩家不发言只旁听，
  // 点「推进」时 AI 生成角色间互动，关系阶段随段落演进。

  // ── 战斗（第 8 期）────────────────────────────
  // 遭遇：AI 生成战斗包（属性/技能/三段剧情）→ 状态机建场。
  // 行动：前端传 kind（attack/skill/flee），纯状态机结算，公式引擎算伤害。
  // 胜负：把结果摘要作为 user 消息注入对话，让 AI 接着写战后剧情。

  // 遭遇（AI 生成战斗包并建场）
  app.post("/conversations/:id/battle/encounter", route(async (c) => {
    const id = c.req.param("id");
    const conv = await repo.get(id);
    if (!conv) throw notFound("Conversation not found");
    const body = (await c.req.json().catch(() => ({}))) || {};
    const enemyDesc = String(body.enemyDesc || "").trim() || "一个神秘敌人";
    const character = await characterRepo?.get?.(conv.characterId) || null;

    const r = await llm.generate(
      [{ role: "user", content: [
        `设计一场遭遇战。敌人：${enemyDesc}。`,
        `玩家角色：「${character?.name || "冒险者"}」（属性见下方）。`,
        "按以下格式输出：",
        "【战斗属性】",
        "一个 JSON：{\"player\":{\"name\":\"...\",\"attrs\":{...},\"skills\":[{\"name\":\"技能名\",\"formula\":\"公式\",\"cost\":\"体力 -N\"}]},\"enemy\":{\"name\":\"...\",\"attrs\":{...},\"desc\":\"...\"}}",
        "玩家 attrs 以对话变量为底（体力/攻击/防御/敏捷），可补充。敌人 attrs 自由定义属性。",
        "技能 2-4 个，公式用 {属性} 与 {敌人.属性} 引用，可含 max/min/骰子。",
        "【战前剧情】",
        "遭遇的紧张感描写（100 字内）。",
        "【胜利剧情】\n（一句话）\n【失败剧情】\n（一句话）"
      ].join("\n") }],
      {
        systemPrompt: `你是战斗设计师。敌人要符合当前故事氛围（最近对话：${(conv.messages || []).slice(-4).map(m => String(m.content).slice(0, 80)).join(" / ")}）。只按格式输出。`,
        maxTokens: 900,
        temperature: 0.7,
        target: await resolveModelTarget(id)
      }
    );

    const pack = parseBattlePack(r?.content || "");
    if (!pack.player || !pack.enemy) throw new Error("战斗包解析失败——重试一次通常能好");

    const battle = initHp(createBattle(pack, conv.variables || {}));
    battle.preStory = pack.preStory;
    battle.winStory = pack.winStory;
    battle.loseStory = pack.loseStory;
    await repo.update(id, { battle });

    // 敌人配图（fire-and-forget）：复用场景插图服务，scene = 敌人描述。
    // 失败静默——战斗面板本来就没图也能打，图是锦上添花。
    let enemyImage = null;
    try {
      const { generateSceneIllustration } = await import("../illustration/service.js");
      const ill = await generateSceneIllustration(
        { sdk, dataDir, conversationRepo: repo, characterRepo },
        { conversationId: id, characterId: conv.characterId,
          scene: `${battle.enemy.name}。${battle.enemy.desc || enemyDesc}。全身，游戏立绘风格，深色背景。`,
          source: "manual" }
      );
      enemyImage = ill?.mediaId ?? null;
    } catch { enemyImage = null; }
    return { battle, enemyImage };
  }));

  // 当前战斗
  app.get("/conversations/:id/battle", route(async (c) => {
    const conv = await repo.get(c.req.param("id"));
    if (!conv) throw notFound("Conversation not found");
    return { battle: conv.battle ?? null };
  }));

  // 玩家行动
  app.post("/conversations/:id/battle/action", route(async (c) => {
    const id = c.req.param("id");
    const conv = await repo.get(id);
    if (!conv) throw notFound("Conversation not found");
    if (!conv.battle) throw new Error("没有进行中的战斗");
    const body = await c.req.json().catch(() => ({})) || {};
    playerAction(conv.battle, body);
    await repo.update(id, { battle: conv.battle });

    // 胜负落定：把结果作为 user 消息注入对话，让 AI 接着写战后剧情
    let injected = null;
    if (conv.battle.status === "won" || conv.battle.status === "lost") {
      const summary = [
        conv.battle.status === "won" ? "【战斗胜利】" : "【战斗失败】",
        `敌人：${conv.battle.enemy.name}。剩余 HP：你 ${conv.battle.player.hp}。`,
        conv.battle.status === "won" ? (conv.battle.winStory || "") : (conv.battle.loseStory || ""),
        "（这是系统注入的战斗结果，请以叙事方式继续故事——胜则收割战果，败则安排转机。）"
      ].filter(Boolean).join("\n");
      injected = await repo.addMessage(id, MessageRole.USER, summary, { kind: "text" });
    }
    return { battle: conv.battle, injected };
  }));

  // 羁绊 = 一场带 mode="bond" 的多角色对话：玩家不发言只旁听，
  // 点「推进」时 AI 生成角色间互动，关系阶段随段落演进。

  // 创建羁绊对话
  app.post("/bonds", route(async (c) => {
    const body = await c.req.json();
    const ids = (Array.isArray(body.characterIds) ? body.characterIds : []).map(String).filter(Boolean);
    if (ids.length < 2) throw new Error("捵绊至少需要两位角色");
    const cards = await loadCardsOrThrow(ids);
    const conv = await repo.create(ids[0], {
      characterIds: ids,
      characterName: cards.map(x => x?.name || "").join(" × "),
      title: bondTitle(cards.map(x => x?.name || "")),
      mode: "bond",
      directorId: ""
    });
    return conv;
  }));

  // 推进一步：生成角色间互动，落盘为一条 assistant 消息（轮换发言人），
  // 并把「关系阶段」演进写进 conv.bondStage。
  app.post("/bonds/:id/advance", route(async (c) => {
    const id = c.req.param("id");
    const conv = await repo.get(id);
    if (!conv) throw notFound("Conversation not found");
    if (conv.mode !== "bond") throw new Error("这不是一场捵绊对话");

    const participants = participantsOf(conv);
    const cards = [];
    for (const pid of participants) {
      try { cards.push(await characterRepo?.get?.(pid) || null); } catch { cards.push(null); }
    }
    const names = cards.map(x => x?.name || "");

    const block = bondSystemBlock({
      names,
      stage: conv.bondStage?.stage || "",
      history: conv.bondStage?.history || []
    });

    // 生成输入：玩家消息为空串（不在场），systemPrompt 由管线拼 + 末尾附捵绊块
    const input = await buildGenerationInput(conv, cards[0], "", {});
    const r = await llm.generate(input.messages, {
      systemPrompt: `${input.systemPrompt}\n\n${block}`,
      maxTokens: 900,
      temperature: 0.8,
      target: await resolveModelTarget(id)
    });
    const text = String(r?.content ?? "").trim();
    if (!text) throw new Error("模型没给出内容");

    // 落盘：轮换发言人（谁是这一段的主视角）
    const rotateIdx = (Number(conv.bondStage?.turn) || 0) % participants.length;
    // 私语标记解析：与其他 assistant 落盘同一条纪律（check-private-reply-wiring）
    const bondPrivate = await privateOf(text, conv);
    const saved = await repo.addMessage(id, MessageRole.ASSISTANT, bondPrivate.text, {
      speakerId: participants[rotateIdx],
      speakerName: names[rotateIdx] || "",
      ...(bondPrivate.audience ? { audience: bondPrivate.audience } : {})
    });

    // 关系阶段演进
    const nextStage = parseBondStage(text) || conv.bondStage?.stage || "初识";
    const history = [...(conv.bondStage?.history || []), text.slice(0, 150)].slice(-12);
    await repo.update(id, {
      bondStage: { stage: nextStage, turn: (Number(conv.bondStage?.turn) || 0) + 1, history }
    });

    return { message: saved, stage: nextStage };
  }));

  // 获取对话详情
  app.get("/conversations/:id", route(async (c) => {
    const conv = await repo.get(c.req.param("id"));
    if (!conv) throw notFound("Conversation not found");
    return conv;
  }));

  // 创建对话
  //
  // 支持群聊：`characterIds` 传数组。第一个（或显式给的 `characterId`）
  // 是**主角**——开场白由他出，也是没指定发言者时的默认发言人。
  app.post("/conversations", route(async (c) => {
    const body = await c.req.json();
    const rawIds = Array.isArray(body.characterIds) ? body.characterIds : [];
    const ids = rawIds.map(String).filter(Boolean);
    const primary = body.characterId ? String(body.characterId) : ids[0];
    if (!primary) throw new Error("characterId is required");

    // 每张卡都要真在：群聊里少一个角色，就是“看起来对、其实没说上话”。
    // （旧行为只在主角卡不存在时默默用空名——那种默不作声正是要治的。）
    const all = [...new Set([primary, ...ids])];
    const cards = await loadCardsOrThrow(all);

    // 读卡拿角色名：列表的兜底链是 title → characterName → （无标题），
    // 不写 characterName 的话，新对话在首条 user 消息出现之前
    // 永远顶着"（无标题）"——存是首条消息触发的，名是创建时就该有的。
    // 人设跟着角色卡走（原酒馆的规矩）：新场没显式带人设时，
    // 从这张卡**最近一场**抄一份过来。
    // 不新增字段——抄最近一场，行为一致，schema 不动。
    // 显式传空串 = 明确要清空，**不**继承（只有 undefined 才继承）。
    let prev = null;
    if (body.userName === undefined || body.persona === undefined) {
      // list() 只回**摘要**（id/characterId/title/messageCount/updatedAt），
      // 没有 persona/userName——要拿全文得再 get 一次。
      // 别为这个去改 list()：它是左栏列表用的，摘要本来就是它的职责。
      const latest = (await repo.list())
        .filter((c) => c.characterId === primary)
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0];
      prev = latest ? await repo.get(latest.id) : null;
    }
    const conv = await repo.create(primary, {
      userName: body.userName !== undefined ? body.userName : prev?.userName,
      persona: body.persona !== undefined ? body.persona : prev?.persona,
      characterName: cards[0]?.name || "",
      characterIds: all,
      // 建的时候就能绑配方。空串 = 明确不绑（不是"继承上一场"，配方是个体决定的事）
      directorId: body.directorId !== undefined ? String(body.directorId || "") : ""
    });

    // 开场白：角色卡里写的 first_mes 不该白写。
    //
    // 过去建完对话是空的，要用户先开口——而那段精心写的开场白
    // 一个字都没露面。这里把它作为第一条 assistant 消息发出。
    // 多个开场白时随机选一条，其余存为变体（swipe 可切）。
    //
    // 多人场合：**每位参与者都把自己那份说出来**（按名册顺序），
    // 而不是只发主角的。否则群聊一开场就少了一半人的声音，
    // 而“谁先开口”恰好是群聊里最该由作者安排的东西。
    if (body.greeting !== false) {
      await seedGreetings(conv.id, all);
    }

    return await repo.get(conv.id);
  }));

  /**
   * 改这一场的参与者：加人 / 减人 / 换主角。
   *
   * 为什么要有：参与者过去只能在**建对话**时定，之后加不了也减不了——
   * 想加第三个人只能重开一场，等于把已有上下文全丢了。
   *
   * 四条规矩：
   *   ① 名单不能空（空名单让这一场没法说话）。
   *   ② 每张卡都要真在（与建对话共用同一条校验）。
   *   ③ **主角必须还在名单里，不安静地换**——主角决定了开场白、
   *      默认发言人与列表里显示的名字，悄悄改掉比报错难查得多。
   *      要换就让调用方显式指定。
   *   ④ 已有消息**一条都不动**：speakerId 是历史，改名单不改历史。
   *      新加的人也不会补种开场白——那是插到对话中间的一句话，
   *      不是开场白。（真要开场，让他在下一轮说话就行。）
   */
  /*
   * 换绑 / 解绑导演配方。
   *
   * 只改绑定关系，**不碰进度**——进度存在这场对话的 variables 里，
   * 换一份配方不会把上一份留下的状态抹掉（那些键还在，只是新配方用不着它们）。
   * 这符合「实体是配置、状态是会话的」这条分界。
   */
  app.patch("/conversations/:id/director", route(async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) || {};
    const directorId = String(body.directorId || "").trim();
    if (directorId && directorRepo) {
      const entity = await directorRepo.get(directorId);
      if (!entity) throw notFound("公式不存在");
    }
    return repo.setDirector(id, directorId);
  }));

  /*
   * 绑多条公式（2026-09-28）。
   *
   * 与单值入口的关系：单值入口内部转调这条，等价于「只绑这一个」。
   * 保留单值入口是为了不破已有的调用方与前端代码。
   *
   * 仍然**不碰进度**——换绑不会把上一份留下的状态抹掉。
   * 进度存在 variables.__dir 里，按公式 id 分家，绑不绑它都在。
   */
  app.patch("/conversations/:id/directors", route(async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) || {};
    const raw = Array.isArray(body.directorIds) ? body.directorIds : [];
    const ids = [];
    for (const v of raw) {
      const s = String(v ?? "").trim();
      if (s && !ids.includes(s)) ids.push(s);
    }
    // 绑之前先确认都存在——绑上一个不存在的 id，运行期只会静默不生效
    if (directorRepo) {
      for (const one of ids) {
        const entity = await directorRepo.get(one);
        if (!entity) throw notFound(`公式不存在：${one}`);
      }
    }
    return repo.setDirectors(id, ids);
  }));

  app.patch("/conversations/:id/participants", route(async (c) => {
    const conv = await repo.get(c.req.param("id"));
    if (!conv) throw notFound("Conversation not found");

    const body = await c.req.json();
    if (!Array.isArray(body.characterIds)) {
      throw new Error("characterIds 必须是数组（要给就只有这些人）");
    }
    const ids = [...new Set(body.characterIds.map(String).filter(Boolean))];
    if (ids.length === 0) {
      throw new Error("至少留一位参与者（空名单会让这一场没法说话）");
    }

    const cards = await loadCardsOrThrow(ids);

    const wanted = body.characterId ? String(body.characterId) : String(conv.characterId || "");
    if (!ids.includes(wanted)) {
      throw new Error(
        `主角 ${wanted} 不在新名单里：要么把他留下，要么用 characterId 显式指定新的主角（可选：${ids.join(", ")}）`
      );
    }

    const primaryCard = cards[ids.indexOf(wanted)];
    return await repo.update(conv.id, {
      characterIds: ids,
      characterId: wanted,
      characterName: primaryCard?.name || conv.characterName || ""
    });
  }));

  /**
   * 这一场要不要「发完自动轮换」。
   *
   * 只让改这一个字段：repo.update 是全字段合并，
   * 把前端传来的对象整个塞进去，等于让调用方顺手改掉 id / messages。
   * （这是仓储自己注释里警告过的坑，这里按它说的做。）
   */
  app.put("/conversations/:id/rotation", route(async (c) => {
    const conv = await repo.get(c.req.param("id"));
    if (!conv) throw notFound("Conversation not found");

    const body = await c.req.json();
    if (typeof body.autoRotate !== "boolean") {
      throw new Error("autoRotate 必须是布尔值（要给个明确的开关状态）");
    }
    return await repo.update(conv.id, { autoRotate: body.autoRotate });
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
  async function seedGreeting(convId, characterId, speakerId = null) {
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

    // 多人场合要署名，不然这连续几句开场白在界面上分不出是谁说的。
    // 单人时 speakerId 是 null → opts 为空 → 落盘形状与以前逐字节一致。
    const opts = speakerId ? { speakerId, speakerName: card.name || "" } : {};

    // 一次性宏（抽签/时刻）在**落盘**时结算——与别处同一条纪律。
    // 不结算的后果：屏幕每次重绘都重掷，而 prompt 用的是落盘那份
    // —— 同一个开场白，你看到的和模型看到的不是一个。
    const conv = (await repo.get(convId)) || { id: convId };
    const frozen = freezeVolatileMacros(chosen, applyMacrosToCharacter(card, conv, {}), conv);
    // 开场白也走一遍私语标记解析：**统一**比“这条用不上”重要——
    // 一张卡真写了 [[私语:某某]]，不解析它就原样显示在气泡里（既丑又不私密）。
    const greeterPrivate = await privateOf(frozen, conv);
    const msg = await repo.addMessage(convId, MessageRole.ASSISTANT, greeterPrivate.text, greeterPrivate.audience ? { ...opts, audience: greeterPrivate.audience } : opts);

    // 只有多于一条时才建变体列表（单条无需 swipe）
    if (all.length > 1) {
      await repo.setVariants(convId, msg.id, all, pick);
    }
    return msg;
  }

  /**
   * 按名册依次种开场白。
   *
   * 单人时走的就是原来的 `seedGreeting(convId, primary)`（不传 speakerId）——
   * 那条路的字节行为与以前完全一样。
   *
   * 某一位读不到卡（刚被删了）不应该把整次建对话搞挂，所以逐位 catch。
   */
  async function seedGreetings(convId, participants) {
    const list = Array.isArray(participants) ? participants : [participants];
    const many = list.length > 1;
    const out = [];
    for (const cid of list) {
      const msg = await seedGreeting(convId, cid, many ? cid : null).catch(() => null);
      if (msg) out.push(msg);
    }
    return out;
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

  /*
   * 前情提要（折叠出来的那段）：读 / 改 / 清。
   *
   * 为什么必须有：折叠是**有损**的（一段历史被压成几句骨架），
   * 而“哪一段不重要”是价值判断，不该只由机器做。
   * 用户看不见、改不了的东西，等于**背着他丢东西**。
   *
   * 两条约定：
   *   ① 原文**从不删除**。折叠是每轮按预算重算的，
   *      所以“清掉”只是让它下一轮重新压一遍——消息一条不少。
   *   ② 手改**不动 `coveredCount`**。它记的是“这段摘要盖到第几条”，
   *      改的是“怎么写”而不是“盖到哪”。清成 0 的话下一轮会把同一段
   *      再压一遍、追加在后面。
   */
  app.get("/conversations/:id/summary", route(async (c) => {
    const id = c.req.param("id");
    const conv = await repo.get(id);
    if (!conv) throw notFound("Conversation not found");
    return { id, summary: conv.summary || null };
  }));

  app.put("/conversations/:id/summary", route(async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) || {};
    const conv = await repo.get(id);
    if (!conv) throw notFound("Conversation not found");

    // 空 / null = 清掉（原文还在，下一轮按预算重压）
    if (body.text === null || body.text === undefined || String(body.text).trim() === "") {
      await repo.update(id, { summary: null });
      return { id, summary: null, cleared: true };
    }

    const prev = conv.summary || null;
    const next = {
      text: String(body.text),
      coveredCount: Number(prev?.coveredCount) || 0,
      editedAt: new Date().toISOString()
    };
    await repo.update(id, { summary: next });
    return { id, summary: next };
  }));

  /**
   * 用模型重写「前情提要」——**手动触发，一次调用**。
   *
   * 为什么不自动：折叠可能每轮都发生，自动化的那笔账就成了
   * “用户不知道花了钱”。所以默认手动，界面上一个按钮，点它就是一次明确的调用。
   *
   * 摘的是**按当前预算真会被折掉的那批**——不是用户眼下看到的那段旧摘要，
   * 它可能已经是上一版压过的了。没有可折的就**不假装成功**：
   * 直说“还没到折叠的地方”（那时压它只会丢信息）。
   */
  app.post("/conversations/:id/summary/summarize", route(async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) || {};
    const conv = await repo.get(id);
    if (!conv) throw notFound("Conversation not found");
    if (!llm || typeof llm.generate !== "function") throw new Error("模型服务未就绪");

    // 前情提要用 summary 那一路的模型。先解析出来，窗口预算按它算——
    // 换模型后旧预算可能塞不下，摘要会写不完。
    const summaryTarget = await resolveModelTarget("summary");

    let character = null;
    try { character = (await characterRepo?.get?.(conv.characterId)) || null; } catch { character = null; }

    // 窗口优先问引擎；拿不到就用调用方给的，再不行才堕落回 8000。
    // （拿兜底值算出来的折叠范围会偏小——宁可偏小，也不编一个大数字。）
    let win = null;
    if (typeof llm.resolveContextWindow === "function") {
      try { win = await llm.resolveContextWindow(summaryTarget); } catch { win = null; }
    }
    const budget = allocateBudget(Number(win) || Number(body.contextWindow) || 8000, {
      reserveForOutput: Number(body.maxTokens) || 1000
    });

    const raw = (conv.messages || [])
      .filter(m => m && m.role && typeof m.content === "string")
      .map(m => ({ role: m.role, content: m.content }));
    const { droppedMessages } = trimHistory(raw, { maxTokens: budget.history });

    if (droppedMessages.length === 0) {
      return {
        ok: false,
        folded: 0,
        reason: `还没到折叠的地方：历史没超预算（约 ${budget.history} token），现在压它只会丢信息`,
        summary: conv.summary || null
      };
    }

    const input = buildSummaryInput(character, droppedMessages, {
      maxChars: SUMMARY_MAX_CHARS,
      // 记忆面板 (S2)：用户配过的总结字数 / 自定义提示词优先于默认常量。
      // 未配（dataDir 为空、readConfig 回默认）= 回 SUMMARY_MAX_CHARS 与默认模板。
      ...(await memoryOptsForSummarize())
    });
    const r = await llm.generate(input.messages, {
      systemPrompt: input.systemPrompt,
      maxTokens: 700,
      temperature: 0.3,
      target: summaryTarget
    });

    const parsed = parseSummary(r?.content || "", { maxChars: input.maxChars });
    // 写不出来就报错，不存半成品（“好的” / 半截解释 / 代码块都不是摘要）
    if (!parsed.text) throw new Error("摘要没写出来：" + (parsed.why || "空回话"));

    const record = {
      text: parsed.text,
      coveredCount: droppedMessages.length,
      byModel: true,
      editedAt: new Date().toISOString()
    };
    await repo.update(id, { summary: record });

    return {
      ok: true,
      id,
      folded: droppedMessages.length,
      summary: record,
      usage: r?.usage ?? null,
      model: r?.target?.model ?? null
    };
  }));

  // ── 生成 ──

  /** 准备一次生成的公共前置：取对话 + 角色 + 构建请求。 */
  async function prepareGeneration(c) {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const { content, options } = body;

    const conv = await repo.get(id);
    if (!conv) throw notFound("Conversation not found");

    /*
     * 群聊：这一轮谁说话。默认主角。
     *
     * 发言者必须是**本场参与者**——不校验的话，等于把外人塞进这场对话的
     * prompt 里，而屏幕上什么都没变，没人看得出来。
     */
    let speakerId = conv.characterId;
    if (body.speakerId && String(body.speakerId) !== String(conv.characterId)) {
      const want = String(body.speakerId);
      if (!participantsOf(conv).map(String).includes(want)) {
        throw notFound(`发言者不在这一场里：${want}`);
      }
      speakerId = want;
    }

    const rawCharacter = await characterRepo.get(speakerId);
    if (!rawCharacter) throw notFound("Character not found");

    /*
     * 发言者属于「这一轮请求」，所以挂在 options 上一起往下走。
     *
     * 为什么不单开一个返回值：四条生成路径都拿得到 options，
     * 而各自再加一处解构就会漏一处——漏掉的那条回复就成了没署名的。
     */
    const genOptions = {
      ...(options || {}),
      speakerId,
      speakerName: rawCharacter.name || ""
    };

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

    return { id, content: frozenContent, options: genOptions, conv, character, rawCharacter, body, speakerId };
  }

  /**
   * 群聊：把发言者写到这一条助手消息上。
   *
   * 单人对话**不写**——那条 `speakerId === characterId` 的信息是多余的，
   * 而且会把单角色路径的落盘形状改掉（虽然只是加字段）。
   *
   * 但**多人场合必须写，包括主角说的那几句**。否则群聊里只有配角有名字，
   * 主角的话变成无主气泡——界面上看着像旁白。
   * （group-ui 探针抳出来的：“我 | 角色(薇拉·霜语) | 角色”，最后那个就是主角。）
   */
  function speakerOpts(base, speakerId, speakerName, conv) {
    if (!speakerId || !speakerName) return base;
    const many = (conv?.characterIds?.length || 0) > 1;
    if (!many && String(speakerId) === String(conv?.characterId)) return base;
    return { ...base, speakerId, speakerName };
  }

  /**
   * 从请求体里取出「这句是私语，给谁听」。
   *
   * 只收在场的人：给一个不在这一场里的人听是没意义的
   *（prompt 里永远不会有他的视角），所以报错说清是哪一个。
   *
   * `audience: []` 是**合法**的：谁都听不到（fail closed）。
   * 语义与黑板的 charVisibility 一致：说不清给谁看，就当谁都不给。
   */
  function audienceFrom(body, conv) {
    const raw = body?.audience;
    if (raw == null) return {};
    if (!Array.isArray(raw)) {
      throw new Error("audience 必须是数组（要给就明说给谁听）");
    }
    const ids = [...new Set(raw.map(String).filter(Boolean))];
    if (ids.length === 0) return { audience: [] };
    const people = participantsOf(conv).map(String);
    for (const id of ids) {
      if (!people.includes(id)) throw notFound(`私语对象不在这一场里: ${id}`);
    }
    return { audience: ids };
  }

  /**
   * 反过来那一半：**角色**也能私下说话。
   *
   * 正文第一行的 `[[私语:名字]]` 换成 audience，正文从第二行开始。
   * 名册取这一场的角色卡；卡没了就当那个名字对不上（不抛错）——
   * 一句台词不该因为一张卡被删就整个发不出去。
   */
  async function privateOf(text, conv) {
    const roster = [];
    for (const cid of conv?.characterIds || []) {
      const card = await characterRepo.get(cid).catch(() => null);
      if (card?.name) roster.push({ id: cid, name: card.name });
    }
    return parsePrivateMarker(text, { roster });
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
  /**
   * 按用途解析要用的模型目标。
   *
   * 与 LLMService.resolveTarget 的分工：
   *   · 这里负责「按用途选出该用谁」（全局默认 + 按用途覆盖 + 回退）
   *   · resolveTarget 负责「把选出的 {provider,model} 送到宿主，找不到就回目录默认」
   *
   * 读不到配置或 dataDir 未就绪时返回 null，等价于「维持现状」——
   * 老用户升级上来，不填任何模型也能照跑。
   *
   * @param {"chat"|"vars"|"summary"|"suggest"|"embed"} purpose
   * @returns {Promise<{provider:string, model:string}|null>}
   */
  async function resolveModelTarget(purpose) {
    if (!illustrationDeps.dataDir) return null;
    try {
      const cfg = await readModelConfig(illustrationDeps.dataDir);
      return resolveTargetFor(cfg, purpose);
    } catch {
      // 配置读不了不阻塞生成：回退目录默认
      return null;
    }
  }

  /**
   * 前情提要那一路的参数（S2 记忆面板）。
   *
   * 只在读得到配置时往外透；读不到或没配 = 空对象，
   * buildSummaryInput 自己会回 SUMMARY_MAX_CHARS 与默认模板。
   * summaryPrompt 空串不往外透（让 summary-llm 走默认模板，字一字不动）。
   */
  async function memoryOptsForSummarize() {
    if (!illustrationDeps.dataDir) return {};
    try {
      const cfg = await readMemoryConfig(illustrationDeps.dataDir);
      const opts = { maxChars: cfg.summaryMaxChars };
      if (typeof cfg.summaryPrompt === "string" && cfg.summaryPrompt.trim()) {
        opts.summaryPrompt = cfg.summaryPrompt;
      }
      return opts;
    } catch {
      // 记忆配置坏了不阻塞总结：回默认
      return {};
    }
  }

  async function withRealWindow(options = {}, conv = null) {
    const opts = { ...(options || {}) };

    // 上下文窗口按「chat 用途实际会用到的模型」问，而不是固定 null。
    // 换了模型之后窗口尺寸可能不同——拿错窗口算预算会偏。
    // （拿不到就用调用方给的值，再不行才堕回 8000。）
    try {
      const target = await resolveModelTarget("chat");
      const win = await llm?.resolveContextWindow?.(target || null);
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
  /**
   * 回复落盘前的宏处理，**并把变量变化一起结算**。
   *
   * 这两件事必须一起做，因为它们是同一件事的两面：
   *
   *   1. 回复里的 {{setvar}} 要真的写进去。
   *      宏引擎把所有变量写收敛到 onVariableChange 回调，注释写着「由调用方决定
   *      何时真正落盘」——而调用方一直没落盘。`conv` 又是**加用户消息之前**取的
   *      旧对象，`repo.addMessage` 会从磁盘重读，所以写它也没用。
   *      结论：回复里写变量一直是静默失效的，界面自然也就永远没有「变量变化」可显示。
   *
   *   2. 变化要留成账附在消息上——它属于「这一轮发生了什么」。
   *
   * 账取**前后快照的差**，不采信回调自报：回调只是触发器，状态才是事实
   *（它会把 7 和 "7" 报成一次改动，也会漏掉失败的回调）。
   */
  async function settleReplyMacros(convId, text, character, conv) {
    const vars = conv && typeof conv === "object"
      ? (conv.variables && typeof conv.variables === "object" ? conv.variables : (conv.variables = {}))
      : null;
    const before = snapshotVars(vars);
    const out = freezeVolatileMacros(text, character, conv);
    const after = snapshotVars(vars);
    // 显示用的那行字在服务端就拼好：前端拿到的就是一句人读的话，
    // 不用再养一份一模一样的拼字逻辑（那就成了第二份双胞胎镜像）。
    const diff = diffVars(before, after).map((d) => ({ ...d, text: describeVarDiff(d) }));

    if (vars && diff.length > 0) {
      const patch = {};
      for (const d of diff) if (d.change !== "remove") patch[d.name] = vars[d.name];
      // 落盘失败不抛：变量是观测面，写不进去不该毁掉一整轮已经生成好的回复
      try { await repo.updateVariables(convId, patch); } catch { /* 见上 */ }
    }
    return { text: out, diff };
  }

  /**
   * 导演结算：解析模型的上报、推进状态、把 [状态 …] 标记从正文摘掉。
   *
   * 三件事必须在同一处做完，因为它们互为前提：
   *   标记摘了但状态没推 → 模型白报，配方永远停在初值；
   *   状态推了但标记没摘 → 读者在正文里看见 `[状态 tension+2]`；
   *   报错就中断       → 一整轮已经生成好的回复陪着一起废掉。
   *
   * 所以：任何一步失败都不抛，只让这一步不生效。
   */
  async function settleDirector(convId, text, conv) {
    const ids = directorIdsOf(conv);
    if (ids.length === 0 || !directorRepo) return { text, changes: [], rejected: [] };

    const parsed = parseDirectorReport(text);
    // 没有上报、也没有写错的标记 → 一个字都不用动
    if (parsed.reports.length === 0 && parsed.bad.length === 0) {
      return { text, changes: [], rejected: [] };
    }

    // 取回这一场绑的全部公式（读不到的、关掉的都跳过）
    const rawDir = conv?.variables?.[DIRECTOR_VAR_KEY];
    const entities = [];
    const states = {};
    for (const id of ids) {
      let entity = null;
      try { entity = await directorRepo.get(id); } catch { /* 读不到就当没绑 */ }
      if (!entity || entity.enabled === false) continue;
      entities.push(entity);
      states[id] = normalizeDirectorState(entity, dirStateOf(rawDir, id));
    }
    if (entities.length === 0) return { text, changes: [], rejected: [] };

    const ordered = sortByOrder(entities);
    const result = settleMany(ordered, states, parsed.reports);

    /*
     * 写回进度。
     *
     * 多条时才升格成嵌套形状（各归各家）；单条时维持旧的扁平形状——
     * 老对话不被无谓改写。升格时旧扁平数据归到第一条名下，
     * 否则那份进度会变成孤儿（谁都不认它）。
     *
     * 状态是观测面：写不进去不该毁掉一整轮已经生成好的回复。
     */
    const multi = ordered.length > 1;
    let nextDir = rawDir;
    for (const e of ordered) {
      nextDir = writeDirState(nextDir, e.id, result.states[e.id] || {}, {
        forceNested: multi,
        migrateFrom: ordered[0]?.id
      });
    }
    try { await repo.updateVariables(convId, { [DIRECTOR_VAR_KEY]: nextDir }); } catch { /* 见上 */ }

    return { text: parsed.text, changes: result.changes, rejected: result.rejected, bad: parsed.bad };
  }

  /**
   * 操作结算（C2）：把 [结算 操作名 ...] 标记从正文摘掉，
   * 把 deltas / sets 写回变量，并从 pending 里抹掉结算过的项。
   *
   * 与 director 同形：
   *   · 任何一步失败都不抛——只让这一步不生效，不毁回复。
   *   · 变量写回走 conversationRepo.updateVariables（不另开账）。
   *   · 标记已识别才摘；无法解析的坏行保留，进 bad 给排查看。
   */
  async function settleOpsForReply(convId, text, conv) {
    if (!opsRepo) return { text, applied: [], rejected: [], errors: [] };
    const parsed = parseOpsReport(text);
    if (parsed.reports.length === 0) {
      // 没有识别到 [结算 ...] 标记 → 一个字不动（保留任何残留标记给排查）
      return { text, applied: [], rejected: parsed.bad, errors: [] };
    }
    const ops = await opsRepo.listOps().catch(() => []);
    const varsBefore = conv?.variables || {};
    const result = await settleOps({
      reports: parsed.reports,
      ops,
      conversationId: convId,
      conversationRepo: repo,   // 只用到 updateVariables + removePendingByOp
      varsBefore
    });
    return { text: parsed.text, ...result };
  }

  /** 把这一轮的变量账挂到消息上。挂不上也不毁回复。 */
  async function attachVarDiff(convId, savedMsg, diff) {
    if (!savedMsg?.id || !Array.isArray(diff) || diff.length === 0) return savedMsg;
    try { return (await repo.setMessageVarDiff(convId, savedMsg.id, diff)) || savedMsg; }
    catch { return savedMsg; }
  }

  /**
   * 剧情卡协议结算：解析 content → 有【效果】则写变量+挂 var-diff →
   * 解析结果挂 msg.story。失败不毁回复——协议是增强层，不是门槛。
   * 返回的 savedMsg 要重新读（setMessageStory 可能改了消息），但
   * 调用方拿着旧的也能用：story 只是渲染线索，下一轮会重拉。
   */
  async function attachStory(convId, savedMsg) {
    if (!savedMsg?.id || savedMsg.role !== "assistant") return savedMsg;
    try {
      const conv = await repo.get(convId);
      await settleStoryMessage({ conv, message: savedMsg, conversationRepo: repo });
      return (await repo.get(convId))?.messages?.find(m => m.id === savedMsg.id) || savedMsg;
    } catch { return savedMsg; }
  }

  /**
   * 三层归档记段：assistant 消息落盘后调。追加式——只推进
   * conv.archive 的账，不动 conv.summary（那个管近期未超预算部分）。
   * 滚章/滚卷时异步生成真摘要（fire-and-forget，失败不毁回复）。
   */
  async function recordArchive(convId, savedMsg) {
    if (!savedMsg?.id || savedMsg.role !== "assistant") return;
    try {
      const conv = await repo.get(convId);
      const preChapters = (conv.archive?.chapters?.length) || 0;
      recordSegment(conv, savedMsg);
      const vol = maybeRollVolume(conv);
      const wh = maybeRollWorld(conv);
      await repo.update(convId, { archive: conv.archive });

      // 新滚出一章：异步生成章摘要（压的是这一章覆盖的消息原文）
      const postChapters = (conv.archive?.chapters?.length) || 0;
      if (postChapters > preChapters) {
        const ch = conv.archive.chapters[conv.archive.chapters.length - 1];
        const endCount = ch.coveredCount;
        const startCount = endCount - ch.segCount + 1;
        // 该章覆盖的 assistant 消息原文（coveredCount 是从对话开头数的 assistant 消息序数）
        const segTexts = (conv.messages || [])
          .filter(m => m.role === "assistant")
          .slice(startCount - 1, endCount)
          .map(m => String(m.content ?? "").slice(0, 400));
        void generateChapterSummary(convId, ch, segTexts).catch(() => {});
      }
      // 滚动了卷/世界史才需要生成那两层的摘要
      if (vol || wh) {
        void generateArchiveSummaries(convId, vol, wh).catch(() => {});
      }
    } catch { /* 归档失败不挡回复 */ }
  }

  /** 章摘要：压该章覆盖的消息原文（每段截 400 字）。失败静默。 */
  async function generateChapterSummary(convId, chapter, segTexts) {
    if (!llm || typeof llm.generate !== "function" || !segTexts.length) return;
    const conv = await repo.get(convId);
    if (!conv) return;
    let character = null;
    try { character = (await characterRepo?.get?.(conv.characterId)) || null; } catch { character = null; }
    const src = segTexts.map((t, i) => `【段 ${i + 1}】${t}`).join("\n\n");
    const s = await askArchiveSummary(`以下是一部互动故事第 ${chapter.n} 章的 ${segTexts.length} 段剧情。把它们压成一段 150 字以内的章摘要：\n\n${src}`, character);
    if (s) {
      const fresh = await repo.get(convId);
      const a = ensureArchive(fresh);
      const target = a.chapters.find(c => c.n === chapter.n);
      if (target) target.summary = s;
      await repo.update(convId, { archive: a });
    }
  }

  /**
   * 为新滚出的卷/世界史生成真摘要（LLM）。
   * 卷摘要压的是 8 个章摘要（不是原文）——摘要只压下一层。
   * 章摘要压的是该章覆盖的消息原文。
   * 失败静默：账还在，摘要是空的，下轮 composeArchiveContext 跳过空摘要。
   */
  async function generateArchiveSummaries(convId, vol, worldEntry) {
    if (!llm || typeof llm.generate !== "function") return;
    const conv = await repo.get(convId);
    if (!conv) return;
    const archive = ensureArchive(conv);
    let character = null;
    try { character = (await characterRepo?.get?.(conv.characterId)) || null; } catch { character = null; }

    // 卷摘要：压本章的全部章摘要
    if (vol && !vol.summary) {
      const startIdx = Math.max(0, archive.chapters.length - vol.chapterCount);
      const src = archive.chapters.slice(startIdx)
        .map(ch => ch.summary || `（第 ${ch.n} 章摘要素材缺失，覆盖 ${ch.segCount} 段）`)
        .join("\n");
      if (src) {
        vol.summary = await askArchiveSummary(`以下是一部互动故事第 ${vol.n} 卷的全部章节摘要。把它们压成一段 200 字以内的卷摘要：\n\n${src}`, character);
      }
    }

    // 世界史摘要：压全部卷摘要
    if (worldEntry && !worldEntry.summary) {
      const src = archive.volumes.slice(0, worldEntry.toVolume - worldEntry.fromVolume + 1)
        .map(v => v.summary || `（第 ${v.n} 卷摘要素材缺失）`)
        .join("\n");
      if (src) {
        worldEntry.summary = await askArchiveSummary(`以下是一部互动故事多卷的卷摘要。把它们压成一段 300 字以内的世界史纪要：\n\n${src}`, character);
      }
    }

    await repo.update(convId, { archive });
  }

  /** 归档摘要的一次 LLM 调用。失败回 null（调用方跳过空摘要）。 */
  async function askArchiveSummary(text, character) {
    try {
      const target = await resolveModelTarget("summary");
      const r = await llm.generate(
        [{ role: "user", content: text }],
        {
          systemPrompt: `你是故事记录员。把给定的故事材料压成一段简洁摘要，保留人物、地点、关键事件与结果。不解释、不客套、不包代码块，只输出摘要正文。${character?.name ? `故事主角是「${character.name}」。` : ""}`,
          maxTokens: 500,
          temperature: 0.3,
          target
        }
      );
      const parsed = parseSummary(r?.content || "", { maxChars: 600 });
      return parsed.text;
    } catch { return null; }
  }

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

  /**
   * 图鉴抽取（C1 二期）：每轮正文写盘后异步跑一次，把候选实体推进待确认区。
   *
   * 与 persistSummary 同样 fire-and-forget：外层**不 await**，正文回完就走。
   * 失败只在 console.warn 里留一行——图鉴抽取失败不该让“回复”这个动作看起来失败。
   *
   * 两道闸门：
   *   · codexRepo 没传 → 直接不启动（App 装配忘传也不会抛错）
   *   · 抽取的模型走 summary 那一路（短、稳、便宜）——与前情提要同源。
   */
  function fireExtract(convId, assistantContent, characterName) {
    if (!codexRepo) return;
    if (!assistantContent || typeof assistantContent !== "string") return;
    // 解析目标（读不到配置就当目录默认，不阻塞）
    void (async () => {
      let target = null;
      try { target = await resolveModelTarget("summary"); } catch { /* ignore */ }
      await extractCodexEntities({
        llm,
        text: assistantContent,
        codexRepo,
        conversationId: convId,
        characterName: characterName || "",
        modelTarget: target
      });
    })();
  }

  /**
   * 转发到共享管线（routes 与 Agent 工具共用同一条）。
   *
   * 这里还多做一件事：**按场景插图配置决定要不要注入那条「配图约定」**。
   *
   * 为何要注入（spec §4 原本的立场是「不救」）：
   *   不注入的话模型根本不知道有 `[场景]` 这回事——`mode=marker` 对普通用户
   *   等于永不触发，而设置面板写着「模型写 [场景] 时自动出图」，读起来像它自己会。
   *   那样判据 3「开启后出图」永远验不出来（不是验不出 bug，是从来没机会发生）。
   *
   * 只在 mode=marker 时注入：mode=off 的用户一个字都不该多花。
   *
   * 指令文案从解析器的 HEAD 拼出来（见 scene-marker.js），
   * 所以“指令里写的”与“解析器认的”不可能不一致。
   */
  /**
   * 预热召回包装（S3）。
   *
   * 读不到 memory 配置 → 当默认开（DEFAULTS.recallEnabled=true）。
   * 任何异常 → 不注入，不抛。
   *
   * 为什么不在 buildGenerationInputShared 里插：
   *   管线（pipeline.js）是“把段落拼成 prompt”，不知道也不该知道 recall 的存在。
   *   谁决定要不要召回，谁在它外面把证据拼上去。
   *
   * @returns {Promise<{evidence?: string, meta?: object}|null>}
   */
  async function maybeRunRecall(currentInput, conv, character) {
    if (!currentInput || typeof currentInput !== "string" || !currentInput.trim()) {
      return null;
    }
    if (!illustrationDeps.dataDir) return null;

    // 读配置（失败 = 默认）
    let cfg = null;
    try {
      cfg = await readMemoryConfig(illustrationDeps.dataDir);
    } catch {
      cfg = null;
    }
    const recallEnabled = cfg ? cfg.recallEnabled : true;
    const recallBudget = cfg ? cfg.recallBudget : 8000;
    const recallMaxLoops = cfg ? cfg.recallMaxLoops : 3;

    if (recallEnabled === false) return null;

    // 拿模型 target（失败回 null，让 llm.generate 回退目录默认）
    let target = null;
    try {
      target = await resolveModelTarget("chat");
    } catch {
      target = null;
    }

    try {
      const r = await runRecall({
        input: currentInput,
        characterId: character?.id || conv?.characterId || null,
        llm,
        characterRepo,
        settingRepo,
        conversationRepo: repo,
        budget: recallBudget,
        maxLoops: recallMaxLoops,
        target
      });
      if (r && r.injected && r.evidence) {
        return { evidence: r.evidence, meta: r.meta || null };
      }
      return null;
    } catch {
      // 静默降级。绝不能因为召回失败阻断发消息。
      return null;
    }
  }

  async function buildGenerationInput(conv, character, currentInput, options = {}) {
    const extra = { ...options };
    try {
      const cfg = illustrationDeps.dataDir
        ? await readSceneConfig(illustrationDeps.dataDir)
        : null;
      if (cfg && cfg.enabled && cfg.mode === "marker") {
        extra.extraPrefixSections = [
          ...(Array.isArray(options.extraPrefixSections) ? options.extraPrefixSections : []),
          {
            kind: "scene-instruction",
            text: sceneMarkerInstruction(),
            note: "mode=marker：告诉模型可以写 [场景]（不注入的话它无从知道）"
          }
        ];
      }

      // 短期记忆轮数（S2 记忆面板）：未传就按 memory 配置里那格取；
      // 读不到也当默认，pipeline 那侧会回 4。
      if (!extra.keepRecent && illustrationDeps.dataDir) {
        const mem = await readMemoryConfig(illustrationDeps.dataDir);
        extra.keepRecent = mem.keepRecent;
      }

      // 待执行项（C2 操作结算）：有勾选项时拼一段 [结算 ...] 语法说明 + 待执行列表，
      // 否则模型不知道能写这个标记。
      if (opsRepo) {
        try {
          const pending = await opsRepo.listPending(conv.id).catch(() => []);
          if (pending.length) {
            const ops = await opsRepo.listOps().catch(() => []);
            const { text: block } = composePendingBlock(ops, pending);
            if (block) {
              extra.extraPrefixSections = [
                ...(Array.isArray(extra.extraPrefixSections) ? extra.extraPrefixSections : []),
                { kind: "pending-ops", text: block, note: "待执行项 + [结算] 语法提示" }
              ];
            }
          }
        } catch { /* 读不到就当没待执行项 */ }
      }
    } catch {
      // 读不到配置 = 当作没开。
      // 理由：多花一次调用的错，比少花的错更贵——而且默认真的是关。
    }
    const input = await buildGenerationInputShared(
      { settingRepo, regexRepo, conversationRepo: repo, characterRepo, boardRepo },
      conv, character, currentInput, extra
    );

    // 预热召回（S3）：发消息时对世界书 / 角色卡 / 对话历史做关键词召回。
    //   高置信直接注入；低置信进轻 ReAct 循环。
    //   失败一律静默降级（runRecall 内部已包 try/catch，返回 { injected: false }）。
    //
    // 注入形式：把证据文本拼到 systemPrompt 尾部（不在 stablePrefix 里，
    //   避免每轮砸 prefix cache）。也不写入 audit（不完美但可接受——
    //   audit 是观测面，证据内容属于内容面）。
    const recallResult = await maybeRunRecall(currentInput, conv, character);
    if (recallResult && recallResult.evidence) {
      input.systemPrompt = input.systemPrompt
        ? input.systemPrompt + "\n\n" + recallResult.evidence
        : recallResult.evidence;
      // meta 里附一笔，前端想看“本轮召回了什么”时能拓。
      input.meta = input.meta || {};
      input.meta.recall = recallResult.meta || null;
    }

    return input;
  }

  // 发送消息 + 生成回复（非流式）
  app.post("/conversations/:id/messages", route(async (c) => {
    const { id, content, options, conv, character, body } = await prepareGeneration(c);

    if (!content || typeof content !== "string") {
      throw new Error("content is required");
    }

    await repo.addMessage(id, MessageRole.USER, content, audienceFrom(body, conv));
    const updated = await repo.get(id);

    const opts = await withRealWindow(options || {}, conv);
    const input = await buildGenerationInput(updated, character, content, opts);

    let assistantContent = "";
    let genResult = null;
    try {
      genResult = await llm.generate(input.messages, {
        systemPrompt: input.systemPrompt,
        ...opts,
        target: await resolveModelTarget("chat")
      });
      assistantContent = genResult.content;
    } catch (e) {
      assistantContent = `[LLM 错误: ${e.message}]`;
    }

    const settled = await settleReplyMacros(id, assistantContent, character, conv);
    // 导演结算：推进配方状态，并把 [状态 …] 标记从正文摘掉
    const directed = await settleDirector(id, settled.text, conv);
    const settledOps = await settleOpsForReply(id, directed.text, conv);
    const scene = await handleSceneMarker(id, settledOps.text, { characterId: options?.speakerId || conv.characterId, speakerName: options?.speakerName || null });
    const privateReply = await privateOf(scene.text, conv);
    let saved = await repo.addMessage(id, MessageRole.ASSISTANT, privateReply.text, speakerOpts(privateReply.audience ? { audience: privateReply.audience } : {}, options?.speakerId, options?.speakerName, conv));
    saved = await persistUsage(id, saved, genResult);
    saved = await attachVarDiff(id, saved, settled.diff);
      saved = await attachStory(id, saved);
      await recordArchive(id, saved);
    persistSummary(id, input.meta);
    fireExtract(id, privateReply.text, character?.name || "");
    return {
      userMessage: updated.messages[updated.messages.length - 1],
      assistantMessage: saved,
      meta: input.meta
    };
  }));

  // 发送消息 + 流式生成回复（SSE）
  app.post("/conversations/:id/messages/stream", route(async (c) => {
    const { id, content, options, conv, character, body } = await prepareGeneration(c);

    if (!content || typeof content !== "string") {
      throw new Error("content is required");
    }

    await repo.addMessage(id, MessageRole.USER, content, audienceFrom(body, conv));
    const updated = await repo.get(id);

    const opts = await withRealWindow(options || {}, conv);
    const input = await buildGenerationInput(updated, character, content, opts);

    // 目标在外层解析一次就够：流式循环里每帧再读一次配置毫无必要，
    // 还会带来「流到一半配置改了」的诡异行为。
    const streamTarget = await resolveModelTarget("chat");

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
        for await (const event of llm.streamEvents(input.messages, { systemPrompt: input.systemPrompt, ...opts, target: streamTarget })) {
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

      const settled = await settleReplyMacros(id, fullContent, character, conv);
      // 导演结算：推进配方状态，并把 [状态 …] 标记从正文摘掉
      const directed = await settleDirector(id, settled.text, conv);
      const settledOps = await settleOpsForReply(id, directed.text, conv);
      const scene = await handleSceneMarker(id, settledOps.text, { characterId: options?.speakerId || conv.characterId, speakerName: options?.speakerName || null });
      const privateReply = await privateOf(scene.text, conv);
    let saved = await repo.addMessage(id, MessageRole.ASSISTANT, privateReply.text, speakerOpts(privateReply.audience ? { audience: privateReply.audience } : {}, options?.speakerId, options?.speakerName, conv));
      saved = await persistUsage(id, saved, {
        usage: doneEvent?.usage ?? null,
        rawContent: Array.isArray(doneEvent?.assistant?.content)
          ? doneEvent.assistant.content.map(c => ({ ...c }))
          : null,
        model: llm.lastTarget?.model || null,
        reasoning: extractReasoning(doneEvent?.assistant)
      });
      saved = await attachVarDiff(id, saved, settled.diff);
      saved = await attachStory(id, saved);
      await recordArchive(id, saved);
      fireExtract(id, privateReply.text, character?.name || "");
      send({ type: "done", content: fullContent, message: saved, meta: input.meta });
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
      genResult = await llm.generate(input.messages, {
        systemPrompt: input.systemPrompt,
        ...opts,
        target: await resolveModelTarget("chat")
      });
      assistantContent = genResult.content;
    } catch (e) {
      assistantContent = `[LLM 错误: ${e.message}]`;
    }

    const settled = await settleReplyMacros(id, assistantContent, character, conv);
    // 导演结算：推进配方状态，并把 [状态 …] 标记从正文摘掉
    const directed = await settleDirector(id, settled.text, conv);
    const settledOps = await settleOpsForReply(id, directed.text, conv);
    const scene = await handleSceneMarker(id, settledOps.text, { characterId: options?.speakerId || conv.characterId, speakerName: options?.speakerName || null });
    const privateReply = await privateOf(scene.text, conv);
    let saved = await repo.addMessage(id, MessageRole.ASSISTANT, privateReply.text, speakerOpts(privateReply.audience ? { audience: privateReply.audience } : {}, options?.speakerId, options?.speakerName, conv));
    await attachVariant(repo, id, saved, lastAssistant, assistantContent);
    saved = await persistUsage(id, saved, genResult);
    saved = await attachVarDiff(id, saved, settled.diff);
      saved = await attachStory(id, saved);
      await recordArchive(id, saved);
    persistSummary(id, input.meta);
    fireExtract(id, privateReply.text, character?.name || "");

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

    const streamTarget = await resolveModelTarget("chat");

    return raw(createSseStream(async (send) => {
      let fullContent = "";
      let doneEvent = null;

      for await (const event of llm.streamEvents(input.messages, { systemPrompt: input.systemPrompt, ...opts, target: streamTarget })) {
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

      const settled = await settleReplyMacros(id, fullContent, character, conv);
      // 导演结算：推进配方状态，并把 [状态 …] 标记从正文摘掉
      const directed = await settleDirector(id, settled.text, conv);
      const settledOps = await settleOpsForReply(id, directed.text, conv);
      const scene = await handleSceneMarker(id, settledOps.text, { characterId: options?.speakerId || conv.characterId, speakerName: options?.speakerName || null });
      const privateReply = await privateOf(scene.text, conv);
    let saved = await repo.addMessage(id, MessageRole.ASSISTANT, privateReply.text, speakerOpts(privateReply.audience ? { audience: privateReply.audience } : {}, options?.speakerId, options?.speakerName, conv));
      await attachVariant(repo, id, saved, lastAssistant, fullContent);
      saved = await persistUsage(id, saved, {
        usage: doneEvent?.usage ?? null,
        rawContent: Array.isArray(doneEvent?.assistant?.content)
          ? doneEvent.assistant.content.map(c => ({ ...c }))
          : null,
        model: llm.lastTarget?.model || null,
        reasoning: extractReasoning(doneEvent?.assistant)
      });
      saved = await attachVarDiff(id, saved, settled.diff);
      saved = await attachStory(id, saved);
      await recordArchive(id, saved);
      persistSummary(id, input.meta);
      fireExtract(id, privateReply.text, character?.name || "");
      send({ type: "done", content: fullContent, message: saved, meta: input.meta });
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
    // listEffective：书关了条目就不出现在候选里，预览口径与真生成保持一致。
    const rawChar = await characterRepo.get(conv.characterId).catch(() => null);
    let settings = await settingRepo.listEffective();
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
      temperature: 1.0,
      target: await resolveModelTarget("suggest")
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

