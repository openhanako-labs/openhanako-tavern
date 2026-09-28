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
import path from "node:path";
import { route, notFound, raw, httpError } from "../respond.js";
import { generateImage, status, isAbsolutePath } from "./service.js";
import { portraitPrompt } from "./prompt.js";
import { ensureEnvironment, pickComfyTool, renderViaComfy } from "./comfy.js";
import {
  readImageConfig, writeImageConfig, mergeImageConfig, publicImageConfig, imageReadiness, BACKENDS
} from "./config.js";
import {
  insert as indexInsert,
  getById as indexGet,
  list as indexList,
  getBytes as indexGetBytes,
  MediaKind
} from "./index-store.js";

const EXT_RE = /\.([a-z0-9]+)$/i;

// 立绘白名单。与 lib/characters/transfer.js 的 ALLOWED 保持一致。
const AVATAR_EXT = ["png", "webp", "jpg", "jpeg"];

/** 归一化一张参考图（契约：local-file / session-file）。 */
function normalizeRefImage(v) {
  if (!v || typeof v !== "object") return null;
  if (v.kind === "local-file" && typeof v.path === "string" && v.path.trim()) {
    return { kind: "local-file", path: v.path.trim() };
  }
  if (v.kind === "session-file" && typeof v.fileId === "string" && v.fileId.trim()) {
    return { kind: "session-file", fileId: v.fileId.trim() };
  }
  return null;
}

/** 归一化一组参考图，丢掉非法项。 */
function normalizeRefImages(v) {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  const out = [];
  for (const x of arr) {
    const n = normalizeRefImage(x);
    if (n) out.push(n);
  }
  return out.length ? out : null;
}

/**
 * 找一个角色现有的头像文件路径。找不回 null（本卡没头像 → 参考图退化）。
 */
async function findCharacterAvatar(characterRepo, id) {
  if (!characterRepo || !id) return null;
  const base = characterRepo.dir || characterRepo.charactersDir;
  if (!base) return null;
  for (const ext of AVATAR_EXT) {
    const p = path.join(base, String(id), `avatar.${ext}`);
    try {
      const st = await fs.stat(p);
      if (st.isFile() && st.size > 0) return p;
    } catch { /* 继续试下一个 */ }
  }
  return null;
}

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

    // 参考图：两条路行为分开
    //   · host：用户显式传 body.referenceImages / body.image 才带（顶层字段，不是 options）
    //   · comfyui：cfg.refImageTarget 配了就自动拿本角色已有头像当参考图；
    //              没配 / 没头像 → 纯文生图，不阻断。
    const extRefs = normalizeRefImages(body.referenceImages);
    const extSingle = normalizeRefImage(body.image);

    let file = null;
    let via = backend;
    let degraded = false;
    let refNote = null;

    if (backend === "comfyui") {
      const r = imageReadiness(cfg);
      if (!r.ready) throw new Error(r.reason);
      const { env, tool } = await findComfy(sdk);

      let refPath = null;
      if (cfg.refImageTarget) {
        // 自动拿本卡已有头像当参考图。没有就降级纯文生图，不阻断。
        refPath = await findCharacterAvatar(characterRepo, id);
        if (!refPath) refNote = "该卡没有头像，参考图退化";
      }

      const out = await renderViaComfy({
        sdk, env, tool,
        template: cfg.workflow,
        promptTarget: cfg.promptTarget,
        prompt,
        refImageTarget: cfg.refImageTarget || null,
        referenceImagePath: refPath || null
      });
      if (!isAbsolutePath(out.path)) throw new Error(`ComfyUI 给的产物路径读不了：${out.path}`);
      file = out.path;
      // 本应带参考图但 ComfyUI 那侧没写进去：不阻断，但记一下。
      degraded = !!(refPath && !out.usedReferenceImage);
    } else {
      via = "host";
      const genArgs = {
        prompt,
        // 卡名里可能有路径分隔符之类的怪东西——别把它当路径片段送到宿主那边去
        suggestedFilename: `portrait-${String(card.name || "char").replace(/[\\/:*?"<>|]/g, "_").slice(0, 24)}`
      };
      // 参考图以顶层字段传，不塞 options（契约定义，options 是 provider 自己的扩展位）
      if (extRefs) genArgs.referenceImages = extRefs;
      if (extSingle) genArgs.image = extSingle;

      try {
        const { paths } = await generateImage(sdk, genArgs);
        file = paths[0];
      } catch (e) {
        // 参考图引起的失败不阻断：重试一次纯文生图。契约支持≠后端行为，这条退化必须留。
        if (e?.code !== "ERR_REF_IMAGE_FAILED") throw e;
        const { paths } = await generateImage(sdk, { prompt, suggestedFilename: genArgs.suggestedFilename });
        file = paths[0];
        degraded = true;
        refNote = `参考图未生效：${e.message}`;
      }
    }

    // 第一张当立绘。多张的情况等用户真的点了"多张"再说——现在不做选择器空壳。
    const buf = await fs.readFile(file);
    const saved = await transfer.saveAvatar(id, buf, EXT_RE.exec(file)?.[1] || "png");
    // 扩展名以**真正落盘的那个文件**为准：saveAvatar 会把认不得的扩展名换掉，
    // 这里再自己从原路径算一遍就会跟磁盘说的不一样——那就成了"界面报 png、盘上是别的"。
    const ext = (EXT_RE.exec(saved)?.[1] || "png").toLowerCase();

    // 台账（第 1 批）：图刚写盘，马上登记一条。
    // 路径必须是绝对的——saveAvatar 回的是 `avatar.<ext>`，需要拼上角色的目录。
    // 登记失败不阻断主流程：图已经落盘了，台账丢一条不该让用户看到“生成失败”。
    const absPath = path.join(characterRepo.dir, id, saved);
    let mediaId = null;
    let indexError = null;
    try {
      const rec = await indexInsert(dataDir, {
        kind: MediaKind.PORTRAIT,
        characterId: id,
        file: absPath,
        bytes: buf.length,
        prompt,
        createdAt: new Date().toISOString()
      });
      mediaId = rec.id;
    } catch (e) {
      // 登记失败把原因留在响应里——不能静默吞。用户后面在图库里找不到这张时，
      // 至少能看一句为什么。
      indexError = e?.message || String(e);
      console.warn(`[media] 台账登记失败 characterId=${id}: ${indexError}`);
    }

    return {
      ok: true,
      characterId: id,
      avatarExt: ext,
      file: saved,
      path: absPath,
      bytes: buf.length,
      via,
      source: file,
      prompt,
      parts,
      mediaId,
      // 台账登记失败：不报错（图已经生成），但把原因放在这里。
      // 前端如果看到 indexError 非空，可以弹一行 toast 提醒。
      ...(indexError ? { indexError } : {}),
      // 卡里什么角色信息都没有：图只能按风格画。
      // 这是**得说出来的话**，不是内部细节——不说的话用户会以为图不像她是卡写坏了。
      ...(hasCharacter ? {} : { warning: "这张卡里没有描述/性格/场景/标签，出图只会按风格画一张，不会像这个角色" }),
      // 参考图路径上的可观察信号。degraded 非空时 UI 可弹一行提醒；
      // 用户不知道发生了什么 → 以为图不像她是因为模型不行，实际是参考图被吐回来了。
      ...(refNote ? { refNote } : {}),
      ...(degraded ? { degraded: true } : {})
    };
  }));

  // ── 图片台账（第 1 批）──
  //
  // 三个入口，一个台账文件。图库那边只读这个接口——
  // 不再靠扫目录猜哪张图属于哪个角色。
  //
  // 纪律：
  //   · file 全部是绝对路径。相对路径无从追溯（BUG-059 同源）。
  //   · 台账里没写 file 的记录（场景插图的生成中占位）不报错，直接返回；
  //     调用方自己判 bytes 存不存在。
  //   · 单条读不到（磁盘上文件被删）不整体 500：返回 {ok:false, fileMissing:true}，
  //     界面能看到具体原因而不是“生成失败”。

  app.get("/media/index", route(async (c) => {
    const q = c.req.query();
    const filter = {};
    if (q.kind) filter.kind = q.kind;
    if (q.characterId) filter.characterId = q.characterId;
    if (q.conversationId) filter.conversationId = q.conversationId;
    const records = await indexList(needDataDir(), filter);
    return { total: records.length, records };
  }));

  // 单条：返回记录本身。不带字节——前端要字节走 /media/index/:id（base64）。
  app.get("/media/index/:id", route(async (c) => {
    const rec = await indexGet(needDataDir(), c.req.param("id"));
    if (!rec) throw notFound(`台账里没有 id=${c.req.param("id")}`);
    return rec;
  }));

  // 字节：base64。与 /characters/:id/avatar.json 同一形状，方便前端共用一段逻辑。
  //
  // 为什么不直接回 raw bytes：<img src="/media/index/:id"> 会在真机里 403——
  // URL 里没有 /_surface/<票据>/ 那一段，<img> 不会自己带鉴权。
  // 所以 base64 走 JSON 通道，与头像那条路同一个方向。
  app.get("/media/:id", route(async (c) => {
    const out = await indexGetBytes(needDataDir(), c.req.param("id"));
    if (out?.ok === false) {
      // 不 500：文件确实存在但已删，是“可读的失败”。
      // 前端拿这个形状能区分“记录没了”与“文件没了”。
      throw httpError(out.reason || "读不到字节", 404);
    }
    return out;
  }));
}
