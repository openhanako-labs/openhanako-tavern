// test/regression-media-reference.mjs — 出图 · 参考图顶层字段
//
// 这一份锁一件事：`generateImageRaw` 的 image / referenceImages 是**顶层字段**，
// 不是 options 里的键。
//
// 契约来源：sdk/app-contract/bus-requests.d.ts:246-247 的 AppMediaGenerationInputV2
// 定义了 `image?: AppMediaReferenceV2 | AppMediaReferenceV2[]` 与
// `referenceImages?: readonly AppMediaReferenceV2[]`——**和 prompt / delivery /
// options 同级**。
//
// 之所以单独锁这份：
//   · 契约支持 ≠ 后端行为。providers.d.ts 那层只有 `input: ("text"|"image")[]`
//     （模型能不能吃图的标记），没有「能不能吃参考图做 i2i」的语义说明。
//   · 后端 provider 会不会读这个字段——**目前未验证**。因此失败路径必须
//     打一个可识别的码，让上层（illustration / portrait 路由）能据此重试，
//     而不是把这张图直接判死。
//
// 反证：
//   · 把 referenceImages 塞进 options 而不是顶层 → ①②③ 立刻红
//   · 把归一化的非法项留下 → ③ 立刻红
//   · 把错误码 ERR_REF_IMAGE_FAILED 去掉 → ④ 立刻红
//   · 忘记给 usedImage=false 的场景清掉 code → ⑤ 立刻红

import assert from "node:assert";

const { generateImageRaw } = await import("../lib/media/service.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 出图 · 参考图（顶层字段） ===\n");

/** 记录收到什么的假 sdk。 */
function captureSdk({ ok = true, throwErr = null } = {}) {
  const calls = [];
  return {
    calls,
    media: {
      async generateImage(req) {
        calls.push(req);
        if (throwErr) throw new Error(throwErr);
        if (ok === false) return { ok: false, error: "provider rejected" };
        return { ok: true };
      }
    }
  };
}

// ① 合法参考图 → 顶层 image / referenceImages 字段
await okAsync("① 合法 image（单张）→ 顶层 image 字段", async () => {
  const sdk = captureSdk();
  await generateImageRaw(sdk, {
    prompt: "x",
    image: { kind: "local-file", path: "W:\\a\\b.png" }
  });
  assert.strictEqual(sdk.calls.length, 1);
  const input = sdk.calls[0].input;
  assert.deepStrictEqual(input.image, { kind: "local-file", path: "W:\\a\\b.png" });
  assert.ok(!("referenceImages" in input), "只传了 image，不该同时冒 referenceImages");
});

await okAsync("①b 合法 referenceImages（多张）→ 顶层 referenceImages 字段，是数组", async () => {
  const sdk = captureSdk();
  await generateImageRaw(sdk, {
    prompt: "x",
    referenceImages: [
      { kind: "local-file", path: "W:\\a\\b.png" },
      { kind: "session-file", fileId: "f-1" }
    ]
  });
  const input = sdk.calls[0].input;
  assert.deepStrictEqual(input.referenceImages, [
    { kind: "local-file", path: "W:\\a\\b.png" },
    { kind: "session-file", fileId: "f-1" }
  ]);
  assert.ok(!("image" in input), "只传了 referenceImages，不该同时冒 image");
});

await okAsync("② 参考图**不是** options 里的键——契约顶层字段", async () => {
  const sdk = captureSdk();
  await generateImageRaw(sdk, {
    prompt: "x",
    referenceImages: [{ kind: "local-file", path: "W:\\a\\b.png" }],
    options: { seed: 1234 }
  });
  const input = sdk.calls[0].input;
  assert.ok(Array.isArray(input.referenceImages), "referenceImages 必须在顶层");
  assert.deepStrictEqual(input.options, { seed: 1234 }, "options 里不该混入参考图");
  assert.ok(!("referenceImages" in (input.options || {})), "options 里不该有 referenceImages");
});

await okAsync("③ 归一化：非法参考图丢掉，全丢完就等于没给", async () => {
  // 单张 image 但 kind 不认
  let sdk = captureSdk();
  await generateImageRaw(sdk, {
    prompt: "x",
    image: { kind: "nonsense", path: "abc" }
  });
  assert.ok(!("image" in sdk.calls[0].input), "非法 image 应被丢掉");

  // 数组里混合法非法
  sdk = captureSdk();
  await generateImageRaw(sdk, {
    prompt: "x",
    referenceImages: [
      { kind: "local-file", path: "W:\\a\\b.png" },
      { kind: "local-file", path: "" },          // 空 path
      { kind: "session-file", fileId: "  " },     // 空格
      null,                                        // null
      { kind: "unknown-kind" }
    ]
  });
  const input = sdk.calls[0].input;
  assert.strictEqual(input.referenceImages.length, 1, "只留一张合法的");
  assert.deepStrictEqual(input.referenceImages[0], { kind: "local-file", path: "W:\\a\\b.png" });

  // 全非法 → 干脆不传这个字段（避免后端见到空数组判错）
  sdk = captureSdk();
  await generateImageRaw(sdk, {
    prompt: "x",
    referenceImages: [{ kind: "bad" }, null]
  });
  assert.ok(!("referenceImages" in sdk.calls[0].input), "全非法时不该传空数组");
});

await okAsync("④ 后端拒绝带参考图的请求 → 抛错时打 ERR_REF_IMAGE_FAILED 码", async () => {
  const sdk = captureSdk({ throwErr: "provider does not support reference image" });
  try {
    await generateImageRaw(sdk, {
      prompt: "x",
      referenceImages: [{ kind: "local-file", path: "W:\\a\\b.png" }]
    });
    assert.fail("该抛错");
  } catch (e) {
    assert.strictEqual(e.code, "ERR_REF_IMAGE_FAILED",
      `带参考图失败必须打识别码，实际 code=${e.code}`);
    assert.strictEqual(e.referenceImages, true, "该标记本次带了参考图");
    assert.ok(/provider does not support/.test(e.message), "原话该留下来");
  }
});

await okAsync("④b 返回 ok:false 也走同一条纪律", async () => {
  const sdk = captureSdk({ ok: false });
  try {
    await generateImageRaw(sdk, {
      prompt: "x",
      referenceImages: [{ kind: "local-file", path: "W:\\a\\b.png" }]
    });
    assert.fail("该抛错");
  } catch (e) {
    assert.strictEqual(e.code, "ERR_REF_IMAGE_FAILED",
      "ok:false 分支也必须打识别码，路由才知道该不该重试");
    assert.ok(/provider rejected/.test(e.message), "错误原文该在 message 里");
  }
});

await okAsync("⑤ 不带参考图的失败**不该**打 ERR_REF_IMAGE_FAILED——那不是参考图引起的", async () => {
  const sdk = captureSdk({ throwErr: "上游 429" });
  try {
    await generateImageRaw(sdk, { prompt: "x" });
    assert.fail("该抛错");
  } catch (e) {
    assert.notStrictEqual(e.code, "ERR_REF_IMAGE_FAILED",
      "纯文生图失败不该打参考图识别码（否则上层会做无谓的重试）");
    assert.strictEqual(e.referenceImages, false);
  }
});

await okAsync("⑤b 传了归一化后空的参考图（全非法被丢光）→ 也不算带参考图", async () => {
  const sdk = captureSdk({ throwErr: "上游 429" });
  try {
    await generateImageRaw(sdk, {
      prompt: "x",
      referenceImages: [{ kind: "bad" }]
    });
    assert.fail("该抛错");
  } catch (e) {
    // 归一化后没有一张合法参考图，等于没带——不该打参考图识别码
    assert.notStrictEqual(e.code, "ERR_REF_IMAGE_FAILED");
    assert.strictEqual(e.referenceImages, false);
  }
});

await okAsync("⑥ 契约形状钉住：scope=app + delivery.mode=response 依然成立", async () => {
  const sdk = captureSdk();
  await generateImageRaw(sdk, {
    prompt: "x",
    suggestedFilename: "s.png",
    options: { ttlMs: 30000 },
    image: { kind: "session-file", fileId: "f-1" }
  });
  const call = sdk.calls[0];
  assert.strictEqual(call.scope, "app");
  assert.strictEqual(call.input.delivery.mode, "response");
  assert.strictEqual(call.input.delivery.ttlMs, 30000);
  assert.strictEqual(call.input.suggestedFilename, "s.png");
  assert.deepStrictEqual(call.input.image, { kind: "session-file", fileId: "f-1" });
});

console.log(`\n${fail === 0 ? "✅" : "❌"} 出图参考图（顶层字段）：${pass} 过 / ${fail} 败\n`);
process.exit(fail === 0 ? 0 : 1);
