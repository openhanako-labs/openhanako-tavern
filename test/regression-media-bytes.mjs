// test/regression-media-bytes.mjs — 从出图产物拿字节：顺序、等待、理由
//
// 为什么这是重点：在真宿主上撞见的是“图出来了，但读不到”。
// “读不到”有好几种完全不同的原因（范围之外 / 形状不同 / **还没写完** / 真没这文件），
// 而每一轮真机调试只能推进一小步。所以这里把已经踩实的形状与顺序全钉住。

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

// 轮询用的小参数：测试里不等真时间
const FAST = { timeoutMs: 2000, intervalMs: 5 };

// ── asBuffer ──
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

// ── 正路 ──
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
  const r = await readProductBytes(sdk, { taskId: "task-1", sessionFiles: [{ filePath: realPng }] }, FAST);
  assert.equal(r.ok, true);
  assert.equal(r.via, "session-file");
  assert.deepEqual(r.buf, want);
});

await okAsync("③ 正路没通（宿主没给 resources.read）→ 记下原因，兜底裸路径仍成功", async () => {
  const sdk = {
    media: { getTaskResources: async () => ({ resources: [{ name: "a.png", resource: { kind: "session-file", fileId: "f1", sessionId: "s1" } }] }) }
  };
  const r = await readProductBytes(sdk, { taskId: "task-1", sessionFiles: [{ filePath: realPng }] }, FAST);
  assert.equal(r.ok, true, "兜底该成功");
  assert.equal(r.via, "裸路径");
  assert.ok(r.attempts.some((a) => /resources\.read/.test(a.error)), "该留下原因：" + JSON.stringify(r.attempts));
});

await okAsync("④ 全试过还是不成 → 每条原因都在，且是真 errno（不是含糊的“读不到”）", async () => {
  const sdk = { media: { getTaskResources: async () => ({ resources: [] }) } };
  const r = await readProductBytes(sdk, { taskId: "task-1", files: [path.join(tmp, "没有这个文件.png")] }, FAST);
  assert.equal(r.ok, false);
  assert.equal(r.buf, null);
  assert.ok(r.attempts.length >= 2, "至少该有两条：" + JSON.stringify(r.attempts));
  assert.ok(r.attempts.some((a) => /ENOENT/.test(a.error)), "该带 ENOENT：" + JSON.stringify(r.attempts));
  assert.ok(explainAttempts(r.attempts).length > 10, "说人话那句不能空");
});

await okAsync("⑤ 没有 taskId 也不装死：说清原因，并继续兜底", async () => {
  const r = await readProductBytes({ media: {} }, { files: [path.basename(realPng)] }, { ...FAST, path: realPng });
  assert.equal(r.ok, true, "给了兜底路径就该成功");
  assert.equal(r.via, "裸路径");
  assert.ok(r.attempts.some((a) => /换 taskId/.test(a.via)), "该说明为什么没走正路：" + JSON.stringify(r.attempts));
});

// ── 只有 batchId（真宿主上 app 域就是这个形状）──
await okAsync("⑥ 只有 batchId 也能走通", async () => {
  const want = Buffer.from("from-batch");
  const asked = [];
  const sdk = {
    media: {
      listTasks: async (opts) => {
        asked.push(opts);
        assert.equal(opts.batchId, "batch-9", "该拿 batchId 去问");
        return { tasks: [
          { taskId: "older", completedAt: "2026-09-25T10:00:00Z" },
          { taskId: "newer", completedAt: "2026-09-25T11:00:00Z" }
        ] };
      },
      getTaskResources: async (taskId) => {
        assert.equal(taskId, "newer", "该取最新的那个 task");
        return { resources: [{ name: "p.png", resource: { kind: "session-file", fileId: "f9", sessionId: "s9" } }] };
      }
    },
    resources: { read: async () => want }
  };
  const r = await readProductBytes(sdk, { ok: true, kind: "image", batchId: "batch-9", prompt: "..." }, FAST);
  assert.equal(r.ok, true, "该成功");
  assert.equal(r.via, "session-file");
  assert.deepEqual(r.buf, want);
  assert.equal(asked.length, 1, "listTasks 只该问一次");
});

await okAsync("⑦ getTaskResources 报错也不放弃：getTask 里的 fileId 同样能读", async () => {
  const want = Buffer.from("via-getTask");
  const sdk = {
    media: {
      listTasks: async () => ({ tasks: [{ taskId: "t7", completedAt: "2026-09-25T11:00:00Z" }] }),
      getTaskResources: async () => {
        const e = new Error("APP_HOST_ERROR");
        e.code = "APP_HOST_ERROR";
        throw e;
      },
      getTask: async () => ({
        taskId: "t7", status: "completed", sessionId: "sess-7",
        sessionFiles: [{ fileId: "f7", name: "p7.png", mime: "image/png", size: 9 }]
      })
    },
    resources: {
      read: async (ref) => {
        assert.deepEqual(ref, { kind: "session-file", fileId: "f7", sessionId: "sess-7" }, "该用 task 自带的 fileId/sessionId");
        return want;
      }
    }
  };
  const r = await readProductBytes(sdk, { ok: true, kind: "image", batchId: "b7" }, FAST);
  assert.equal(r.ok, true, "该走通第二条正路");
  assert.equal(r.via, "session-file(task)");
  assert.deepEqual(r.buf, want);
  assert.ok(r.attempts.some((a) => /APP_HOST_ERROR/.test(a.error)), "第一条的失败该留下：" + JSON.stringify(r.attempts));
});

// ── 等待：产物是异步写完的（真宿主原话：Media task output is not complete）──
await okAsync("⑧ 还没写完就等：前两轮报 not complete，第三轮给字节", async () => {
  const want = Buffer.from("waited");
  let calls = 0;
  const sdk = {
    media: {
      listTasks: async () => ({ tasks: [{ taskId: "t8", completedAt: "x" }] }),
      getTaskResources: async () => {
        calls++;
        if (calls < 3) {
          const e = new Error("APP_HOST_ERROR Media task output is not complete");
          e.code = "APP_HOST_ERROR";
          e.message = "Media task output is not complete";
          throw e;
        }
        return { resources: [{ name: "p8.png", resource: { kind: "session-file", fileId: "f8", sessionId: "s8" } }] };
      },
      getTask: async () => ({ taskId: "t8", status: "running", sessionId: "s8", sessionFiles: [] })
    },
    resources: { read: async () => want }
  };
  const r = await readProductBytes(sdk, { ok: true, kind: "image", batchId: "b8" }, FAST);
  assert.equal(r.ok, true, "等到第三轮该成功");
  assert.deepEqual(r.buf, want);
  assert.ok(calls >= 3, `该真的轮询（实际问了 ${calls} 次）`);
  // 等待期间那些“还没完”的原因不该被当成失败留在结论里
  assert.ok(!r.attempts.some((a) => /not complete/i.test(a.error)), "等待中的“还没完”不该留在结论：" + JSON.stringify(r.attempts));
});

await okAsync("⑨ 一直没写完 → 超时，且说清等了多久、最后状态是什么", async () => {
  const sdk = {
    media: {
      listTasks: async () => ({ tasks: [{ taskId: "t9", completedAt: "x" }] }),
      getTaskResources: async () => {
        const e = new Error("Media task output is not complete");
        e.code = "APP_HOST_ERROR";
        throw e;
      },
      getTask: async () => ({ taskId: "t9", status: "running", sessionId: "s9", sessionFiles: [] })
    },
    resources: { read: async () => Buffer.from("never") }
  };
  const r = await readProductBytes(sdk, { ok: true, kind: "image", batchId: "b9" }, { timeoutMs: 60, intervalMs: 5 });
  assert.equal(r.ok, false);
  const waited = r.attempts.find((a) => a.via === "等待");
  assert.ok(waited, "该留一条“等待”的原因：" + JSON.stringify(r.attempts));
  assert.ok(/running/.test(waited.error), "该写出最后状态：" + waited.error);
});

await okAsync("⑩ 任务明确失败 → 立刻返回，不白等，并带出 failReason", async () => {
  const sdk = {
    media: {
      listTasks: async () => ({ tasks: [{ taskId: "t10", completedAt: "x" }] }),
      getTaskResources: async () => {
        const e = new Error("Media task output is not complete");
        e.code = "APP_HOST_ERROR";
        throw e;
      },
      getTask: async () => ({ taskId: "t10", status: "failed", failReason: "模型拒答", sessionId: "s10", sessionFiles: [] })
    },
    resources: { read: async () => Buffer.from("x") }
  };
  const t0 = Date.now();
  const r = await readProductBytes(sdk, { ok: true, kind: "image", batchId: "b10" }, { timeoutMs: 60_000, intervalMs: 5 });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 1000, "该立刻返回，不把超时等满");
  assert.ok(
    r.attempts.some((a) => /模型拒答/.test(a.error)),
    "该把 failReason 带出来：" + JSON.stringify(r.attempts)
  );
});

await fs.rm(tmp, { recursive: true, force: true });

console.log("");
if (failed.length) {
  console.error(`❌ 出图字节读取：${pass} 过 / ${failed.length} 败`);
  process.exit(1);
}
console.log(`✅ 出图字节读取：${pass} 过 / 0 败`);
