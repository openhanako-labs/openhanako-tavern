// lib/media/routes.js — 出图的 HTTP 面
//
// v1 只做一件事：**给角色卡生成立绘，写回头像**。
// 选它是因为它接得上现成的机器（人物卡本来就有 avatar.<ext>，
// transfer.saveAvatar 早就在 ST 导入那条路上用了），不用给会话模型加字段。

import fs from "node:fs/promises";
import { route, notFound } from "../respond.js";
import { generateImage, status } from "./service.js";
import { portraitPrompt } from "./prompt.js";

const EXT_RE = /\.([a-z0-9]+)$/i;

/**
 * @param {object} app
 * @param {{sdk: object|null, characterRepo: object|null, transfer: object|null}} deps
 */
export function registerMediaRoutes(app, { sdk = null, characterRepo = null, transfer = null } = {}) {
  app.get("/media/status", route(async () => {
    return status(sdk);
  }));

  app.post("/media/portrait", route(async (c) => {
    const body = (await c.req.json().catch(() => ({}))) || {};
    const id = String(body.characterId || "").trim();
    if (!id) throw new Error("characterId is required");
    if (!characterRepo) throw new Error("角色仓储未就绪");
    if (!transfer) throw new Error("角色转移层未就绪");

    const card = await characterRepo.get(id);
    if (!card) throw notFound("Character not found");

    const { prompt, parts } = portraitPrompt(card, { extra: body.extra, style: body.style });
    const { paths } = await generateImage(sdk, {
      prompt,
      suggestedFilename: `portrait-${String(card.name || "char").slice(0, 24)}`
    });

    // 第一张当立绘。多张的情况等用户真的点了"多张"再说——现在不做选择器空壳。
    const file = paths[0];
    const buf = await fs.readFile(file);
    const ext = (EXT_RE.exec(file)?.[1] || "png").toLowerCase();
    const saved = await transfer.saveAvatar(id, buf, ext);

    return {
      ok: true,
      characterId: id,
      avatarExt: ext,
      file: saved,
      bytes: buf.length,
      prompt,
      parts
    };
  }));
}
