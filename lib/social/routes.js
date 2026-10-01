// lib/social/routes.js — 虚拟社交 HTTP 面（第 7 期）
//
//   GET  /social/feed                    —— 动态列表（?characterId= 过滤）
//   POST /social/feed/post               —— 角色发动态（AI 生成内容）
//   POST /social/feed/:id/like           —— 玩家点赞（再点取消）
//   POST /social/feed/:id/comment        —— 玩家评论 → AI 以角色身份回应
//   DELETE /social/feed/:id              —— 删动态
//   GET  /social/config · PUT            —— 开关（enabled 默认 false）
//
// 主动单聊：POST /conversations/:id/proactive —— AI 以角色身份主动发一条
// （挂 kind="proactive"），复用现有对话存储与渲染。

import { route } from "../respond.js";
import { FeedRepo } from "./feed.js";
import { readConfig as readModelConfig, resolveTargetFor } from "../models/config.js";
import fs from "node:fs/promises";
import path from "node:path";

const CONFIG_FILE = "social.json";

async function readSocialConfig(dataDir) {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dataDir, CONFIG_FILE), "utf8"));
    return { enabled: raw?.enabled === true };
  } catch {
    return { enabled: false };
  }
}

async function writeSocialConfig(dataDir, cfg) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, CONFIG_FILE), JSON.stringify(cfg, null, 2), "utf8");
  return cfg;
}

/**
 * @param {object} app
 * @param {{sdk: object, dataDir: string, characterRepo: object, conversationRepo: object, llm: object}} deps
 */
export function registerSocialRoutes(app, { dataDir, characterRepo, conversationRepo, llm } = {}) {
  const feed = new FeedRepo(dataDir);
  feed.init().catch(() => {});

  const needLLM = () => {
    if (!llm || typeof llm.generate !== "function") throw new Error("模型服务未就绪");
    return llm;
  };
  const needEnabled = async () => {
    const cfg = await readSocialConfig(dataDir);
    if (!cfg.enabled) throw new Error("虚拟社交未开启——先在设置里打开");
    return cfg;
  };
  async function resolveTarget(purpose) {
    try {
      const cfg = await readModelConfig(dataDir);
      return resolveTargetFor(cfg, purpose);
    } catch { return null; }
  }

  app.get("/social/config", route(async () => readSocialConfig(dataDir)));

  app.put("/social/config", route(async (c) => {
    const body = await c.req.json().catch(() => ({})) || {};
    const cfg = await writeSocialConfig(dataDir, { enabled: body.enabled === true });
    return cfg;
  }));

  app.get("/social/feed", route(async (c) => {
    const characterId = c.req.query("characterId") || null;
    return { posts: await feed.list({ characterId }) };
  }));

  // 角色发动态（AI 生成内容：注入角色卡 + 近期聊天氛围）
  app.post("/social/feed/post", route(async (c) => {
    await needEnabled();
    const body = await c.req.json().catch(() => ({})) || {};
    const characterId = String(body.characterId || "");
    const card = await characterRepo?.get?.(characterId);
    if (!card) throw new Error("角色不存在");
    const llmSvc = needLLM();

    let text = String(body.text || "").trim();
    if (!text) {
      // AI 生成一条动态：像角色的口吻发一条朋友圈
      const r = await llmSvc.generate(
        [{ role: "user", content: `以「${card.name}」的第一人称口吻，发一条朋友圈动态（50-120 字）。可以写心情、日常、吐槽。只输出动态正文。` }],
        { systemPrompt: `你是角色「${card.name}」。${String(card.description || "").slice(0, 400)}`, maxTokens: 300, temperature: 0.9, target: await resolveTarget("suggest") }
      );
      text = String(r?.content ?? "").trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
      if (!text) throw new Error("模型没给出动态内容");
    }

    const post = await feed.addPost({ characterId, characterName: card.name, text });
    return { post };
  }));

  // 玩家点赞
  app.post("/social/feed/:id/like", route(async (c) => {
    const body = await c.req.json().catch(() => ({})) || {};
    return feed.toggleLike(c.req.param("id"), body.userName || "玩家");
  }));

  // 玩家评论 → AI 以角色身份回应（角色的回应也进评论流）
  app.post("/social/feed/:id/comment", route(async (c) => {
    await needEnabled();
    const postId = c.req.param("id");
    const body = await c.req.json().catch(() => ({})) || {};
    const text = String(body.text || "").trim();
    if (!text) throw new Error("评论内容为空");

    const feed2 = new FeedRepo(dataDir);
    const posts = await feed2.list({ limit: MAX_LOOKUP });
    const post = posts.find(p => p.id === postId);
    if (!post) throw new Error("动态不存在");

    const comments = await feed2.addComment(postId, { by: "玩家", text });
    // AI 回应（fail-open：回应失败不影响评论落盘）
    let reply = null;
    try {
      const llmSvc = needLLM();
      const card = await characterRepo?.get?.(post.characterId);
      const r = await llmSvc.generate(
        [{
          role: "user",
          content: `你发了一条朋友圈：「${post.text}」。玩家评论：「${text}」。以「${card?.name || post.characterName}」的口吻回一句评论（30 字以内）。只输出回复正文。`
        }],
        {
          systemPrompt: `你是角色「${card?.name || post.characterName}」。${String(card?.description || "").slice(0, 300)}`,
          maxTokens: 150, temperature: 0.8, target: await resolveTarget("suggest")
        }
      );
      reply = String(r?.content ?? "").trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
      if (reply) await feed2.addComment(postId, { by: post.characterName, text: reply, isCharacter: true });
    } catch { reply = null; }

    return { comments, reply };
  }));

  app.delete("/social/feed/:id", route(async (c) => {
    return feed.removePost(c.req.param("id"));
  }));

  // 主动单聊消息：AI 以角色身份在既有对话里发一条（kind="proactive"）
  app.post("/conversations/:id/proactive", route(async (c) => {
    await needEnabled();
    const convId = c.req.param("id");
    const conv = await conversationRepo?.get?.(convId);
    if (!conv) throw new Error("对话不存在");
    const llmSvc = needLLM();
    const card = await characterRepo?.get?.(conv.characterId);
    if (!card) throw new Error("角色不存在");

    // 近期对话摘要（最后 6 条）作为上下文
    const recent = (conv.messages || []).slice(-6)
      .map(m => `${m.role === "user" ? "玩家" : card.name}：${String(m.content ?? "").slice(0, 200)}`)
      .join("\n");

    const r = await llmSvc.generate(
      [{
        role: "user",
        content: [
          `玩家有一阵子没说话了。以「${card.name}」的口吻，主动给玩家发一条消息（60 字以内）。`,
          "可以是想起什么事、问候、吐槽、或者分享一个小瞬间——符合角色性格。",
          recent ? `最近的对话：\n${recent}` : "",
          "只输出消息正文。"
        ].filter(Boolean).join("\n\n")
      }],
      {
        systemPrompt: `你是角色「${card.name}」。${String(card.description || "").slice(0, 400)}`,
        maxTokens: 200, temperature: 0.85, target: await resolveTarget("suggest")
      }
    );
    const text = String(r?.content ?? "").trim();
    if (!text) throw new Error("模型没给出消息内容");

    const saved = await conversationRepo.addMessage(convId, "assistant", text, { kind: "proactive" });
    return { message: saved };
  }));
}

const MAX_LOOKUP = 200;

export default { registerSocialRoutes };
