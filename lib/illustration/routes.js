// lib/illustration/routes.js — 场景插图的 HTTP 面（第 2 批 2.6）
//
// 三条端点：
//   GET  /illustration/config           —— 读场景插图配置
//   PUT  /illustration/config           —— 写场景插图配置
//   POST /conversations/:id/illustrate  —— 手动补一张（用户显式给了画面描述）
//   GET  /conversations/:id/illustration/latest —— 前端判断"生成中"用
//
// 与 lib/media/routes.js 的分工：
//   · media 管立绘（角色卡的头像），也管台账的读写端点
//   · illustration 管场景插图（对话里的一条消息），配置走本文件的端点
//
// 手动补一张的语义（plan 2.6）：
//   · 用户在对话里显式说"这一幕我想看"—— 直接走这条路由
//   · 不解析 [场景] 标记：整段描述当描述用（spec §5 的例外）
//   · **只认总闸 enabled**：关掉时不生成、返回 skipped。
//     mode=off 管的是**自动**触发，不该把手动这条路一起堵死
//     （旧版复用 sceneAutoTrigger，于是 mode=off 时手动也死了）

import { route, notFound } from "../respond.js";
import {
  readSceneConfig, writeSceneConfig, mergeSceneConfig, publicSceneConfig
} from "./config.js";
import { generateSceneIllustration } from "./service.js";
import { generateBackground, guessSceneText, BACKGROUND_DEFAULTS } from "./background.js";
import { readJsonSafe, writeJsonLocked } from "../atomic.js";
import { AppearanceRepo } from "../appearance/repo.js";
import { generateImageRaw } from "../media/service.js";
import { readProductBytes } from "../media/bytes.js";
import { readConfig as readModelConfig, resolveTargetFor } from "../models/config.js";
import path2 from "node:path";

/** 与 conversations/routes.js 同一实现：按 purpose 解析模型目标，失败回 null。 */
async function resolveModelTarget(dataDir, purpose) {
  if (!dataDir) return null;
  try {
    const cfg = await readModelConfig(dataDir);
    return resolveTargetFor(cfg, purpose);
  } catch {
    return null;
  }
}

const BG_CONFIG_FILE = "background.json";

async function readBackgroundConfig(dataDir) {
  const raw = await readJsonSafe(path2.join(dataDir, BG_CONFIG_FILE), null);
  return { ...BACKGROUND_DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
}
async function writeBackgroundConfig(dataDir, cfg) {
  await writeJsonLocked(path2.join(dataDir, BG_CONFIG_FILE), cfg);
  return cfg;
}

/**
 * @param {object} app
 * @param {{
 *   sdk: object,
 *   dataDir: string,
 *   conversationRepo: object,
 *   characterRepo: object,
 *   llm?: object
 * }} deps
 */
export function registerIllustrationRoutes(app, { sdk, dataDir, conversationRepo, characterRepo, llm } = {}) {
  const needDataDir = () => {
    if (!dataDir) throw new Error("场景插图未就绪（App 数据目录不可用）");
    return dataDir;
  };

  // 配置：默认关，用户自己打开。
  app.get("/illustration/config", route(async () => {
    return publicSceneConfig(await readSceneConfig(needDataDir()));
  }));

  app.put("/illustration/config", route(async (c) => {
    const dir = needDataDir();
    const patch = (await c.req.json().catch(() => ({}))) || {};
    const next = mergeSceneConfig(await readSceneConfig(dir), patch);
    await writeSceneConfig(dir, next);
    return publicSceneConfig(next);
  }));

  // 手动补一张。
  //
  // 与"回复末尾带 [场景]"的路径共用同一个 service（generateSceneIllustration），
  // 差别只在：这里的 scene 文本来自用户显式输入，不经过标记解析。
  app.post("/conversations/:id/illustrate", route(async (c) => {
    const convId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) || {};
    const scene = String(body.scene || "").trim();
    if (!scene) throw new Error("scene 必填：这一句的画面描述");

    const conv = await conversationRepo.get(convId);
    if (!conv) throw notFound("Conversation not found");

    // 没指定角色时用对话的主角；群聊里想给哪一位配图就显式传 characterId
    const charId = body.characterId ? String(body.characterId) : conv.characterId;
    const speaker = body.speaker ? String(body.speaker) : null;

    return await generateSceneIllustration(
      { sdk, dataDir, conversationRepo, characterRepo },
      // source: "manual" —— 这条是用户点出来的，只受总闸管，不受 mode 管。
      { conversationId: convId, characterId: charId, scene, speaker, source: "manual" }
    );
  }));

  // 前端轮询用：这一场里最新的插图消息及其状态。
  //
  // 前端在 SSE done 后看到"回复末尾有 [场景]"、且自动触发生效时，
  // 可以据此在后台定期问一次，看到 status 从 pending 变 ok/failed 就重画。
  app.get("/conversations/:id/illustration/latest", route(async (c) => {
    const conv = await conversationRepo.get(c.req.param("id"));
    if (!conv) throw notFound("Conversation not found");
    const msgs = (conv.messages || []).filter(m => m.kind === "illustration");
    const latest = msgs[msgs.length - 1] || null;
    return { latest, total: msgs.length };
  }));

  // ── AI 背景图（第 4 期）────────────────────────────

  // 读背景配置（含默认值）
  app.get("/background/config", route(async () => {
    return readBackgroundConfig(needDataDir());
  }));

  // 写背景配置（enabled / style / backend）
  app.put("/background/config", route(async (c) => {
    const dir = needDataDir();
    const body = (await c.req.json().catch(() => ({}))) || {};
    const cur = await readBackgroundConfig(dir);
    const next = { ...cur };
    if (body.enabled !== undefined) next.enabled = body.enabled === true;
    if (body.style !== undefined) next.style = body.style === "clip" ? "clip" : "natural";
    if (body.backend !== undefined) next.backend = body.backend === "comfyui" ? "comfyui" : "host";
    await writeBackgroundConfig(dir, next);
    return next;
  }));

  // 生成背景图并应用：场景文本 → LLM 写提示词（禁人物）→ 出图 → AppearanceRepo
  app.post("/background/generate", route(async (c) => {
    const dir = needDataDir();
    const cfg = await readBackgroundConfig(dir);
    if (cfg.enabled !== true) throw new Error("背景图生成未开启（background.json enabled=false）——先在设置里打开");

    const body = (await c.req.json().catch(() => ({}))) || {};
    let sceneText = String(body.sceneText || "").trim();
    if (!sceneText && body.conversationId) {
      const conv = await conversationRepo.get(body.conversationId);
      sceneText = guessSceneText(conv) || "";
    }
    if (!sceneText) throw new Error("场景描述为空：传 sceneText 或指定有剧情卡的对话");

    const backend = body.backend || cfg.backend || "host";
    const r = await generateBackground({
      sdk,
      llm,
      resolveTarget: (purpose) => resolveModelTarget(dir, purpose),
      sceneText,
      config: { ...cfg, backend },
      host: { generateImageRaw, readProductBytes }
    });

    // 落盘：与 appearance 同仓库同存储（前端 #app-bg 自动生效）
    const appearanceRepo = new AppearanceRepo(dir);
    await appearanceRepo.init();
    const ext = r.mime === "image/jpeg" ? "jpg" : "png";
    await appearanceRepo.saveImage(r.bytes, ext);

    return { via: r.via, prompt: r.prompt, applied: true };
  }));
}
