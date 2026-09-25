// index.js — eleckoi-tavern v2 App 入口
//
// 这个文件只做装配：初始化各模块 → 注册工具 → 注册路由 → 返回清理函数。
// 具体逻辑在 lib/ 下：
//   lib/probe/state.js  — 宿主能力探针（诊断）
//   lib/probe/tools.js  — Agent 工具定义
//   lib/*/repo.js       — 数据仓储
//   lib/*/routes.js     — HTTP 路由
//   lib/llm/service.js  — 模型调用

import path from "node:path";

import { defineApp } from "./sdk/app-contract/server-client.js";

import { CharacterRepo } from "./lib/characters/repo.js";
import { CharacterTransfer } from "./lib/characters/transfer.js";
import { registerCharacterRoutes } from "./lib/characters/routes.js";

import { ConversationRepo } from "./lib/conversations/repo.js";
import { registerConversationRoutes } from "./lib/conversations/routes.js";

import { VariableRepo } from "./lib/variables/repo.js";
import { registerVariableRoutes } from "./lib/variables/routes.js";

import { SettingRepo } from "./lib/settings/repo.js";
import { registerSettingRoutes } from "./lib/settings/routes.js";

import { RegexRepo } from "./lib/regex/repo.js";
import { registerRegexRoutes } from "./lib/regex/routes.js";

import { PresetRepo } from "./lib/presets/repo.js";
import { registerPresetRoutes } from "./lib/presets/routes.js";

import { BoardRepo } from "./lib/board/repo.js";
import { registerBoardRoutes } from "./lib/board/routes.js";

import { registerToolRoutes } from "./lib/tools/routes.js";
import { createEmbedTools } from "./lib/embed/tool.js";
import { registerEmbedRoutes } from "./lib/embed/routes.js";
import { loadGroupState, isGroupEnabled } from "./lib/tools/group.js";

import { registerMigrationRoutes } from "./lib/migration/routes.js";
import { LLMService } from "./lib/llm/service.js";
import { runSelfCheck } from "./lib/selfcheck.js";

import { ProbeState, createProbeTool } from "./lib/probe/state.js";
import {
  createCharacterTools,
  createConversationTools,
  createVariableTools,
  createSettingTools
} from "./lib/probe/tools.js";

export default defineApp(async (sdk) => {
  const probe = new ProbeState();
  const s = probe.state;
  s.loadedAt = probe.now();
  s.defineAppEntered = true;
  probe.record("defineApp entered");

  // ── 宿主能力探测（诊断用，不阻塞主流程） ──
  s.sdkKeys = Object.keys(sdk || {});
  s.loggerAvailable = typeof sdk?.logger?.info === "function";
  if (s.loggerAvailable) {
    try {
      await sdk.logger.info(`[eleckoi-tavern] loaded at ${s.loadedAt}`);
    } catch { /* 日志失败不影响启动 */ }
  }

  s.dataDir = sdk.dataDir || null;
  s.dataDirExists = s.dataDir
    ? await probe.safe(async () => {
        const fs = await import("node:fs/promises");
        await fs.access(s.dataDir);
        return true;
      }, "fs.access(dataDir)")
    : null;

  if (s.dataDirExists) {
    s.dataDirWritable = await probe.safe(async () => {
      const fs = await import("node:fs/promises");
      const testPath = path.join(s.dataDir, "probe-state.json");
      const payload = JSON.stringify({ hello: "eleckoi-tavern", at: probe.now() });
      await fs.writeFile(testPath, payload, "utf8");
      return (await fs.readFile(testPath, "utf8")) === payload;
    }, "dataDir write/read");
    s.dataDirTestFile = s.dataDirWritable ? path.join(s.dataDir, "probe-state.json") : null;
  }

  s.modelsAvailable = !!sdk?.models && typeof sdk.models === "object";
  s.sessionsAvailable = !!sdk?.sessions && typeof sdk.sessions === "object";
  s.agentsAvailable = !!sdk?.agents && typeof sdk.agents === "object";
  s.busAvailable = !!sdk?.bus && typeof sdk.bus === "object";

  // ── 仓储初始化 ──
  const dataDir = s.dataDir;

  let characterRepo = null;
  let characterTransfer = null;
  if (dataDir) {
    characterRepo = new CharacterRepo(dataDir);
    await probe.safe(() => characterRepo.init(), "characterRepo.init");
    characterTransfer = new CharacterTransfer(characterRepo);
    s.characters = { repoInitialized: true, charactersDir: path.join(dataDir, "characters") };
  }

  let conversationRepo = null;
  if (dataDir) {
    conversationRepo = new ConversationRepo(dataDir);
    await probe.safe(() => conversationRepo.init(), "conversationRepo.init");
    s.conversations = { repoInitialized: true, conversationsDir: path.join(dataDir, "conversations") };
  }

  let variableRepo = null;
  if (dataDir) {
    variableRepo = new VariableRepo(dataDir);
    await probe.safe(() => variableRepo.init(), "variableRepo.init");
    s.variables = { repoInitialized: true, definitionsFile: path.join(dataDir, "variable-definitions.json") };
  }

  let settingRepo = null;
  if (dataDir) {
    settingRepo = new SettingRepo(dataDir);
    await probe.safe(() => settingRepo.init(), "settingRepo.init");
    s.settings = { repoInitialized: true, settingsFile: path.join(dataDir, "settings.json") };
  }

  let regexRepo = null;
  if (dataDir) {
    regexRepo = new RegexRepo(dataDir);
    await probe.safe(() => regexRepo.init(), "regexRepo.init");
    s.regex = { repoInitialized: true, rulesFile: path.join(dataDir, "regex-rules.json") };
  }

  let presetRepo = null;
  if (dataDir) {
    presetRepo = new PresetRepo(dataDir);
    await probe.safe(() => presetRepo.init(), "presetRepo.init");
    s.presets = { repoInitialized: true, presetsDir: path.join(dataDir, "presets") };
  }

  let boardRepo = null;
  if (dataDir) {
    boardRepo = new BoardRepo(dataDir);
    await probe.safe(() => boardRepo.init(), "boardRepo.init");
    s.board = { repoInitialized: true, worldCellsFile: path.join(dataDir, "board-cells.json") };
  }

  // ── LLM 服务 ──
  let llmService = null;
  if (s.modelsAvailable) {
    try {
      llmService = new LLMService(sdk);
      s.llm = { available: llmService.available, streamAvailable: llmService.streamAvailable };
    } catch (e) {
      s.llm = { available: false, error: e.message };
    }
  }

  // ── 工具组开关（从磁盘恢复，决定注册哪些工具） ──
  await probe.safe(() => loadGroupState(dataDir), "loadGroupState");

  // ── 工具注册 ──
  const receipts = [];
  const registerTool = async (tool, groupId) => {
    if (groupId && !isGroupEnabled(groupId)) return;
    const receipt = await sdk.tools.register(tool);
    receipts.push(receipt);
    probe.record(`tool registered: ${tool.name}`);
  };

  await registerTool(createProbeTool(probe), "system");

  if (characterRepo) {
    for (const t of createCharacterTools(characterRepo)) await registerTool(t, "characters");
  }
  if (conversationRepo && characterRepo) {
    for (const t of createConversationTools({
      conversationRepo, characterRepo, settingRepo, llmService, regexRepo, boardRepo
    })) await registerTool(t, "conversations");
  }
  if (variableRepo) {
    for (const t of createVariableTools({ variableRepo, conversationRepo })) await registerTool(t, "variables");
  }
  if (settingRepo) {
    for (const t of createSettingTools({ settingRepo, conversationRepo })) await registerTool(t, "settings");
  }

  // 向量：走宿主的 bus 取凭据，用宿主目录里的 embedding 模型算（见 lib/embed/）。
  // 独立成一个工具组，坏了或不想用可以直接关。
  if (sdk) {
    for (const t of createEmbedTools({ sdk, dataDir })) await registerTool(t, "embed");
  }

  s.tools = {
    registered: receipts.length,
    groups: [
      { id: "characters", name: "角色卡" },
      { id: "conversations", name: "对话" },
      { id: "variables", name: "变量" },
      { id: "settings", name: "设定库" },
      { id: "embed", name: "向量" },
      { id: "system", name: "系统" }
    ].map(g => ({ ...g, enabled: isGroupEnabled(g.id) }))
  };

  // ── 路由注册 ──
  await sdk.routes.register((app) => {
    app.get("/probe", (c) => c.json(probe.compact()));
    app.get("/probe/full", (c) => c.json(probe.state));

    // 启动自检结果。
    //
    // 存在的理由：BUG-043 那种"用了但没 import"的 bug，语法查不出、
    // 单测也可能不覆盖，只有真调到那条路径才会炸。把启动时的一次真实
    // 调用结果暴露出来，坏没坏不用等用户踩。
    app.get("/selfcheck", (c) => c.json(probe.state.selfCheck || { ok: null, note: "自检未运行" }));

    if (characterRepo && characterTransfer) {
      registerCharacterRoutes(app, characterRepo, characterTransfer, settingRepo);
    }
    if (conversationRepo && characterRepo) {
      registerConversationRoutes(app, conversationRepo, llmService, characterRepo, settingRepo, regexRepo, presetRepo, boardRepo);
    }
    if (variableRepo && conversationRepo) {
      registerVariableRoutes(app, variableRepo, conversationRepo, characterRepo);
    }
    if (settingRepo) {
      registerSettingRoutes(app, settingRepo, conversationRepo);
    }
    if (regexRepo) {
      registerRegexRoutes(app, regexRepo);
    }
    if (presetRepo) {
      registerPresetRoutes(app, presetRepo);
    }
    if (boardRepo) {
      registerBoardRoutes(app, boardRepo);
    }

    registerToolRoutes(app, sdk);

    // 向量（与工具共用一个 service，纪律只有一份）
    registerEmbedRoutes(app, sdk);

    if (dataDir) {
      registerMigrationRoutes(app, dataDir);
    }
  });
  probe.record("routes registered");

  // ── 启动自检 ──
  //
  // 治的是 BUG-043 那类问题：函数用了但没 import，语法查不出来，
  // 等到用户点到那个功能才炸。这里启动后直接调一次关键路径，
  // 结果落 probe-state.json——坏没坏一眼可查，不用等用户踩。
  //
  // 自检本身只是纯函数 + 一两次读盘，正常几毫秒。给它一个上限，
  // 超时就当"本次没验"，绝不拖住启动。
  //
  // 注：早先这里有两份自检（一份 fire-and-forget + 一份 await），
  // 每次启动跑两遍。合并成下面这一份——既然已经设了超时，
  // 就不需要 fire-and-forget 那份来"避免拖住启动"了。
  let selfCheck = null;
  if (conversationRepo && characterRepo) {
    selfCheck = await probe.safe(
      () => Promise.race([
        runSelfCheck({ conversationRepo, characterRepo, settingRepo }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("self-check 超时")), 3000))
      ]),
      "runSelfCheck"
    );
    if (selfCheck) {
      s.selfCheck = selfCheck;
      probe.record(
        selfCheck.ok
          ? `self-check OK (${selfCheck.checks.length} 项)`
          : `self-check FAILED: ${selfCheck.checks.filter(c => !c.ok).map(c => c.name).join(", ")}`
      );
    }
  }

  // ── 落盘探针状态 ──(自检已拿到结果，一起写进去)
  await probe.safe(() => probe.persist(dataDir), "persist probe state");
  probe.record("defineApp exited cleanly");

  // ── 清理函数 ──
  return () => {
    for (const r of receipts.reverse()) {
      try {
        r?.disposeAsync?.();
      } catch { /* 清理失败不应阻塞卸载 */ }
    }
  };
});
