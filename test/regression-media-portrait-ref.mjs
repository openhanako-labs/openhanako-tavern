// test/regression-media-portrait-ref.mjs — 出图 · portrait 参考图
//
// 判据：
//   · POST /media/portrait 收到 body.referenceImages → 顶层传给 sdk.media.generateImage
//   · body.image（单张）同理
//   · 后端带参考图失败 → 自动重试不带参考图（退化），response 里 degraded=true 与 refNote
//   · 后端不带参考图仍失败 → 直接把错误抛出来（不退化——退化只对参考图引起的失败有效）
//
// 反证：
//   · 把 referenceImages 塞进 options 而不是顶层 → ①② 立刻红
//   · 把失败时的重试逻辑去掉 → ③ 立刻红
//   · 把 degraded 标记去掉 → ③④ 立刻红
//   · 把退化路径的 refNote 去掉 → ③ 立刻红

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeApp, request } from "./lib/route-harness.mjs";

const { CharacterRepo } = await import("../lib/characters/repo.js");
const { CharacterTransfer } = await import("../lib/characters/transfer.js");
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

console.log("\n=== 出图 · portrait 参考图 ===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-portrait-ref-"));
const charRepo = new CharacterRepo(tmp);
await charRepo.init();
const transfer = new CharacterTransfer(charRepo);

const card = await charRepo.create({
  name: "薇拉·霜语",
  description: "守夜法师，银灰长发",
  personality: "话少",
  first_mes: "「又是你。」",
  tags: ["守夜", "法师"]
});

const fakeImg = path.join(tmp, "portrait.png");
fs.writeFileSync(fakeImg, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));

/**
 * 假 sdk：记录每一次收到的 request。
 *
 * failWithRef 控制：当 input.referenceImages / input.image 存在时抛错。
 * 用来验证"带参考图失败 → 重试不带参考图"这条退化路径。
 *
 * failAll 控制：无论什么参数都抛错。用来验证"纯文生图失败 → 不重试"。
 */
function makeSdk({ failWithRef = false, failAll = false, ok = true } = {}) {
  const calls = [];
  return {
    calls,
    media: {
      async generateImage(req) {
        calls.push(req);
        if (failAll) throw new Error("上游 429");
        if (failWithRef && (req.input?.referenceImages || req.input?.image)) {
          throw new Error("provider does not support reference image");
        }
        if (!ok) return { ok: false, error: "上游 500" };
        return {
          ok: true,
          files: [path.basename(fakeImg)],
          sessionFiles: [{ filePath: fakeImg, realPath: fakeImg }]
        };
      }
    }
  };
}

// ① body.referenceImages 透传给 sdk，且在顶层字段
await ok("① body.referenceImages → 顶层 input.referenceImages 字段", async () => {
  const sdk = makeSdk();
  const app = makeApp();
  registerMediaRoutes(app, { sdk, characterRepo: charRepo, transfer, dataDir: tmp });

  const r = await request(app, "POST", "/media/portrait", {
    body: {
      characterId: card.id,
      referenceImages: [{ kind: "local-file", path: "W:\\refs\\vera.png" }]
    }
  });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.ok, true);
  assert.strictEqual(sdk.calls.length, 1);
  const call = sdk.calls[0];
  assert.strictEqual(call.scope, "app");
  assert.deepStrictEqual(call.input.referenceImages, [{ kind: "local-file", path: "W:\\refs\\vera.png" }],
    "referenceImages 必须以顶层字段传给宿主");
  assert.ok(!("referenceImages" in (call.input.options || {})), "options 里不该有 referenceImages");
});

// ② body.image（单张）同样透传到顶层
await ok("② body.image → 顶层 input.image 字段", async () => {
  const sdk = makeSdk();
  const app = makeApp();
  registerMediaRoutes(app, { sdk, characterRepo: charRepo, transfer, dataDir: tmp });

  await request(app, "POST", "/media/portrait", {
    body: {
      characterId: card.id,
      image: { kind: "session-file", fileId: "f-42" }
    }
  });
  assert.strictEqual(sdk.calls.length, 1);
  const call = sdk.calls[0];
  assert.deepStrictEqual(call.input.image, { kind: "session-file", fileId: "f-42" });
  assert.ok(!("image" in (call.input.options || {})), "options 里不该有 image");
});

// ③ 带参考图失败 → 自动重试不带参考图 → response.degraded=true + refNote
await ok("③ 带参考图失败 → 重试一次纯文生图 → degraded=true 与 refNote", async () => {
  const sdk = makeSdk({ failWithRef: true });
  const app = makeApp();
  registerMediaRoutes(app, { sdk, characterRepo: charRepo, transfer, dataDir: tmp });

  const r = await request(app, "POST", "/media/portrait", {
    body: {
      characterId: card.id,
      referenceImages: [{ kind: "local-file", path: "W:\\refs\\vera.png" }]
    }
  });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.ok, true, "退化不能把这张图判死");
  assert.strictEqual(r.data.degraded, true, "response 里必须显式标记 degraded");
  assert.ok(/参考图未生效|reference image|provider/.test(r.data.refNote || ""),
    `refNote 该说明白为什么退化，实为：${r.data.refNote || ""}`);
  assert.strictEqual(sdk.calls.length, 2, "重试一次：第一次带参考图，第二次不带");
  assert.ok(sdk.calls[0].input.referenceImages, "第一次该带参考图");
  assert.ok(!sdk.calls[1].input.referenceImages && !sdk.calls[1].input.image,
    "重试那次不该再带参考图");
});

// ④ 不带参考图的失败：不重试，直接把错误抛出来
await ok("④ 纯文生图失败 → 不重试（那不是参考图引起的）", async () => {
  const sdk = makeSdk({ failAll: true });
  const app = makeApp();
  registerMediaRoutes(app, { sdk, characterRepo: charRepo, transfer, dataDir: tmp });

  const r = await request(app, "POST", "/media/portrait", {
    body: { characterId: card.id }
  });
  assert.strictEqual(r.status, 400, `状态 ${r.status}`);
  assert.ok(/上游 429/.test(r.error || ""), "错误原文该留下来");
  assert.strictEqual(sdk.calls.length, 1, "不该因为不是参考图引起的失败而重试");
});

// ⑤ 归一化：body 里塞了非法参考图 → 丢掉，不当参数送出去
await ok("⑤ body.referenceImages 非法项丢掉（不硬凑给宿主）", async () => {
  const sdk = makeSdk();
  const app = makeApp();
  registerMediaRoutes(app, { sdk, characterRepo: charRepo, transfer, dataDir: tmp });

  await request(app, "POST", "/media/portrait", {
    body: {
      characterId: card.id,
      referenceImages: [
        { kind: "local-file", path: "W:\\a\\b.png" },
        { kind: "nope" },
        null
      ]
    }
  });
  assert.strictEqual(sdk.calls.length, 1);
  assert.deepStrictEqual(sdk.calls[0].input.referenceImages, [{ kind: "local-file", path: "W:\\a\\b.png" }]);
});

// ⑥ 不传 referenceImages → sdk 收到的 input 里没有这个字段（不是空数组）
await ok("⑥ 没传参考图 → input 里干脆没有这个字段（不是空数组）", async () => {
  const sdk = makeSdk();
  const app = makeApp();
  registerMediaRoutes(app, { sdk, characterRepo: charRepo, transfer, dataDir: tmp });

  await request(app, "POST", "/media/portrait", { body: { characterId: card.id } });
  assert.strictEqual(sdk.calls.length, 1);
  const input = sdk.calls[0].input;
  assert.ok(!("referenceImages" in input), "没传就不该传空字段");
  assert.ok(!("image" in input));
});

if (failed.length) {
  console.log(`\n❌ portrait 参考图：${pass} 过 / ${failed.length} 败\n`);
  process.exit(1);
}
console.log(`\n✅ portrait 参考图：${pass} 过 / 0 败\n`);
