// lib/illustration/service.js — 场景插图的核心管线（第 2 批 2.5）
//
// 一件事：把一个"场景描述"变成对话里的一张贴图。
//
// 四步走：
//   ① 拼提示词（复用 lib/illustration/prompt.js 的纪律，不编外貌）
//   ② 出图（复用 lib/media/service.js + lib/media/bytes.js，别重写）
//   ③ 落盘两份：
//       <dataDir>/media/<id>.png   —— App 自己的存储
//       <dataDir>/generated/<id>.png —— 图库自动扫的目录（见 notes-gallery-intake）
//   ④ 写台账（media-index.json）+ 追加一条消息（kind=illustration）
//
// 状态推进：
//   pending → ok（含 mediaId、file）
//   pending → failed（含 failReason，**宿主原话**带回来）
//
// 为什么不抛：这张图失败不应该让"整条回复"看起来失败。
//   回复是先落盘的（不带插图），插图是异步追加的另一条消息；
//   插图自己失败，UI 会看到 status=failed + failReason，用户知道发生了什么。
//
// 三处对得上（计划 §6）：
//   · 消息：追加到对话里
//   · 台账：写一条 kind=scene 的记录
//   · 文件：绝对路径，落两份

import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { ensureDir } from "../atomic.js";
import { generateImageRaw } from "../media/service.js";
import { readProductBytes, explainAttempts } from "../media/bytes.js";
import { sceneIllustrationPrompt } from "./prompt.js";
import { insert as indexInsert, MediaKind } from "../media/index-store.js";
import { readSceneConfig, sceneAutoTrigger } from "./config.js";
import { MessageRole, MessageKind } from "../conversations/model.js";

const MEDIA_DIR = "media";
const GENERATED_DIR = "generated";
const CHARACTERS_DIR = "characters";
const TIMEOUT_MS = 120_000;

// 立绘可能以多种扩展名落盘（saveAvatar 的白名单）；
// 按 png/webp/jpg/jpeg 的顺序找，找到第一个存在的就是。
const AVATAR_EXT = ["png", "webp", "jpg", "jpeg"];

function makeMediaId() {
  return `scene_${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * 找一个角色的立绘文件。
 *
 * 为什么自己扫目录而不走 transfer.readAvatar：
 *   · illustration 的 ctx 里没传 transfer（只有 characterRepo / conversationRepo）
 *   · transfer.readAvatar 回的是 buffer + ext，不是 path——本处要的是 path（传给宿主）
 *   · 扫一次目录很便宜，不会堆额外状态
 *
 * 找不到就返回 null（角色没立绘 → 退化成纯文生图，不报错）。
 */
async function findCharacterAvatar(dataDir, charId) {
  if (!charId) return null;
  const dir = path.join(dataDir, CHARACTERS_DIR, String(charId));
  for (const ext of AVATAR_EXT) {
    const p = path.join(dir, `avatar.${ext}`);
    try {
      const st = await fs.stat(p);
      if (st.isFile() && st.size > 0) return p;
    } catch { /* 继续试下一个扩展名 */ }
  }
  return null;
}

/**
 * 决定是否自动出图（供 conversations/routes 在保存回复前调用）。
 *
 * 返回值只有两种：
 *   { active: true }                       —— 走自动触发的路径
 *   { active: false, reason: "..." }       —— 静默跳过，把原因留在这条返回里
 *
 * 注意：这条**不决定要剥离标记**。剥离标记是无条件的——
 * 模型写了 [场景] 就永远从回复正文里去掉，避免 UI 里出现裸露的标记
 * 造成"这啥"的疑惑。
 */
export function shouldAutoIllustrate(cfg) {
  return sceneAutoTrigger(cfg);
}

/**
 * 带参考图失败时重试一次纯文生图。
 *
 * 为什么不直接把参考图失败判死：
 *   契约支持 ≠ 后端行为（见 plans/2026-09-27-recipe-integration.md §6）。providers.d.ts
 *   只声明了模型能不能吃图，没说能不能拿参考图做 i2i。宿主后端可能拒，可能默默忽略。
 *   拒了就把这张图判死 = 阻断出图，用户看到“场景插图失败”。不可接受。
 *
 *   所以：带参考图 → 拿到 ERR_REF_IMAGE_FAILED 码 → 重试不带参考图 →
 *   把结果标记为 degraded。上一批镜像失败也是同一个态度：不阻断，但把原因留在看得见的地方。
 *
 * @returns {Promise<{res: object, degraded: boolean, refError: string|null}>}
 */
async function callGenerateWithRetry(sdk, prompt, mediaId, referenceImages) {
  const baseArgs = {
    prompt,
    // 文件名里带 mediaId 后段：真机调试时能一眼对应
    suggestedFilename: `scene-${mediaId.slice(-8)}`
  };
  if (!referenceImages || !referenceImages.length) {
    // 本来就没参考图，不需要重试逻辑。直接走一次。
    return { res: await generateImageRaw(sdk, baseArgs), degraded: false, refError: null };
  }
  try {
    const res = await generateImageRaw(sdk, { ...baseArgs, referenceImages });
    return { res, degraded: false, refError: null };
  } catch (e) {
    // 只在确实因为参考图而失败时才重试；其他错误直接吐回给上层。
    if (e?.code !== "ERR_REF_IMAGE_FAILED") throw e;
    const refError = e?.message || String(e);
    const res = await generateImageRaw(sdk, baseArgs);
    return { res, degraded: true, refError };
  }
}

/**
 * 生成一张场景插图。
 *
 * @param {{sdk: object, dataDir: string, conversationRepo: object, characterRepo: object}} ctx
 *   sdk             —— 宿主 SDK（要有 media + resources）
 *   dataDir         —— App 数据目录
 *   conversationRepo —— 对话仓储（追加消息 + 回写状态）
 *   characterRepo    —— 角色仓储（读卡片字段）
 * @param {{
 *   conversationId: string,
 *   characterId: string,
 *   scene: string,
 *   speaker?: string,
 *   style?: string,
 *   source?: "auto" | "manual"   —— 谁在画。默认 auto；手动补一张传 "manual"
 * }} opts
 * @returns {Promise<{
 *   ok: boolean,
 *   skipped?: boolean,
 *   reason?: string,
 *   mediaId?: string,
 *   messageId?: string,
 *   status?: string,
 *   failReason?: string,
 *   prompt?: string,
 *   path?: string|null,
 *   mirrorPath?: string|null,
 *   bytes?: number|null,
 *   referenceImagesUsed?: boolean,
 *   degraded?: boolean,
 *   refNote?: string|null,
 *   refError?: string|null
 * }>}
 */
export async function generateSceneIllustration(ctx, opts) {
  const { sdk, dataDir, conversationRepo, characterRepo } = ctx;
  if (!sdk || !dataDir || !conversationRepo || !characterRepo) {
    throw new Error("ctx 缺 sdk / dataDir / conversationRepo / characterRepo");
  }

  const convId = String(opts.conversationId || "").trim();
  const charId = String(opts.characterId || "").trim();
  const scene = String(opts.scene || "").trim();
  const speaker = opts.speaker ? String(opts.speaker).trim() : null;

  if (!convId || !charId || !scene) {
    throw new Error("conversationId / characterId / scene 都必填");
  }

  const cfg = await readSceneConfig(dataDir);

  /*
   * 两道闸，别混用。
   *
   *   enabled —— 总闸。关掉后什么都不出，手动也不行。
   *              设置面板的开关文案与用户的预期都是这个。
   *   mode    —— **自动**触发的策略。off = 不发自动图；手动那条路仍然留给用户
   *              （设置面板写着「保留手动补一张入口」，config.js 也写着
   *              「保留 enabled=true 的语义用于手动补一张的入口」）。
   *
   * 这两件事曾经共用 sceneAutoTrigger 一道闸，于是 mode=off 时手动补一张也被挡死——
   * 面板说「能手动」，代码说「不能」。三处说法对不上，坏的是这里。
   * 【2026-09-27 修：手动只认总闸；自动才看 mode】
   */
  const manual = opts.source === "manual";
  if (manual) {
    if (!cfg.enabled) return { ok: false, skipped: true, reason: "scene.enabled=false" };
  } else {
    const gate = sceneAutoTrigger(cfg);
    if (!gate.active) {
      return { ok: false, skipped: true, reason: gate.reason };
    }
  }

  const card = await characterRepo.get(charId).catch(() => null);
  if (!card) throw new Error(`角色不存在: ${charId}`);

  // characterRef 关掉时，只留名字——名字用来标"这是谁在场景里"，
  // 描述/性格属于"她长什么样"，是这张图像不像她的关键，但用户明确关了就不带。
  const cardForPrompt = cfg.characterRef ? card : { name: card.name };

  const { prompt } = sceneIllustrationPrompt(cardForPrompt, {
    scene,
    speaker,
    style: cfg.style || null
  });

  // characterRef 开关同时控制"提示词带不带描述"与"要不要挂参考图"：
  // 两者语义上是一件事（都是"能不能把图往她脸上带"）。
  // 没有立绘→退化成纯文生图；不能阻断出图，但要留一条看得见的说明。
  let referenceImages = null;
  let refNote = null;
  if (cfg.characterRef) {
    const avatarPath = await findCharacterAvatar(dataDir, charId);
    if (avatarPath) {
      referenceImages = [{ kind: "local-file", path: avatarPath }];
    } else {
      // 不是错误：这张卡本来就没头像。但要跟后面那种“传图后被宿主吐回来”
      // 区分开——一个是“本来就没得用”，一个是“有但用不了”。
      refNote = "该角色没有立绘，参考图退化";
    }
  }

  const mediaId = makeMediaId();

  // 先追加一条 pending 消息：让 UI 立刻看到"这条回复要配一张图，正在画"。
  // 消息的 mediaId 就是最终台账里那条的 id，不用二次对齐。
  const pendingMsg = await conversationRepo.addMessage(convId, MessageRole.ASSISTANT, null, {
    kind: MessageKind.ILLUSTRATION,
    prompt: scene,
    status: "pending",
    mediaId,
    speakerId: charId,
    speakerName: speaker || card.name || ""
  });

  let filePath = null;
  let mirrorPath = null;
  let bytes = null;
  let status = "ok";
  let failReason = null;
  let degraded = false;
  let refError = null;

  try {
    const first = await callGenerateWithRetry(sdk, prompt, mediaId, referenceImages);

    let res = first.res;
    degraded = first.degraded;
    refError = first.refError;

    let got = await readProductBytes(sdk, res, { timeoutMs: TIMEOUT_MS });

    /*
     * 参考图的失败**不在提交时**，而在宿主后台任务跑完之后——取产物才发现。
     * 提交只是拿到 batchId，参考图不被支持的话，错误发生在宿主那边，
     * 根本不会在 callGenerateWithRetry 的 catch 里出现（2026-09-27 真机实测：
     * 开着 characterRef 时“Media task failed. Review the provider configuration”）。
     *
     * 所以降级重试必须挂在这一层：取不到字节 → 不带参考图再走一遍 →
     * 成功就当降级，还是失败才认输。浪费一次调用，总好过整张图没有。
     */
    if (!got.ok && referenceImages) {
      refError = `带参考图出图失败：${explainAttempts(got.attempts)}`;
      console.warn(`[illustration] 参考图导致出图失败（${charId}），改为纯文生图重试一次`);
      res = await generateImageRaw(sdk, {
        prompt,
        suggestedFilename: `scene-${mediaId.slice(-8)}`
      });
      got = await readProductBytes(sdk, res, { timeoutMs: TIMEOUT_MS });
      degraded = true;
    }

    if (!got.ok) {
      throw new Error(`取不到图片字节：${explainAttempts(got.attempts)}`);
    }
    bytes = got.buf.length;

    // ① <dataDir>/media/
    const mediaDir = path.join(dataDir, MEDIA_DIR);
    await ensureDir(mediaDir);
    filePath = path.join(mediaDir, `${mediaId}.png`);
    await fs.writeFile(filePath, got.buf);

    // ② <dataDir>/generated/ —— 图库自动扫这里（notes-gallery-intake 已核算）
    try {
      const genDir = path.join(dataDir, GENERATED_DIR);
      await ensureDir(genDir);
      mirrorPath = path.join(genDir, `${mediaId}.png`);
      await fs.writeFile(mirrorPath, got.buf);
    } catch (e) {
      // 镜像失败不阻断：主文件已经落盘、台账也要写。
      // 但把原因留在日志里——图库不收录这张，用户会疑惑。
      console.warn(`[illustration] 镜像到 generated/ 失败 ${mediaId}: ${e?.message}`);
    }
  } catch (e) {
    status = "failed";
    // 宿主原话带回来（计划判据 4）——不要把它换成一句笼统的"生成失败"。
    failReason = e?.message || String(e);
  }

  // 降级成功（带参考图失败→重试不带参考图）：不阻断，但把原因留到看得见的地方。
  // 跟上一批镜像失败的纪律一致——不隐吞，但也不当错误报。
  if (degraded) {
    console.warn(`[illustration] 参考图未生效（${charId}），已退化为纯文生图: ${refError}`);
  }

  // 台账（file 只有 ok 时才有值；pending / failed 都留占位）
  try {
    await indexInsert(dataDir, {
      id: mediaId,
      kind: MediaKind.SCENE,
      characterId: charId,
      conversationId: convId,
      messageId: pendingMsg.id,
      file: filePath || null,
      bytes,
      prompt,
      scene,
      taskId: null,
      createdAt: new Date().toISOString()
    });
  } catch (e) {
    // 台账登记失败不阻断主流程：图已经落盘，消息也在对话里。
    // 但要在日志里留话——否则图库找不到这张，用户以为是 bug。
    console.warn(`[illustration] 台账登记失败 ${mediaId}: ${e?.message}`);
  }

  // 回写消息状态
  try {
    await conversationRepo.setIllustrationStatus(convId, pendingMsg.id, {
      mediaId,
      status,
      ...(failReason ? { failReason } : {}),
      // 参考图那条路的两个信号得**落到消息上**：
      // 只放在这个函数的返回值里，UI 是永远看不到的——那条路是异步的，
      // 没有人会把这次的返回值带回去渲染。
      ...(degraded ? { degraded: true } : {}),
      ...(refNote ? { refNote } : {})
    });
  } catch (e) {
    console.warn(`[illustration] 回写消息状态失败 ${pendingMsg.id}: ${e?.message}`);
  }

  return {
    ok: status === "ok",
    mediaId,
    messageId: pendingMsg.id,
    status,
    failReason,
    prompt,
    path: filePath,
    mirrorPath,
    bytes,
    // 参考图路径：成功与降级都要告诉调用方。UI / 日志 / 调试能看得到。
    referenceImagesUsed: !!(referenceImages && referenceImages.length) && !degraded,
    degraded,
    refNote,
    refError
  };
}
