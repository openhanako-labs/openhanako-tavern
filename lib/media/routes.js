// lib/media/routes.js — 出图的 HTTP 面
//
// 两个后端，一个出口：
//   host    —— 宿主的媒体供应商（sdk.media），同步返回文件
//   comfyui —— 本机 ComfyUI，走 app/environments.manage 的 runTool，
//              提交 → 轮询 → 取产物（形状读 comfyui-hana 的工具手册定的）
//
// 出口统一是"给角色卡写回头像"——所以选哪个后端，对调用方是透明的；
// 响应里带 `via` 说清这一张是谁画的。

import fs from "node:fs/promises";
import { route, notFound } from "../respond.js";
import { generateImage, status, isAbsolutePath } from "./service.js";
import { portraitPrompt } from "./prompt.js";
import { ensureEnvironment, pickComfyTool, renderViaComfy } from "./comfy.js";
import {
  readImageConfig, writeImageConfig, mergeImageConfig, publicImageConfig, imageReadiness, BACKENDS
} from "./config.js";

const EXT_RE = /\.([a-z0-9]+)$/i;

/** 找一个能用的环境 + 里面的 ComfyUI 工具。找不到就说清卡在哪一步。 */
async function findComfy(sdk) {
  if (!sdk?.environments) {
    throw new Error("宿主没提供 app/environments.manage（manifest 里可能还缺这一条）");
  }
  const env = await ensureEnvironment(sdk);
  const cat = await sdk.environments.catalog({ environmentId: env.environmentId });
  const tool = pickComfyTool(cat);
  if (!tool) {
    throw new Error("环境里没有 ComfyUI 工具——装 ComfyUI-Hana 这个 App，并确认它是启用状态");
  }
  return { env, tool, extensions: Array.isArray(cat?.extensions) ? cat.extensions.length : 0 };
}

/**
 * @param {object} app
 * @param {{sdk: object|null, characterRepo: object|null, transfer: object|null, dataDir?: string|null}} deps
 */
export function registerMediaRoutes(app, { sdk = null, characterRepo = null, transfer = null, dataDir = null } = {}) {
  const needDataDir = () => {
    if (!dataDir) throw new Error("出图未就绪（App 数据目录不可用）");
    return dataDir;
  };

  // 宿主那条路能走吗
  app.get("/media/status", route(async () => status(sdk)));

  app.get("/media/engines", route(async () => {
    const cfg = dataDir ? await readImageConfig(dataDir) : { backend: "host", workflow: "", promptTarget: "" };
    const host = status(sdk);

    // 本机那条路：能列出环境、能找到 ComfyUI 工具，才算可用。
    // 这里刻意**真去找一次**——一个只报"配置齐了"的体检等于没体检。
    let comfy = { available: false, reason: "还没查", tool: null };
    try {
      const found = await findComfy(sdk);
      comfy = { available: true, reason: null, tool: found.tool.name, ref: found.tool.ref };
    } catch (e) {
      comfy = { available: false, reason: e?.message || String(e), tool: null };
    }

    const r = imageReadiness(cfg);
    return {
      backend: cfg.backend,
      workflows: cfg.workflow ? [cfg.workflow] : [],
      ready: r.ready,
      reason: r.reason,
      backends: BACKENDS,
      host: { available: host.available, reason: host.reason },
      comfyui: comfy
    };
  }));

  app.get("/media/config", route(async () => publicImageConfig(await readImageConfig(needDataDir()))));

  app.put("/media/config", route(async (c) => {
    const dir = needDataDir();
    const patch = (await c.req.json().catch(() => ({}))) || {};
    const next = mergeImageConfig(await readImageConfig(dir), patch);
    await writeImageConfig(dir, next);
    return publicImageConfig(next);
  }));

  // 本机 ComfyUI 里有哪些工作流可选（下拉要能填得对）
  app.get("/media/workflows", route(async () => {
    const { env, tool } = await findComfy(sdk);
    const r = await sdk.environments.runTool({
      environmentId: env.environmentId,
      revision: env.revision,
      ref: tool.ref,
      toolName: tool.name,
      args: { action: "workflows" }
    });
    return { ok: true, raw: r?.result ?? r };
  }));

  app.post("/media/portrait", route(async (c) => {
    const dir = needDataDir();
    const body = (await c.req.json().catch(() => ({}))) || {};
    const id = String(body.characterId || "").trim();
    if (!id) throw new Error("characterId is required");
    if (!characterRepo) throw new Error("角色仓储未就绪");
    if (!transfer) throw new Error("角色转移层未就绪");

    const card = await characterRepo.get(id);
    if (!card) throw notFound("Character not found");

    const cfg = await readImageConfig(dir);
    const backend = String(body.backend || cfg.backend || "host");

    const { prompt, parts, hasCharacter } = portraitPrompt(card, { extra: body.extra, style: body.style });

    let file = null;
    let via = backend;

    if (backend === "comfyui") {
      const r = imageReadiness(cfg);
      if (!r.ready) throw new Error(r.reason);
      const { env, tool } = await findComfy(sdk);
      const out = await renderViaComfy({
        sdk, env, tool,
        template: cfg.workflow,
        promptTarget: cfg.promptTarget,
        prompt
      });
      if (!isAbsolutePath(out.path)) throw new Error(`ComfyUI 给的产物路径读不了：${out.path}`);
      file = out.path;
    } else {
      via = "host";
      const { paths } = await generateImage(sdk, {
        prompt,
        // 卡名里可能有路径分隔符之类的怪东西——别把它当路径片段送到宿主那边去
        suggestedFilename: `portrait-${String(card.name || "char").replace(/[\\/:*?"<>|]/g, "_").slice(0, 24)}`
      });
      file = paths[0];
    }

    // 第一张当立绘。多张的情况等用户真的点了"多张"再说——现在不做选择器空壳。
    const buf = await fs.readFile(file);
    const saved = await transfer.saveAvatar(id, buf, EXT_RE.exec(file)?.[1] || "png");
    // 扩展名以**真正落盘的那个文件**为准：saveAvatar 会把认不得的扩展名换掉，
    // 这里再自己从原路径算一遍就会跟磁盘说的不一样——那就成了"界面报 png、盘上是别的"。
    const ext = (EXT_RE.exec(saved)?.[1] || "png").toLowerCase();

    return {
      ok: true,
      characterId: id,
      avatarExt: ext,
      file: saved,
      bytes: buf.length,
      via,
      source: file,
      prompt,
      parts,
      // 卡里什么角色信息都没有：图只能按风格画。
      // 这是**得说出来的话**，不是内部细节——不说的话用户会以为图不像她是卡写坏了。
      ...(hasCharacter ? {} : { warning: "这张卡里没有描述/性格/场景/标签，出图只会按风格画一张，不会像这个角色" })
    };
  }));
}
