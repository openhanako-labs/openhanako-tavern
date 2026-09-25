// test/regression-media-bytes.mjs — 从出图产物拿字节的顺序与理由
//
// 为什么这是重点：在真宿主上撞见的是“图出来了，但读不到”。
// 而“读不到”有三种完全不同的原因（范围之外 / 契约形状变了 / 真没这个文件），
// 上一轮就是被一句含糊的报错耽误的。所以这里钉两件事：
//   ① 顺序：越正路越优先（task 资源引用 → 裸路径兜底）
//   ② 失败时把每一条的原因都带回去，而不是一句“读不到”

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { asBuffer, readProductBytes, explainAttempts } = await import("../lib/media/bytes.js");

let pass = 0;
const failed = [];
async function okAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed.push(name);
    console.error(`  ❌ ${name}\n     ${e?.message || e}`);
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tavern-bytes-"));
const realPng = path.join(tmp, "real.png");
await fs.writeFile(realPng, Buffer.from("89504e470d0a1a0a", "hex"));

// ── asBuffer：宿主不同版本给的形状不一样，都要认得 ──
await okAsync("① 字节形态：Buffer / Uint8Array / ArrayBuffer / data URL / 嵌套对象", () => {
  const b = Buffer.from([1, 2, 3, 4]);
  assert.deepEqual(asBuffer(b), b, "Buffer 原样");
  assert.deepEqual(asBuffer(new Uint8Array([1, 2, 3, 4])), b, "Uint8Array");
  assert.deepEqual(asBuffer(new Uint8Array([1, 2, 3, 4]).buffer), b, "ArrayBuffer");
  assert.deepEqual(asBuffer(`data:image/png;base64,${b.toString("base64")}`), b, "data URL");
  assert.deepEqual(asBuffer({ data: { buffer: b } }), b, "套两层也能挖出来");
});

await okAsync("①b 认不出来就老实说认不出来（不把乱码当真图）", () => {
  assert.equal(asBuffer("这是一段普通中文，不是图片"), null);
  assert.equal(asBuffer("short"), null);
  assert.equal(asBuffer(null), null);
  assert.equal(asBuffer({}), null);
});

// ── 正路：task 资源引用 → resources.read ──
await okAsync("② 正路优先：session-file 引用能读通，就走它（不碰裸路径）", async () => {
  const want = Buffer.from("session-bytes");
  const sdk = {
    media: {
      getTaskResources: async (taskId) => {
        assert.equal(taskId, "task-1", "该问宿主这个 task");
        return { resources: [{ name: "a.png", resource: { kind: "session-file", fileId: "f1", sessionId: "s1" } }] };
      }
    },
    resources: {
      read: async (ref) => {
        assert.deepEqual(ref, { kind: "session-file", fileId: "f1", sessionId: "s1" }, "该按引用读，而不是拿路径");
        return want;
      }
    }
  };
  const r = await readProductBytes(sdk, { taskId: "task-1", sessionFiles: [{ filePath: realPng }] });
  assert.equal(r.ok, true);
  assert.equal(r.via, "session-file");
  assert.deepEqual(r.buf, want);
});

// ── 正路不通：要留下原因，然后兜底 ──
await okAsync("③ 正路没通（宿主没给 resources.read）→ 记下原因，兜底裸路径仍成功", async () => {
  const sdk = {
    media: { getTaskResources: async () => ({ resources: [{ name: "a.png", resource: { kind: "session-file", fileId: "f1", sessionId: "s1" } }] }) }
    // 故意不给 resources
  };
  const r = await readProductBytes(sdk, { taskId: "task-1", sessionFiles: [{ filePath: realPng }] });
  assert.equal(r.ok, true, "兜底该成功");
  assert.equal(r.via, "裸路径");
  assert.ok(
    r.attempts.some((a) => /resources\.read/.test(a.error)),
    "该留下“宿主没给 resources.read”这条原因：" + JSON.stringify(r.attempts)
  );
});

await okAsync("④ 全试过还是不成 → 每条原因都在，且是真 errno（不是含糊的“读不到”）", async () => {
  const sdk = { media: { getTaskResources: async () => ({ resources: [] }) } };
  const r = await readProductBytes(sdk, { taskId: "task-1", files: [path.join(tmp, "没有这个文件.png")] });
  assert.equal(r.ok, false);
  assert.equal(r.buf, null);
  assert.ok(r.attempts.length >= 2, "至少该有 getTaskResources 与裸路径两条：" + JSON.stringify(r.attempts));
  assert.ok(
    r.attempts.some((a) => /ENOENT/.test(a.error)),
    "裸路径那条该带 ENOENT：" + JSON.stringify(r.attempts)
  );
  assert.ok(explainAttempts(r.attempts).length > 10, "说人话的那句不能是空的");
});

await okAsync("⑤ 没有 taskId 也不装死：说清是“产物里没有 taskId”，并继续兜底", async () => {
  const r = await readProductBytes({ media: {} }, { files: [path.basename(realPng)] }, { path: realPng });
  assert.equal(r.ok, true, "给了兜底路径就该成功");
  assert.equal(r.via, "裸路径");
  assert.ok(
    r.attempts.some((a) => /没有 taskId/.test(a.error)),
    "该说明为什么没走正路：" + JSON.stringify(r.attempts)
  );
});

await fs.rm(tmp, { recursive: true, force: true });

console.log("");
if (failed.length) {
  console.error(`❌ 出图字节读取：${pass} 过 / ${failed.length} 败`);
  process.exit(1);
}
console.log(`✅ 出图字节读取：${pass} 过 / 0 败`);
