// test/regression-media-comfy-ref.mjs — 换引擎 · ComfyUI 参考图
//
// 判据：
//   · renderViaComfy 收到 refImageTarget + referenceImagePath → inputs 里多写一个键
//   · 只给一半（有 target 无 path / 有 path 无 target）→ 只写 prompt，不写参考图
//   · 参考图节点键格式校验（跟 promptTarget 同一套：<节点号>.<输入名>）
//   · 路由：cfg.refImageTarget 配上、卡上有头像 → 自动拿头像当参考图
//   · 卡上没头像 → refNote 提示退化，不阻断
//
// 反证：
//   · 把参考图节点键写进 inputs 时丢掉 → ①② 立刻红
//   · 让参考图节点键缺失也硬写 → ② 立刻红
//   · 把格式校验改成不区分参考图节点 → ③ 立刻红
//   · 卡上没头像时抛错而不是退化 → ⑤ 立刻红
//
// 用假 sdk（同 regression-media-comfy.mjs 的模式），不真调 ComfyUI。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeApp, request } from "./lib/route-harness.mjs";

const { CharacterRepo } = await import("../lib/characters/repo.js");
const { CharacterTransfer } = await import("../lib/characters/transfer.js");
const { renderViaComfy, pickComfyTool, ensureEnvironment } = await import("../lib/media/comfy.js");
const { mergeImageConfig, imageReadiness } = await import("../lib/media/config.js");
const { registerMediaRoutes } = await import("../lib/media/routes.js");

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

console.log("\n=== 换引擎 · ComfyUI 参考图 ===\n");

const OUT = "W:\\Games\\Comfyui\\output\\portrait_00001.png";

/** 假宿主：runTool 记录参数、按脚本回话。 */
function fakeSdk(script) {
  const calls = [];
  let i = 0;
  return {
    calls,
    environments: {
      async list() { return [{ environmentId: "env-1", revision: 3, state: "running" }]; },
      async create() { return { environmentId: "env-new", revision: 1, state: "running" }; },
      async catalog() { return { tools: [{ ref: "app:comfyui-hana", name: "comfyui" }] }; },
      async runTool(input) {
        calls.push(input);
        return { result: script[Math.min(i++, script.length - 1)] };
      }
    }
  };
}

// ① 有 refImageTarget + referenceImagePath → inputs 里两个键都在
await ok("① refImageTarget + referenceImagePath → inputs 两个键都在", async () => {
  const sdk = fakeSdk([
    { details: { comfyui: { promptId: "p-1" } } },
    { status: "success" },
    { files: [{ path: OUT }] }
  ]);
  const out = await renderViaComfy({
    sdk,
    env: { environmentId: "env-1", revision: 3 },
    tool: { ref: "app:comfyui-hana", name: "comfyui" },
    template: "w.json",
    promptTarget: "6.text",
    prompt: "守夜法师",
    refImageTarget: "8.image",
    referenceImagePath: "W:\\chars\\char-1\\avatar.png",
    sleep: async () => {}
  });
  assert.strictEqual(out.usedReferenceImage, true, "该报告确实写进了参考图键");
  const submit = sdk.calls[0];
  assert.strictEqual(submit.args.action, "submit");
  assert.deepStrictEqual(submit.args.inputs, {
    "6.text": "守夜法师",
    "8.image": "W:\\chars\\char-1\\avatar.png"
  }, "inputs 里必须同时有 prompt 键和参考图键");
});

// ② 只给 refImageTarget、不给 referenceImagePath → 只写 prompt，不写参考图
await ok("② 只给 target 无 path → inputs 里只有 prompt 键", async () => {
  const sdk = fakeSdk([
    { details: { comfyui: { promptId: "p-2" } } },
    { status: "success" },
    { files: [{ path: OUT }] }
  ]);
  await renderViaComfy({
    sdk,
    env: { environmentId: "env-1", revision: 3 },
    tool: { ref: "app:comfyui-hana", name: "comfyui" },
    template: "w.json",
    promptTarget: "6.text",
    prompt: "x",
    refImageTarget: "8.image",
    referenceImagePath: null,
    sleep: async () => {}
  });
  const submit = sdk.calls[0];
  assert.deepStrictEqual(submit.args.inputs, { "6.text": "x" },
    "没参考图路径时不该硬塞空键");
});

// ②b 反向：给了路径但没节点键 → 同样只写 prompt
await ok("②b 有 path 无 target → inputs 里只有 prompt 键（不猜节点名）", async () => {
  const sdk = fakeSdk([
    { details: { comfyui: { promptId: "p-3" } } },
    { status: "success" },
    { files: [{ path: OUT }] }
  ]);
  await renderViaComfy({
    sdk,
    env: { environmentId: "env-1", revision: 3 },
    tool: { ref: "app:comfyui-hana", name: "comfyui" },
    template: "w.json",
    promptTarget: "6.text",
    prompt: "x",
    referenceImagePath: "W:\\refs\\a.png",
    sleep: async () => {}
  });
  assert.deepStrictEqual(sdk.calls[0].args.inputs, { "6.text": "x" });
});

// ③ 配置层：refImageTarget 走同一套格式校验
await ok("③ refImageTarget 格式校验：非 <节点号>.<输入名> 直接拒", () => {
  const good = mergeImageConfig({}, {
    backend: "comfyui", workflow: "w.json", promptTarget: "6.text", refImageTarget: "8.image"
  });
  assert.strictEqual(imageReadiness(good).ready, true);

  const bad = mergeImageConfig(good, { refImageTarget: "乱填的" });
  assert.strictEqual(imageReadiness(bad).ready, false);
  assert.match(imageReadiness(bad).reason, /参考图节点.*节点号/, imageReadiness(bad).reason);

  // 不填参考图节点：仍然 ready（参考图节点是可选的，不配就退化纯文生图）
  const noRef = mergeImageConfig(good, { refImageTarget: "" });
  assert.strictEqual(imageReadiness(noRef).ready, true, "参考图节点没配不该判 not ready");
  assert.strictEqual(noRef.refImageTarget, "");
});

// ── 路由层 ─────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-comfy-ref-"));
const charRepo = new CharacterRepo(tmp);
await charRepo.init();
const transfer = new CharacterTransfer(charRepo);

const card = await charRepo.create({
  name: "薇拉", description: "守夜法师", personality: "话少",
  first_mes: "「又是你。」", tags: []
});

// 假产出：ComfyUI 落盘的一张图
const outDir = path.join(tmp, "comfy-out");
const outFile = path.join(outDir, "portrait_00001.png");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, Buffer.alloc(32, 9));

// ④ 路由：cfg.refImageTarget 配上 + 卡有头像 → 自动拿头像当参考图 → inputs 里含参考图键
await ok("④ 路由：cfg.refImageTarget 配上 + 卡有头像 → inputs 含参考图键", async () => {
  // 先给这张卡造一个已有头像
  const existingAvatar = path.join(tmp, "existing.png");
  fs.writeFileSync(existingAvatar, Buffer.alloc(48, 1));
  await transfer.saveAvatar(card.id, fs.readFileSync(existingAvatar), "png");

  const sdk = fakeSdk([
    { details: { comfyui: { promptId: "p-10" } } },
    { status: "success" },
    { files: [{ path: outFile }] }
  ]);
  const app = makeApp();
  registerMediaRoutes(app, { sdk, characterRepo: charRepo, transfer, dataDir: outDir });

  await request(app, "PUT", "/media/config", {
    body: {
      backend: "comfyui",
      workflow: "w.json",
      promptTarget: "6.text",
      refImageTarget: "8.image"
    }
  });
  const r = await request(app, "POST", "/media/portrait", { body: { characterId: card.id } });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.via, "comfyui");
  assert.ok(!r.data.degraded, "参考图真的走通了，不该标 degraded");

  const submit = sdk.calls.find((c) => c.args.action === "submit");
  assert.ok(submit, "没提交任务");
  assert.deepStrictEqual(Object.keys(submit.args.inputs), ["6.text", "8.image"],
    `inputs 应含 prompt 与参考图两键，实为 ${Object.keys(submit.args.inputs)}`);
  assert.match(submit.args.inputs["8.image"], /avatar\.png$/,
    `参考图路径该指向卡上的头像，实为 ${submit.args.inputs["8.image"]}`);
});

// ⑤ 卡上没头像 → refNote 提示，不阻断（退化纯文生图）
await ok("⑤ 卡上没头像 → refNote 提示，不阻断（退化）", async () => {
  // 用一张没头像的新卡
  const card2 = await charRepo.create({
    name: "新人", description: "新来的", personality: "话少",
    first_mes: "「你好。」", tags: []
  });

  const sdk = fakeSdk([
    { details: { comfyui: { promptId: "p-11" } } },
    { status: "success" },
    { files: [{ path: outFile }] }
  ]);
  const app = makeApp();
  registerMediaRoutes(app, { sdk, characterRepo: charRepo, transfer, dataDir: outDir });

  await request(app, "PUT", "/media/config", {
    body: { backend: "comfyui", workflow: "w.json", promptTarget: "6.text", refImageTarget: "8.image" }
  });
  const r = await request(app, "POST", "/media/portrait", { body: { characterId: card2.id } });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.via, "comfyui");
  assert.ok(r.data.refNote, "没头像时该在 response 里明说参考图退化了");
  assert.ok(/没有头像|参考图退化/.test(r.data.refNote), `refNote 该说明白为什么，实为 ${r.data.refNote}`);
  assert.ok(!r.data.degraded, "这是主动退化，不是失败——不该标 degraded");

  const submit = sdk.calls.find((c) => c.args.action === "submit");
  assert.ok(submit);
  assert.deepStrictEqual(Object.keys(submit.args.inputs), ["6.text"],
    "没头像时不该硬塞一个空参考图键");
});

// ⑥ 卡上有头像但 cfg.refImageTarget 没配 → 不主动退化，也不硬塞
await ok("⑥ cfg.refImageTarget 空 + 卡有头像 → 纯文生图（不塞参考图，也不报退化）", async () => {
  // ④ 已经给 card 落了头像，这里直接用
  const sdk = fakeSdk([
    { details: { comfyui: { promptId: "p-12" } } },
    { status: "success" },
    { files: [{ path: outFile }] }
  ]);
  const app = makeApp();
  registerMediaRoutes(app, { sdk, characterRepo: charRepo, transfer, dataDir: outDir });

  await request(app, "PUT", "/media/config", {
    body: { backend: "comfyui", workflow: "w.json", promptTarget: "6.text", refImageTarget: "" }
  });
  const r = await request(app, "POST", "/media/portrait", { body: { characterId: card.id } });
  assert.strictEqual(r.status, 200);
  assert.ok(!r.data.refNote, "用户没配参考图节点，不该反过来告一句参考图退化");
  const submit = sdk.calls.find((c) => c.args.action === "submit");
  assert.deepStrictEqual(Object.keys(submit.args.inputs), ["6.text"]);
});

if (failed.length) {
  console.log(`\n❌ ComfyUI 参考图：${pass} 过 / ${failed.length} 败\n`);
  process.exit(1);
}
console.log(`\n✅ ComfyUI 参考图：${pass} 过 / 0 败\n`);
