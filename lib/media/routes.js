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

    const { prompt, parts, hasCharacter } = portraitPrompt(card, { extra: body.extra, style: body.style });
    const { paths } = await generateImage(sdk, {
      prompt,
      // 卡名里可能有路径分隔符之类的怪东西——别把它当路径片段送到宿主那边去
      suggestedFilename: `portrait-${String(card.name || "char").replace(/[\\/:*?"<>|]/g, "_").slice(0, 24)}`
    });

    // 第一张当立绘。多张的情况等用户真的点了"多张"再说——现在不做选择器空壳。
    const file = paths[0];
    const buf = await fs.readFile(file);
    const saved = await transfer.saveAvatar(id, buf, EXT_RE.exec(file)?.[1] || "png");
    // 扩展名以**真正落盘的那个文件**为准：saveAvatar 会把认不得的扩展名换掉，
    // 这里再自己从原路径算一遍就会跟磁盘说的不一样——那就成了“界面报 png、盘上是别的”。
    const ext = (EXT_RE.exec(saved)?.[1] || "png").toLowerCase();

    return {
      ok: true,
      characterId: id,
      avatarExt: ext,
      file: saved,
      bytes: buf.length,
      prompt,
      parts,
      // 卡里什么角色信息都没有：图只能按风格画。
      // 这是**得说出来的话**，不是内部细节——不说的话用户会以为图不像她是卡写坏了。
      ...(hasCharacter ? {} : { warning: "这张卡里没有描述/性格/场景/标签，出图只会按风格画一张，不会像这个角色" })
    };
  }));
}
