// lib/sprite/routes.js — 立绘点击反应 HTTP 面（第 5 期）
//
//   POST /characters/:id/sprite-reactions/generate  —— LLM 生成热区+反应，存卡上
//   POST /characters/:id/sprite-reactions/pick      —— 求值一次点击（x/y 百分比）
//   DELETE /characters/:id/sprite-reactions         —— 清除
//   GET  /characters/:id/sprite-reactions           —— 读取
//
// 存取：characterRepo.update(cardId, { sprite_reactions }) —— 与其他卡字段同一条路。
// 求值是纯函数（pickReaction），HTTP 面只是给前端一个"带 rng 的服务端掷点"入口；
// 前端通常本地求值（同一模块的浏览器镜像不依赖 Node），这里主要给 Agent 工具用。

import { route, notFound } from "../respond.js";
import { pickReaction, validateSpriteReactions, buildSpritePrompt } from "./click.js";
import { readConfig as readModelConfig, resolveTargetFor } from "../models/config.js";

export function registerSpriteRoutes(app, { characterRepo = null, llm = null, dataDir = null } = {}) {
  const needRepo = () => {
    if (!characterRepo) throw new Error("角色仓储未就绪");
    return characterRepo;
  };

  // 生成：LLM 按卡描述 + 立绘尺寸设计热区与反应
  app.post("/characters/:id/sprite-reactions/generate", route(async (c) => {
    const repo = needRepo();
    const id = c.req.param("id");
    const card = await repo.get(id);
    if (!card) throw notFound("Character not found");
    if (!llm || typeof llm.generate !== "function") throw new Error("模型服务未就绪");

    const body = (await c.req.json().catch(() => ({}))) || {};
    const image = { width: Number(body.width) || 0, height: Number(body.height) || 0 };

    let target = null;
    try {
      const cfg = dataDir ? await readModelConfig(dataDir) : null;
      target = cfg ? resolveTargetFor(cfg, "suggest") : null;  // 轻量创作路，与建议同族
    } catch { target = null; }

    const { systemPrompt, userPrompt } = buildSpritePrompt(card, image);
    const r = await llm.generate([{ role: "user", content: userPrompt }], {
      systemPrompt,
      maxTokens: 900,
      temperature: 0.7,
      target
    });

    // 清洗：剥代码围栏 → JSON.parse → 校验
    let raw = String(r?.content ?? "").trim()
      .replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
    let data;
    try { data = JSON.parse(raw); } catch {
      throw new Error("模型没输出合法 JSON——重试一次通常能好");
    }
    const errors = validateSpriteReactions(data);
    if (errors.length > 0) throw new Error("生成结果不合格：\n" + errors.join("\n"));

    data.at = new Date().toISOString();
    await repo.update(id, { sprite_reactions: data });
    return { ok: true, sprite_reactions: data };
  }));

  // 求值一次点击
  app.post("/characters/:id/sprite-reactions/pick", route(async (c) => {
    const repo = needRepo();
    const id = c.req.param("id");
    const card = await repo.get(id);
    if (!card) throw notFound("Character not found");
    const body = (await c.req.json().catch(() => ({}))) || {};
    const x = Number(body.x), y = Number(body.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x/y 必须是百分比数字");
    const hit = pickReaction(card.sprite_reactions, x, y);
    if (!hit) return { hit: false };
    return { hit: true, zone: hit.zone, expr: hit.reaction?.expr ?? "", text: hit.reaction?.text ?? "" };
  }));

  // 读取
  app.get("/characters/:id/sprite-reactions", route(async (c) => {
    const card = await needRepo().get(c.req.param("id"));
    if (!card) throw notFound("Character not found");
    return { sprite_reactions: card.sprite_reactions ?? null };
  }));

  // 清除
  app.delete("/characters/:id/sprite-reactions", route(async (c) => {
    const id = c.req.param("id");
    const card = await needRepo().get(id);
    if (!card) throw notFound("Character not found");
    await needRepo().update(id, { sprite_reactions: null });
    return { ok: true };
  }));
}

export default { registerSpriteRoutes };
