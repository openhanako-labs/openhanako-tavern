// test/regression-scene-ref.mjs — 场景插图 · 参考图通路
//
// 判据（R1）：
//   · characterRef=true（默认）+ 角色有头像 → 自动把 <dataDir>/characters/<id>/avatar.<ext>
//     当参考图，作为顶层 referenceImages 传给 sdk.media.generateImage
//   · 没头像 → 退化纯文生图（不打断出图），response.refNote 明说
//   · 后端拒绝带参考图的请求（ERR_REF_IMAGE_FAILED）→ 重试不带参考图，degraded=true
//   · characterRef=false → 不带参考图（不管有没有头像），也不带描述
//
// 反证：
//   · 把自动挂载头像去掉 → ① 立刻红
//   · 把 referenceImages 塞进 options 而不是顶层 → ① 立刻红
//   · 把参考图失败后的重试去掉 → ③ 立刻红
//   · 把 characterRef=false 的分支改成带参考图 → ④ 立刻红
//
// 契约说明：**契约通 ≠ 后端行为**。providers.d.ts 那层只有 `input: ("text"|"image")[]`，
// 没有「能不能吃参考图做 i2i」的语义说明。本测试只锁"字段形状与降级路径"，
// 后端是否真的读这个字段——**未验证**。

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";

import { generateSceneIllustration } from "../lib/illustration/service.js";
import { writeSceneConfig, emptySceneConfig } from "../lib/illustration/config.js";
import { ConversationRepo } from "../lib/conversations/repo.js";
import { CharacterRepo } from "../lib/characters/repo.js";

let pass = 0;
const failed = [];
async function ok(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed.push(name);
    console.error(`  ❌ ${name}\n     ${e?.message || e}`);
  }
}

console.log("\n=== 场景插图 · 参考图通路 ===\n");

/**
 * 假 sdk：完整跑一次"提交 → 换 taskId → 换资源 → 读字节"。
 *
 * opts.failWithRef = true 时：
 *   如果 input.referenceImages / input.image 存在，抛错。
 *   用来验证"带参考图失败 → 重试不带参考图"这条退化路径。
 */
function fakeSdk({ failWithRef = false, imageBytes = null } = {}) {
  const png = imageBytes || Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const state = {
    calls: [],
    batchId: "batch_test_1",
    taskId: "task_test_1",
    fileId: "file_test_1",
    sessionId: "session_test_1",
    lastReferenceImages: null
  };
  const check = (cond, msg) => { if (!cond) throw new Error(msg); };

  return {
    media: {
      async generateImage({ scope, input }) {
        state.calls.push({ scope, input });
        state.lastReferenceImages = input?.referenceImages || input?.image || null;
        check(scope === "app", `scope 应为 app，实为 ${scope}`);
        check(input?.delivery?.mode === "response",
          `delivery.mode 必须是 response，实为 ${input?.delivery?.mode}`);
        if (failWithRef && state.lastReferenceImages) {
          throw new Error("provider does not support reference image");
        }
        return { ok: true, kind: "image", batchId: state.batchId, prompt: input?.prompt };
      },
      async listTasks({ batchId, scope }) {
        return { tasks: [{ taskId: state.taskId, batchId, status: "completed",
          completedAt: new Date().toISOString() }] };
      },
      async getTaskResources(taskId, { scope }) {
        return { resources: [{ resource: { kind: "session-file",
          fileId: state.fileId, sessionId: state.sessionId } }] };
      }
    },
    resources: {
      async read({ kind, fileId, sessionId }) {
        check(kind === "session-file");
        check(fileId === state.fileId);
        check(sessionId === state.sessionId);
        return png;
      }
    },
    _state: state
  };
}

async function makeFixture({ withAvatar = true, avatarExt = "png" } = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tavern-scene-ref-"));
  const dataDir = path.join(tmp, "app-data");
  await mkdir(dataDir, { recursive: true });

  const convRepo = new ConversationRepo(dataDir);
  await convRepo.init();
  const charRepo = new CharacterRepo(dataDir);
  await charRepo.init();

  await charRepo.create({
    id: "char-1",
    name: "薇拉",
    description: "银灰长发",
    personality: "话少"
  });

  // 在角色目录下落一个真实存在的 avatar.<ext>
  if (withAvatar) {
    const charDir = path.join(dataDir, "characters", "char-1");
    await mkdir(charDir, { recursive: true });
    await writeFile(path.join(charDir, `avatar.${avatarExt}`), Buffer.alloc(64, 1));
  }

  return { tmp, dataDir, convRepo, charRepo };
}

// ① characterRef=true + 有头像 → 自动挂上参考图，且是顶层字段
await ok("① characterRef=true + 有头像 → 参考图作为顶层 referenceImages 传下去", async () => {
  const { tmp, dataDir, convRepo, charRepo } = await makeFixture();
  try {
    const conv = await convRepo.create("char-1");
    await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: true, characterRef: true });

    const sdk = fakeSdk();
    const r = await generateSceneIllustration(
      { sdk, dataDir, conversationRepo: convRepo, characterRepo: charRepo },
      { conversationId: conv.id, characterId: "char-1", scene: "窗前" }
    );
    assert.equal(r.ok, true, `不该失败：${r.failReason}`);
    assert.equal(r.degraded, false);
    assert.equal(r.referenceImagesUsed, true, "该报告确实带上了参考图");

    // 检查 sdk 收到的 input 形状：顶层字段，不是 options
    assert.equal(sdk._state.calls.length, 1, "只应提交一次");
    const input = sdk._state.calls[0].input;
    assert.ok(input.referenceImages, "input 里应有 referenceImages 顶层字段");
    assert.ok(Array.isArray(input.referenceImages), "referenceImages 应为数组");
    assert.equal(input.referenceImages.length, 1, "只挂一张头像");
    assert.equal(input.referenceImages[0].kind, "local-file");
    assert.match(input.referenceImages[0].path, /avatar\.png$/,
      `参考图路径应指向卡上头像，实为 ${input.referenceImages[0].path}`);
    assert.ok(!("referenceImages" in (input.options || {})),
      "options 里不该有 referenceImages（契约要求顶层）");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ② 没头像 → 退化纯文生图，refNote 明说，不阻断
await ok("② 没头像 → 退化纯文生图 + refNote（不打断出图）", async () => {
  const { tmp, dataDir, convRepo, charRepo } = await makeFixture({ withAvatar: false });
  try {
    const conv = await convRepo.create("char-1");
    await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: true, characterRef: true });

    const sdk = fakeSdk();
    const r = await generateSceneIllustration(
      { sdk, dataDir, conversationRepo: convRepo, characterRepo: charRepo },
      { conversationId: conv.id, characterId: "char-1", scene: "窗前" }
    );
    assert.equal(r.ok, true, `没头像不该让出图失败：${r.failReason}`);
    assert.equal(r.referenceImagesUsed, false);
    assert.equal(r.degraded, false, "主动退化不是失败——不该标 degraded");
    assert.ok(r.refNote, "没头像时 response 里得有 refNote");
    assert.match(r.refNote, /没有立绘|参考图退化/);

    // 且 sdk 收到的 input 里没有 referenceImages
    assert.ok(!sdk._state.calls[0].input.referenceImages,
      "没头像时不该传空 referenceImages 数组");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ③ 后端拒绝带参考图的请求 → 重试不带参考图 → degraded=true
await ok("③ 后端拒参考图 → 重试不带 → degraded=true + refError", async () => {
  const { tmp, dataDir, convRepo, charRepo } = await makeFixture();
  try {
    const conv = await convRepo.create("char-1");
    await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: true, characterRef: true });

    const sdk = fakeSdk({ failWithRef: true });
    const r = await generateSceneIllustration(
      { sdk, dataDir, conversationRepo: convRepo, characterRepo: charRepo },
      { conversationId: conv.id, characterId: "char-1", scene: "窗前" }
    );
    assert.equal(r.ok, true, `参考图引起的失败不该让出图失败：${r.failReason}`);
    assert.equal(r.degraded, true, "response 里必须显式标 degraded");
    assert.equal(r.referenceImagesUsed, false, "退化为不带参考图后，referenceImagesUsed 应为 false");
    assert.ok(r.refError, "退化的原因该留在 refError 里");
    assert.match(r.refError, /provider does not support|reference image|参考图/);

    // sdk 应收到两次调用：第一次带参考图（失败），第二次不带（成功）
    assert.equal(sdk._state.calls.length, 2, "应重试一次");
    assert.ok(sdk._state.calls[0].input.referenceImages, "第一次该带参考图");
    assert.ok(!sdk._state.calls[1].input.referenceImages,
      "重试那次不该带参考图");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ④ characterRef=false → 不带参考图（不管有没有头像）
await ok("④ characterRef=false → 不带参考图 + prompt 里也不含描述", async () => {
  const { tmp, dataDir, convRepo, charRepo } = await makeFixture(); // 头像存在，但不应被用上
  try {
    const conv = await convRepo.create("char-1");
    await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: true, characterRef: false });

    const sdk = fakeSdk();
    const r = await generateSceneIllustration(
      { sdk, dataDir, conversationRepo: convRepo, characterRepo: charRepo },
      { conversationId: conv.id, characterId: "char-1", scene: "窗前" }
    );
    assert.equal(r.ok, true);
    assert.equal(r.referenceImagesUsed, false);
    // prompt 里不含"银灰长发"（描述被剔除了）
    assert.ok(!r.prompt.includes("银灰长发"));
    // sdk 收到的 input 里没有 referenceImages
    assert.ok(!sdk._state.calls[0].input.referenceImages,
      "characterRef=false 时不该带参考图");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ⑤ 头像扩展名不是 png 也认得（webp 落盘）
await ok("⑤ 头像扩展名 webp → 也认得，路径以真实文件为准", async () => {
  const { tmp, dataDir, convRepo, charRepo } = await makeFixture({ withAvatar: true, avatarExt: "webp" });
  try {
    const conv = await convRepo.create("char-1");
    await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: true, characterRef: true });

    const sdk = fakeSdk();
    const r = await generateSceneIllustration(
      { sdk, dataDir, conversationRepo: convRepo, characterRepo: charRepo },
      { conversationId: conv.id, characterId: "char-1", scene: "窗前" }
    );
    assert.equal(r.ok, true);
    assert.equal(r.referenceImagesUsed, true);
    assert.match(sdk._state.calls[0].input.referenceImages[0].path, /avatar\.webp$/,
      "参考图路径应指向 webp 头像");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ⑥ 两个信号必须**落到消息上**（response 里不算数）
//
// 为何单钉这一条：response 里的 degraded / refNote 是给**调用方**看的，
// 而插图这条路是异步的——没有人会把那次 response 带回去渲染。
// 只放 response、不落消息，UI 就永远看不到“这张图没带上她”。
// （setIllustrationStatus 从前是白名单式的，未知字段一律忽略——传了也白传。）
await ok("⑥ degraded / refNote 落到消息上（不然 UI 永远看不见）", async () => {
  // 甲：有立绘但后端拒 → degraded
  {
    const { tmp, dataDir, convRepo, charRepo } = await makeFixture();
    try {
      const conv = await convRepo.create("char-1");
      await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: true, characterRef: true });

      const sdk = fakeSdk({ failWithRef: true });
      const r = await generateSceneIllustration(
        { sdk, dataDir, conversationRepo: convRepo, characterRepo: charRepo },
        { conversationId: conv.id, characterId: "char-1", scene: "窗前" }
      );
      assert.equal(r.degraded, true);

      const fresh = await convRepo.get(conv.id);
      const msg = fresh.messages.find(m => m.kind === "illustration");
      assert.ok(msg, "该有插图消息");
      assert.equal(msg.degraded, true, "degraded 没落到消息上 → UI 永远看不见");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  // 乙：本来就没立绘 → refNote（不是 degraded）
  {
    const { tmp, dataDir, convRepo, charRepo } = await makeFixture({ withAvatar: false });
    try {
      const conv = await convRepo.create("char-1");
      await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: true, characterRef: true });

      const sdk = fakeSdk();
      const r = await generateSceneIllustration(
        { sdk, dataDir, conversationRepo: convRepo, characterRepo: charRepo },
        { conversationId: conv.id, characterId: "char-1", scene: "窗前" }
      );
      assert.ok(r.refNote);

      const fresh = await convRepo.get(conv.id);
      const msg = fresh.messages.find(m => m.kind === "illustration");
      assert.ok(msg);
      assert.equal(msg.refNote, r.refNote, "refNote 没落到消息上");
      assert.notEqual(msg.degraded, true,
        "没立绘与「有但用不了」不是一回事：前者不该标成 degraded");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
});

if (failed.length) {
  console.log(`\n❌ 场景插图参考图：${pass} 过 / ${failed.length} 败\n`);
  process.exit(1);
}
console.log(`\n✅ 场景插图参考图：${pass} 过 / 0 败\n`);
