// lib/media/bytes.js — 从出图产物里拿字节
//
// 这一路的形状是**在真宿主上一层层换出来的**，每一步都留着为什么：
//
//   ① App 只能碰 ctx.dataDir 里的东西（media.d.ts 原话），
//      所以 `fs.readFile(绝对路径)` 会 EPERM/ENOENT——不是文件不在，是它不该被看见。
//   ② app 域出图的返回**没有** files / sessionFiles / taskId，只有一个 batchId：
//      `{ ok:true, kind:"image", batchId, prompt }`（工具域不是这样，别拿那边套）。
//   ③ batchId → listTasks({batchId}) → taskId
//   ④ taskId → getTaskResources(taskId) → { kind:"session-file", fileId, sessionId }
//      → ctx.resources.read(ref) → 字节
//      另有第二条正路：getTask(taskId).sessionFiles[].fileId + task.sessionId，
//      两条都写，不把成败押在一个接口上。
//   ⑤ **要等**：产物是异步写完的，刚拿到 batchId 就去要，宿主会回
//      `APP_HOST_ERROR Media task output is not complete`。
//      所以这里轮询到完成或超时，而不是问一次就判死。
//
// 报错纪律：每次失败的原因原样带回去（code + message + details）。
// 只有代号（APP_HOST_ERROR）等于自己把线索剪了——这一路上已经吃过两次亏。

import fs from "node:fs/promises";
import { isAbsolutePath, pickPaths } from "./service.js";

/** 把各种可能的字节形态归一成 Buffer。不同宿主版本给的形状不一样。 */
export function asBuffer(v) {
  if (!v) return null;
  if (Buffer.isBuffer(v)) return Buffer.from(v);
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (v instanceof ArrayBuffer) return Buffer.from(new Uint8Array(v));
  if (typeof v === "string") {
    const m = /^data:[^;]+;base64,(.*)$/s.exec(v);
    if (m) return Buffer.from(m[1], "base64");
    // 纯 base64 才按 base64 解；否则宁可认不出来，也不要解出一堆乱码当真图
    const t = v.trim();
    if (t.length > 64 && /^[A-Za-z0-9+/=\s]+$/.test(t)) return Buffer.from(t, "base64");
    return null;
  }
  if (typeof v === "object") {
    for (const k of ["bytes", "buffer", "data", "content", "base64", "body", "value"]) {
      const got = asBuffer(v[k]);
      if (got?.length) return got;
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把一次异常说成有信息量的一句话（三段去重，只取代号等于剪掉线索）。 */
function whyOf(e) {
  const parts = [e?.code, e?.message, e?.details ? JSON.stringify(e.details).slice(0, 160) : null]
    .filter((x) => x && String(x).trim());
  const uniq = [...new Set(parts.map((x) => String(x).trim()))];
  return uniq.join(" ") || String(e);
}

/** 完成态判定：宿主的说法不止一种，认不出的按“还没完”处理（宁可多等一轮）。 */
function isComplete(status) {
  return /^(completed|succeeded|success|done|finished)$/i.test(String(status || "").trim());
}
function isFailed(status) {
  return /^(failed|error|canceled|cancelled|removed)$/i.test(String(status || "").trim());
}
function looksNotReady(msg) {
  return /not complete|not ready|pending|in ?progress|still running/i.test(String(msg || ""));
}

/** 试两条正路各一次。返回 {ok, buf, via, name}；失败写进 attempts。 */
async function tryOnce(sdk, taskId, attempts) {
  const media = sdk?.media;
  const resources = sdk?.resources;
  const note = (via, e) => attempts.push({ via, error: whyOf(e) });

  // 正路一：getTaskResources
  if (typeof media?.getTaskResources === "function") {
    try {
      const got = await media.getTaskResources(taskId, { scope: "own" });
      const list = Array.isArray(got?.resources) ? got.resources : [];
      for (const item of list) {
        const r = item?.resource;
        if (r?.kind === "session-file") {
          if (typeof resources?.read !== "function") {
            // 不能静默跳过：这条路本来能走，只是缺一只手。
            attempts.push({ via: "session-file", error: "宿主没提供 resources.read（manifest 里要 app/resources.read）" });
            continue;
          }
          try {
            const buf = asBuffer(await resources.read({ kind: "session-file", fileId: r.fileId, sessionId: r.sessionId }));
            if (buf?.length) return { ok: true, buf, via: "session-file", name: item.name || null };
            attempts.push({ via: "session-file", error: "读回来不是能认的字节形态" });
          } catch (e) {
            note(`session-file(fileId=${r.fileId})`, e);
          }
        } else if (r?.kind === "local-file" && isAbsolutePath(r.path)) {
          try {
            const buf = await fs.readFile(r.path);
            if (buf?.length) return { ok: true, buf, via: "task 资源里的本地路径", name: item.name || null };
          } catch (e) {
            note(`task 资源里的本地路径 ${r.path}`, e);
          }
        }
      }
      if (!list.length) attempts.push({ via: "getTaskResources", error: "宿主返回空资源表" });
    } catch (e) {
      note("getTaskResources", e);
    }
  } else {
    attempts.push({ via: "getTaskResources", error: "宿主没提供 media.getTaskResources" });
  }

  // 正路二：getTask 自带 sessionFiles[].fileId 与 sessionId
  if (typeof media?.getTask === "function") {
    try {
      const task = await media.getTask(taskId, { scope: "own" });
      const files = Array.isArray(task?.sessionFiles) ? task.sessionFiles : [];
      if (!files.length) {
        attempts.push({ via: "getTask.sessionFiles", error: `task 里没有 sessionFiles（status=${task?.status ?? "?"}）` });
        return { ok: false, buf: null, via: null, name: null, status: task?.status ?? null, failReason: task?.failReason ?? null };
      }
      for (const f of files) {
        if (!f?.fileId) continue;
        if (typeof resources?.read !== "function") {
          attempts.push({ via: "getTask.sessionFiles", error: "宿主没提供 resources.read（manifest 里要 app/resources.read）" });
          break;
        }
        try {
          const buf = asBuffer(await resources.read({ kind: "session-file", fileId: f.fileId, sessionId: task.sessionId }));
          if (buf?.length) return { ok: true, buf, via: "session-file(task)", name: f.name || null };
          attempts.push({ via: "getTask.sessionFiles", error: "读回来不是能认的字节形态" });
        } catch (e) {
          note(`session-file(fileId=${f.fileId})`, e);
        }
      }
      return { ok: false, buf: null, via: null, name: null, status: task?.status ?? null, failReason: task?.failReason ?? null };
    } catch (e) {
      note("getTask", e);
    }
  } else {
    attempts.push({ via: "getTask", error: "宿主没提供 media.getTask" });
  }

  return { ok: false, buf: null, via: null, name: null, status: null, failReason: null };
}

/**
 * 从一次出图的结果里取出图片字节。产物没写完就等它，等到超时为止。
 *
 * @param {object} sdk 宿主 SDK（要 media；读文件要 resources）
 * @param {object} res 出图返回（app 域常见形状：{ok, kind, batchId, prompt}）
 * @param {{path?: string, timeoutMs?: number, intervalMs?: number}} [opts]
 */
export async function readProductBytes(sdk, res, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 120_000;
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 1500;
  const media = sdk?.media;
  const attempts = [];
  const deadline = Date.now() + timeoutMs;

  // 换 taskId：可能直接就给了，也可能只有一个 batchId
  let taskId = res?.taskId || res?.task?.taskId || res?.raw?.taskId || null;
  const batchId = res?.batchId || res?.batch?.batchId || null;
  if (!taskId && batchId && typeof media?.listTasks === "function") {
    try {
      const got = await media.listTasks({ batchId, scope: "own" });
      const tasks = Array.isArray(got?.tasks) ? got.tasks : [];
      const order = (t) => String(t?.completedAt || t?.createdAt || "");
      const newest = tasks.slice().sort((a, b) => order(b).localeCompare(order(a)))[0];
      if (newest?.taskId) taskId = newest.taskId;
      else attempts.push({ via: "listTasks(batchId)", error: `返回里没有 taskId（${tasks.length} 条）` });
    } catch (e) {
      attempts.push({ via: "listTasks(batchId)", error: whyOf(e) });
    }
  }

  // 有 taskId：轮询到拿得到字节 / 明确失败 / 超时
  if (taskId) {
    let lastStatus = null;
    for (;;) {
      const round = [];
      const got = await tryOnce(sdk, taskId, round);
      if (got.ok) return { ok: true, buf: got.buf, via: got.via, name: got.name, attempts: [...attempts, ...round] };

      lastStatus = got.status ?? lastStatus;
      if (got.status && isFailed(got.status)) {
        return {
          ok: false, buf: null, via: null, name: null,
          attempts: [...attempts, ...round, { via: "task 状态", error: `任务失败：${got.failReason || got.status}` }]
        };
      }

      // 该不该继续等：只认两种信号。
      //   ① 宿主 / 任务状态明确在跑；② 失败原因里明说“还没写完”。
      // 不能因为“没有状态信息”就一路等——那不是“可能还没完”，那是“不知道”，
      // 而“不知道”时优的是把原因原样交回去，不是白等两分钟。
      const st = String(got.status || "").trim();
      const stPending = /^(running|pending|queued|processing|created|submitted|in[_-]?progress)$/i.test(st);
      const msgNotReady = round.some((a) => looksNotReady(a.error));
      const waitMore = stPending || msgNotReady;

      if (waitMore && Date.now() < deadline) {
        await sleep(intervalMs);
        continue;
      }

      attempts.push(...round);
      if (waitMore) {
        attempts.push({
          via: "等待",
          error: `等了 ${Math.round(timeoutMs / 1000)} 秒产物还没写完（最后状态：${lastStatus || "未知"}）`
        });
      }
      break;
    }
  } else {
    attempts.push({
      via: "换 taskId",
      error: batchId
        ? "有 batchId 但换不回 taskId（宿主没提供 media.listTasks？）"
        : "产物里既没有 taskId 也没有 batchId"
    });
  }

  // 兜底：调用方给的路径 + 产物里带的路径（app 域通常一个都没有）
  const cands = [opts.path, ...pickPaths(res)].filter(isAbsolutePath);
  for (const p of cands) {
    try {
      const buf = await fs.readFile(p);
      if (buf?.length) return { ok: true, buf, via: "裸路径", name: p, attempts };
    } catch (e) {
      attempts.push({ via: `裸路径 ${p}`, error: whyOf(e) });
    }
  }
  if (!cands.length) attempts.push({ via: "裸路径", error: "没有可用的绝对路径" });

  return { ok: false, buf: null, via: null, name: null, attempts };
}

/** 把 attempts 说成人话，用在错误消息里。 */
export function explainAttempts(attempts) {
  if (!attempts?.length) return "（没试出任何一条可用的路）";
  return attempts.map((a) => `${a.via} → ${a.error}`).join("；");
}
