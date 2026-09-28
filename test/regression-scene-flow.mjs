// test/regression-scene-flow.mjs — 场景插图端到端（第 2 批 2.9）
//
// 判据：
//   · service 拿到场景描述 → 真调 sdk → 落 <dataDir>/media/ 与 <dataDir>/generated/
//   · 台账写一条 kind=scene 记录（含 mediaId / characterId / conversationId / messageId）
//   · 对话里追加一条 kind=illustration 消息；成功 status=ok，失败 status=failed 且带 failReason
//   · scene.enabled=false 或 mode=off → skipped，不出图、不加消息
//   · 手动补一张的入口（routes）能打通
//   · 出图失败 → 消息里写明宿主原话（判据 4）
//   · 反证：把镜像路径去掉、把 failReason 丢掉、把 mediaId 塞错 —— 都会让下面某条变红
//
// 用假 sdk：sdk.media.generateImage / listTasks / getTaskResources 与 sdk.resources.read 全部内存实现，
// 不真调宿主、不真出图。

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, access, readFile, stat } from "node:fs/promises";

import { generateSceneIllustration, shouldAutoIllustrate } from "../lib/illustration/service.js";
import { readSceneConfig, writeSceneConfig, emptySceneConfig } from "../lib/illustration/config.js";
import { list as indexList } from "../lib/media/index-store.js";
import { ConversationRepo } from "../lib/conversations/repo.js";
import { CharacterRepo } from "../lib/characters/repo.js";
import { registerIllustrationRoutes } from "../lib/illustration/routes.js";
import { makeApp, request } from "./lib/route-harness.mjs";

// ── 假 sdk：把一次完整的"提交 → 换 taskId → 换资源 → 读字节"跑通 ──

function fakeSdk({ prompt = "测试提示词", failGenerate = false, failResources = false, imageBytes = null } = {}) {
  const png = imageBytes || Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const state = {
    generatedPrompt: null,
    batchId: "batch_test_1",
    taskId: "task_test_1",
    fileId: "file_test_1",
    sessionId: "session_test_1",
    sawDeliveryMode: null
  };

  // 不用 assert：它的错误码是 ERR_ASSERTION，
  // 会被 lib/media/service.js 的 catch 包装成"出图失败：ERR_ASSERTION"
  // —— 测试就无法看到断言里那句话。改为手动拼错误消息。
  const check = (cond, msg) => { if (!cond) throw new Error(msg); };

  return {
    media: {
      async generateImage({ scope, input }) {
        // sdk.media.generateImage 收到的是 { scope, input: { prompt, suggestedFilename, delivery, options } }
        // （见 lib/media/service.js 的 generateImageRaw）
        state.generatedPrompt = input?.prompt;
        state.sawDeliveryMode = input?.delivery?.mode;
        check(scope === "app", `假 sdk：scope 应为 app，实为 ${scope}`);
        check(input?.delivery?.mode === "response", `假 sdk：delivery.mode 必须是 response，实为 ${input?.delivery?.mode}`);
        if (failGenerate) throw new Error("宿主假装：出图引擎挂了");
        return { ok: true, kind: "image", batchId: state.batchId, prompt: input?.prompt };
      },
      async listTasks({ batchId, scope }) {
        check(batchId === state.batchId, `假 sdk：batchId 不匹配，收到 ${batchId}`);
        check(scope === "own", `假 sdk：scope 应为 own，实为 ${scope}`);
        return {
          tasks: [{
            taskId: state.taskId,
            batchId,
            status: "completed",
            completedAt: new Date().toISOString()
          }]
        };
      },
      async getTaskResources(taskId, { scope }) {
        check(taskId === state.taskId, `假 sdk：taskId 不匹配，收到 ${taskId}`);
        check(scope === "own", `假 sdk：scope 应为 own，实为 ${scope}`);
        if (failResources) throw new Error("宿主假装：资源拿不到");
        return {
          resources: [{
            resource: { kind: "session-file", fileId: state.fileId, sessionId: state.sessionId }
          }]
        };
      }
    },
    resources: {
      async read({ kind, fileId, sessionId }) {
        check(kind === "session-file", `假 sdk：kind 应为 session-file，实为 ${kind}`);
        check(fileId === state.fileId, `假 sdk：fileId 不匹配`);
        check(sessionId === state.sessionId, `假 sdk：sessionId 不匹配`);
        return png;
      }
    },
    _state: state
  };
}

async function makeFixture() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tavern-scene-flow-"));
  const dataDir = path.join(tmp, "app-data");
  await fs.mkdir(dataDir, { recursive: true });

  const convRepo = new ConversationRepo(dataDir);
  await convRepo.init();
  const charRepo = new CharacterRepo(dataDir);
  await charRepo.init();

  // 默认场景：一张角色卡
  await charRepo.create({
    id: "char-1",
    name: "薇拉",
    description: "银灰长发，戴半圆眼镜",
    personality: "冷静，慢半拍"
  });

  return { tmp, dataDir, convRepo, charRepo };
}

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

// ① 手动补一张的完整链路：service + 台账 + 消息 + 双份文件
await ok("① 手动触发：落盘 + 台账 + 消息三处对得上", async () => {
  const { tmp, dataDir, convRepo, charRepo } = await makeFixture();
  try {
    const conv = await convRepo.create("char-1");
    await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: true, mode: "marker" });

    const sdk = fakeSdk();
    const r = await generateSceneIllustration(
      { sdk, dataDir, conversationRepo: convRepo, characterRepo: charRepo },
      { conversationId: conv.id, characterId: "char-1", scene: "她靠在窗边，慢慢抬眼" }
    );
    assert.equal(r.ok, true, `不该失败：${r.failReason}`);
    assert.ok(r.mediaId, "mediaId 有值");
    assert.ok(r.messageId, "messageId 有值");
    assert.ok(r.path && r.path.endsWith(".png"), "路径应指向 png");
    assert.ok(r.mirrorPath && r.mirrorPath.includes(path.join("generated", path.sep)) || r.mirrorPath.includes("/generated/"), "应镜像到 generated/");
    assert.ok(r.bytes > 0, "字节数 > 0");
    assert.equal(r.status, "ok");

    // 文件：两份都存在
    await stat(r.path);
    await stat(r.mirrorPath);

    // 台账：一条 kind=scene 记录
    const recs = await indexList(dataDir, { conversationId: conv.id });
    assert.equal(recs.length, 1, "台账里应有且仅有一条");
    assert.equal(recs[0].kind, "scene");
    assert.equal(recs[0].characterId, "char-1");
    assert.equal(recs[0].conversationId, conv.id);
    assert.equal(recs[0].messageId, r.messageId);
    assert.equal(recs[0].file, r.path, "file 应是绝对路径，指向主文件");
    assert.ok(recs[0].prompt.includes("她靠在窗边"), "prompt 里应含场景描述");

    // 消息：追加了一条 kind=illustration
    const fresh = await convRepo.get(conv.id);
    const illo = fresh.messages.find(m => m.kind === "illustration");
    assert.ok(illo, "应有一条 kind=illustration 的消息");
    assert.equal(illo.mediaId, r.mediaId, "消息的 mediaId 应等于台账的 id");
    assert.equal(illo.status, "ok");
    assert.equal(illo.prompt, "她靠在窗边，慢慢抬眼", "prompt 应保留场景描述原文");
    assert.equal(illo.failReason, undefined, "ok 状态不该有 failReason");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ② scene.enabled=false → 静默跳过
await ok("② scene.enabled=false：不出图、不加消息、返回 skipped", async () => {
  const { tmp, dataDir, convRepo, charRepo } = await makeFixture();
  try {
    const conv = await convRepo.create("char-1");
    await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: false });

    const sdk = fakeSdk();
    const r = await generateSceneIllustration(
      { sdk, dataDir, conversationRepo: convRepo, characterRepo: charRepo },
      { conversationId: conv.id, characterId: "char-1", scene: "任意描述" }
    );
    assert.equal(r.ok, false);
    assert.equal(r.skipped, true);
    assert.match(r.reason, /enabled|mode/);

    // 台账：空的
    const recs = await indexList(dataDir);
    assert.equal(recs.length, 0, "skipped 时不该写台账");

    // 消息：没有插图
    const fresh = await convRepo.get(conv.id);
    const illos = fresh.messages.filter(m => m.kind === "illustration");
    assert.equal(illos.length, 0, "skipped 时不该加插图消息");
    assert.equal(sdk._state.generatedPrompt, null, "skipped 时不该真调 sdk");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ③ scene.mode=off（但 enabled=true）→ 同样跳过
await ok("③ scene.mode=off：即使 enabled 也为 true，也不出图", async () => {
  const { tmp, dataDir, convRepo, charRepo } = await makeFixture();
  try {
    const conv = await convRepo.create("char-1");
    await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: true, mode: "off" });

    const sdk = fakeSdk();
    const r = await generateSceneIllustration(
      { sdk, dataDir, conversationRepo: convRepo, characterRepo: charRepo },
      { conversationId: conv.id, characterId: "char-1", scene: "任意描述" }
    );
    assert.equal(r.ok, false);
    assert.equal(r.skipped, true);
    assert.equal(sdk._state.generatedPrompt, null, "不该真调 sdk");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ④ 出图失败 → 消息 status=failed，failReason 带宿主原话（判据 4）
await ok("④ 出图失败：消息 status=failed 且带 failReason（宿主原话）", async () => {
  const { tmp, dataDir, convRepo, charRepo } = await makeFixture();
  try {
    const conv = await convRepo.create("char-1");
    await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: true, mode: "marker" });

    const sdk = fakeSdk({ failGenerate: true });
    const r = await generateSceneIllustration(
      { sdk, dataDir, conversationRepo: convRepo, characterRepo: charRepo },
      { conversationId: conv.id, characterId: "char-1", scene: "任意描述" }
    );
    assert.equal(r.ok, false);
    assert.equal(r.status, "failed");
    assert.ok(r.failReason, "failReason 应有值");
    assert.match(r.failReason, /宿主假装|出图引擎挂了/, `failReason 应含宿主原话，实际：${r.failReason}`);

    // 消息：有一条 kind=illustration，status=failed，含 failReason
    const fresh = await convRepo.get(conv.id);
    const illo = fresh.messages.find(m => m.kind === "illustration");
    assert.ok(illo, "失败也应有插图消息");
    assert.equal(illo.status, "failed");
    assert.ok(illo.failReason, "消息里应有 failReason");
    assert.match(illo.failReason, /宿主假装|出图引擎挂了/, "消息里的 failReason 也应是宿主原话");

    // 台账：仍然写（file 为 null）
    const recs = await indexList(dataDir);
    assert.equal(recs.length, 1, "失败也登记一条（file 为 null）");
    assert.equal(recs[0].file, null);
    assert.equal(recs[0].kind, "scene");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ⑤ characterRef=false：提示词里没有描述/性格
await ok("⑤ characterRef=false：提示词里不含卡的描述与性格", async () => {
  const { tmp, dataDir, convRepo, charRepo } = await makeFixture();
  try {
    const conv = await convRepo.create("char-1");
    await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: true, mode: "marker", characterRef: false });

    const sdk = fakeSdk();
    const r = await generateSceneIllustration(
      { sdk, dataDir, conversationRepo: convRepo, characterRepo: charRepo },
      { conversationId: conv.id, characterId: "char-1", scene: "黄昏的车站" }
    );
    assert.equal(r.ok, true);
    // 名字（"薇拉"）应还在
    assert.ok(r.prompt.includes("薇拉"), `prompt 应含角色名，实际：${r.prompt}`);
    // 描述与性格应被剔除
    assert.ok(!r.prompt.includes("银灰长发"), `characterRef=false 时 prompt 不应含描述，实际：${r.prompt}`);
    assert.ok(!r.prompt.includes("冷静，慢半拍"), `characterRef=false 时 prompt 不应含性格，实际：${r.prompt}`);
    // 场景描述仍在
    assert.ok(r.prompt.includes("黄昏的车站"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ⑥ characterRef=true（显式开）：提示词里含描述与性格
//    默认值是 false（2026-09-27 改：宿主现状不支持参考图），所以这里必须显式开。
await ok("⑥ characterRef=true 时：提示词含描述与性格", async () => {
  const { tmp, dataDir, convRepo, charRepo } = await makeFixture();
  try {
    const conv = await convRepo.create("char-1");
    await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: true, characterRef: true });

    const sdk = fakeSdk();
    const r = await generateSceneIllustration(
      { sdk, dataDir, conversationRepo: convRepo, characterRepo: charRepo },
      { conversationId: conv.id, characterId: "char-1", scene: "窗前" }
    );
    assert.equal(r.ok, true);
    assert.ok(r.prompt.includes("银灰长发"), `应含描述，实际：${r.prompt}`);
    assert.ok(r.prompt.includes("冷静"), `应含性格，实际：${r.prompt}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ⑦ 参数校验：缺参时报错
await ok("⑦ 缺必填参数：抛错，不静默写空消息", async () => {
  const { tmp, dataDir, convRepo, charRepo } = await makeFixture();
  try {
    const conv = await convRepo.create("char-1");
    await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: true });

    const sdk = fakeSdk();
    await assert.rejects(
      () => generateSceneIllustration(
        { sdk, dataDir, conversationRepo: convRepo, characterRepo: charRepo },
        { conversationId: conv.id, characterId: "char-1" }  // 缺 scene
      ),
      /scene/
    );
    const fresh = await convRepo.get(conv.id);
    assert.equal(fresh.messages.filter(m => m.kind === "illustration").length, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ⑧ 路由：POST /conversations/:id/illustrate 能打通
await ok("⑧ POST /conversations/:id/illustrate 能打通", async () => {
  const { tmp, dataDir, convRepo, charRepo } = await makeFixture();
  try {
    const conv = await convRepo.create("char-1");
    await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: true, mode: "marker" });

    const app = makeApp();
    registerIllustrationRoutes(app, { sdk: fakeSdk(), dataDir, conversationRepo: convRepo, characterRepo: charRepo });

    const r = await request(app, "POST", `/conversations/${conv.id}/illustrate`, {
      body: { scene: "黄昏的车站", characterId: "char-1" }
    });
    assert.ok(r, "路由没匹配上");
    assert.equal(r.status, 200, `应 200，实际 ${r.status}（${r.error}）`);
    assert.equal(r.ok, true);
    assert.ok(r.data.mediaId, "应返回 mediaId");
    assert.equal(r.data.ok, true, `data.ok 应为 true，实际 ${r.data.failReason || r.data.reason}`);

    const fresh = await convRepo.get(conv.id);
    assert.equal(fresh.messages.filter(m => m.kind === "illustration").length, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ⑨ 路由：POST 缺 scene → 400
await ok("⑨ POST /illustrate 缺 scene：400", async () => {
  const { tmp, dataDir, convRepo, charRepo } = await makeFixture();
  try {
    const conv = await convRepo.create("char-1");
    await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: true });

    const app = makeApp();
    registerIllustrationRoutes(app, { sdk: fakeSdk(), dataDir, conversationRepo: convRepo, characterRepo: charRepo });

    const r = await request(app, "POST", `/conversations/${conv.id}/illustrate`, {
      body: {}
    });
    assert.equal(r.status, 400, `缺 scene 应 400，实际 ${r.status}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ⑩ 路由：GET /illustration/config 与 PUT /illustration/config 能读回
await ok("⑩ /illustration/config：默认关，PUT 能改", async () => {
  const { tmp, dataDir, convRepo, charRepo } = await makeFixture();
  try {
    const app = makeApp();
    registerIllustrationRoutes(app, { sdk: fakeSdk(), dataDir, conversationRepo: convRepo, characterRepo: charRepo });

    const r1 = await request(app, "GET", "/illustration/config");
    assert.equal(r1.status, 200);
    assert.equal(r1.ok, true);
    const cfg1 = r1.data;
    assert.equal(cfg1.enabled, false, "默认 enabled=false");
    assert.equal(cfg1.mode, "marker");
    // 默认开：2026-09-27 真机复测确认宿主收参考图、且真的在用（见 config.js 文件头）。
    // 对照：关掉时提示词里只剩名字，画出来的人和卡毫无关系。
    assert.equal(cfg1.characterRef, true, "默认 characterRef=true");
    assert.equal(cfg1.autoTriggerActive, false, "默认 autoTriggerActive=false");

    const r2 = await request(app, "PUT", "/illustration/config", {
      body: { enabled: true, style: "赛博朋克霓虹" }
    });
    assert.equal(r2.status, 200);
    const cfg2 = r2.data;
    assert.equal(cfg2.enabled, true);
    assert.equal(cfg2.style, "赛博朋克霓虹");
    assert.equal(cfg2.autoTriggerActive, true, "开启后 autoTriggerActive=true");

    // 反读磁盘确认写入
    const fromDisk = await readSceneConfig(dataDir);
    assert.equal(fromDisk.enabled, true);
    assert.equal(fromDisk.style, "赛博朋克霓虹");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ⑪ 路由：GET /conversations/:id/illustration/latest
await ok("⑪ /illustration/latest：空对话返回 null", async () => {
  const { tmp, dataDir, convRepo, charRepo } = await makeFixture();
  try {
    const conv = await convRepo.create("char-1");

    const app = makeApp();
    registerIllustrationRoutes(app, { sdk: fakeSdk(), dataDir, conversationRepo: convRepo, characterRepo: charRepo });

    const r = await request(app, "GET", `/conversations/${conv.id}/illustration/latest`);
    assert.equal(r.status, 200);
    assert.equal(r.data.latest, null);
    assert.equal(r.data.total, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ⑫ 反证：镜像到 generated/ 是必需的一步（notes-gallery-intake 的约定）
await ok("⑫ 反证：镜像文件真的落在 <dataDir>/generated/", async () => {
  const { tmp, dataDir, convRepo, charRepo } = await makeFixture();
  try {
    const conv = await convRepo.create("char-1");
    await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: true });

    const sdk = fakeSdk();
    const r = await generateSceneIllustration(
      { sdk, dataDir, conversationRepo: convRepo, characterRepo: charRepo },
      { conversationId: conv.id, characterId: "char-1", scene: "测试" }
    );
    assert.equal(r.path, path.join(dataDir, "media", `${r.mediaId}.png`), "主文件路径应精确");
    assert.equal(r.mirrorPath, path.join(dataDir, "generated", `${r.mediaId}.png`), "镜像路径应精确");
    assert.ok(path.isAbsolute(r.path));
    assert.ok(path.isAbsolute(r.mirrorPath));
    await access(r.path);
    await access(r.mirrorPath);
    const [b1, b2] = await Promise.all([readFile(r.path), readFile(r.mirrorPath)]);
    assert.ok(Buffer.compare(b1, b2) === 0, "两份内容应一致");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ⑬ 反证：shouldAutoIllustrate 是纯函数
await ok("⑬ shouldAutoIllustrate：三态判据与 reason", async () => {
  assert.deepEqual(shouldAutoIllustrate({ enabled: false, mode: "marker" }), { active: false, reason: "scene.enabled=false" });
  assert.deepEqual(shouldAutoIllustrate({ enabled: true, mode: "off" }), { active: false, reason: "scene.mode=off" });
  assert.deepEqual(shouldAutoIllustrate({ enabled: true, mode: "marker" }), { active: true, reason: null });
});

// ⑭ 反证：scene-marker 的剥离 —— 用 fake sdk 触发自动路径
// 这里只验 handleSceneMarker 之外的东西：手动补一张路径下，标记解析不参与。
// 因此这条改用 service 直接验证：scene 描述里含 [场景] 头不会被二次解析。
await ok("⑭ 手动补一张路径不解析 [场景] 头（spec §5）", async () => {
  const { tmp, dataDir, convRepo, charRepo } = await makeFixture();
  try {
    const conv = await convRepo.create("char-1");
    await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: true, mode: "marker" });

    const sdk = fakeSdk();
    // 用户在手动入口里显式写了 [场景] 头
    const r = await generateSceneIllustration(
      { sdk, dataDir, conversationRepo: convRepo, characterRepo: charRepo },
      { conversationId: conv.id, characterId: "char-1", scene: "[场景] 一段描述" }
    );
    assert.equal(r.ok, true, "手动入口应把整段当描述用");
    // sdk 拿到的 prompt 里含"一段描述"
    assert.ok(sdk._state.generatedPrompt.includes("一段描述"), "prompt 里应有描述");
    // 台账里的 scene 字段是原样
    const recs = await indexList(dataDir);
    assert.equal(recs.length, 1);
    assert.ok(recs[0].scene.includes("一段描述"), "台账 scene 应保留原样");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ⑮ 手动补一张不受 mode=off 管（2026-09-27 修）
//
// config.js 写着「mode=off …… 保留 enabled=true 的语义用于手动补一张的入口」，
// 设置面板写着「保留手动补一张入口」。可旧版出图路径共用 sceneAutoTrigger 一道闸，
// mode=off 时手动也被挡死——三个地方的说法对不上，坏的是代码。
await ok("⑮ 手动补一张：mode=off 也照样出图（只受总闸管）", async () => {
  const { tmp, dataDir, convRepo, charRepo } = await makeFixture();
  try {
    const conv = await convRepo.create("char-1");
    await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: true, mode: "off" });

    const sdk = fakeSdk();
    const r = await generateSceneIllustration(
      { sdk, dataDir, conversationRepo: convRepo, characterRepo: charRepo },
      { conversationId: conv.id, characterId: "char-1", scene: "想画这一幕", source: "manual" }
    );
    assert.equal(r.skipped, undefined, "手动不该被 mode=off 拦下");
    assert.equal(r.ok, true, `手动应出图，实际 ${r.failReason || r.reason || ""}`);
    assert.ok(sdk._state.generatedPrompt, "应真调了 sdk");

    // 反面：同配置下的**自动**路径仍然不出。
    // 要的是「两条路分开」，不是「把闸整个拆了」。
    const auto = await generateSceneIllustration(
      { sdk: fakeSdk(), dataDir, conversationRepo: convRepo, characterRepo: charRepo },
      { conversationId: conv.id, characterId: "char-1", scene: "自动那一张" }
    );
    assert.equal(auto.skipped, true, "自动路径在 mode=off 下必须仍然跳过");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ⑯ 手动也逃不出总闸
await ok("⑯ 手动补一张：enabled=false 时照样拦下", async () => {
  const { tmp, dataDir, convRepo, charRepo } = await makeFixture();
  try {
    const conv = await convRepo.create("char-1");
    await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: false });

    const sdk = fakeSdk();
    const r = await generateSceneIllustration(
      { sdk, dataDir, conversationRepo: convRepo, characterRepo: charRepo },
      { conversationId: conv.id, characterId: "char-1", scene: "任意", source: "manual" }
    );
    assert.equal(r.ok, false);
    assert.equal(r.skipped, true);
    assert.equal(r.reason, "scene.enabled=false");
    assert.equal(sdk._state.generatedPrompt, null, "总闸关着时不该真调 sdk");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ⑰ characterRef 的默认值：缺字段 = 开；显式 false 才关
//
// 为什么单钉这一条：它刚从「默认关」翻回「默认开」，而这两种语义很容易写反。
// 写反了不会报错——只是画出来的人不像她，而且没人知道为什么。
await ok("⑰ characterRef 默认开；显式 false 才关", async () => {
  const { tmp, dataDir } = await makeFixture();
  try {
    const p = path.join(dataDir, "scene.json");

    // 缺字段（老配置 / 没表过态）→ 用默认（开）
    await fs.writeFile(p, JSON.stringify({ enabled: true, mode: "marker" }), "utf8");
    assert.equal((await readSceneConfig(dataDir)).characterRef, true, "缺字段应按默认（开）");

    // 显式 false → 必须尊重
    await fs.writeFile(p, JSON.stringify({ enabled: true, mode: "marker", characterRef: false }), "utf8");
    assert.equal((await readSceneConfig(dataDir)).characterRef, false, "显式 false 必须尊重");

    // 默认值本身
    assert.equal(emptySceneConfig().characterRef, true, "emptySceneConfig 默认开");
    assert.equal(emptySceneConfig().enabled, false, "总闸默认关（硬要求：不替用户决定花钱）");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

console.log("");
if (failed.length) {
  console.error(`❌ 场景插图端到端：${pass} 过 / ${failed.length} 败`);
  process.exit(1);
}
console.log(`✅ 场景插图端到端：${pass} 过 / 0 败`);
