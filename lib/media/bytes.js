// lib/media/bytes.js — 从出图产物里拿字节
//
// 为什么需要它（2026-09-25 在真宿主上撞出来的）：
//   出图产物落在 App 的可见范围之外（App 只能碰 ctx.dataDir 里的东西），
//   所以 `fs.readFile(绝对路径)` 会 EPERM/ENOENT —— 这不是文件不在，是它不该被看见。
//   而 app/media 契约本身给了正路：task 资源里带
//   `{ kind:"session-file", fileId, sessionId }`，用 ResourceIO 的 read() 读，
//   那条路是宿主认可的（对应 manifest 里的 app/resources.read）。
//
// 这里按“越正路越优先”的顺序试，**每次失败的原因原样带回去**：
// “试了哪几条、各自报什么”比一句“读不到”有用得多——上一轮就是被一句含糊的
// “读不到这个文件”白耽误了一轮，而真原因（范围之外）根本没露头。

import fs from "node:fs/promises";
import { isAbsolutePath, pickPaths } from "./service.js";

/** 把各种可能的字节形态归一成 Buffer。不同宿主版本给的形状不一样。 */
export function asBuffer(v) {
  if (!v) return null;
  if (Buffer.isBuffer(v)) return v;
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

/**
 * 从一次出图的结果里取出图片字节。
 *
 * @param {object} sdk 宿主 SDK（可能带 media / resources）
 * @param {object} res 出图返回（generateImage 的 raw，或 ComfyUI 的产物描述）
 * @param {{path?: string}} [opts] 兜底路径
 * @returns {Promise<{ok: boolean, buf: Buffer|null, via: string|null, name: string|null, attempts: Array<{via: string, error: string}>}>}
 */
export async function readProductBytes(sdk, res, opts = {}) {
  const attempts = [];
  const media = sdk?.media;
  const resources = sdk?.resources;

  const note = (via, e) => attempts.push({ via, error: e?.code || e?.message || String(e) });

  // ① 正路：问宿主要 task 资源引用，再按引用读
  const taskId = res?.taskId || res?.task?.taskId || res?.raw?.taskId || null;
  if (taskId && typeof media?.getTaskResources === "function") {
    try {
      const got = await media.getTaskResources(taskId, { scope: "own" });
      const list = Array.isArray(got?.resources) ? got.resources : [];
      if (!list.length) attempts.push({ via: "getTaskResources", error: "宿主返回空资源表" });
      for (const item of list) {
        const r = item?.resource;
        if (r?.kind === "session-file") {
          if (typeof resources?.read !== "function") {
            attempts.push({ via: "session-file", error: "宿主没提供 resources.read（manifest 里要 app/resources.read）" });
            continue;
          }
          try {
            const buf = asBuffer(await resources.read({ kind: "session-file", fileId: r.fileId, sessionId: r.sessionId }));
            if (buf?.length) return { ok: true, buf, via: "session-file", name: item.name || null, attempts };
            attempts.push({ via: "session-file", error: "读回来不是能认的字节形态" });
          } catch (e) {
            note("session-file", e);
          }
        } else if (r?.kind === "local-file" && isAbsolutePath(r.path)) {
          try {
            const buf = await fs.readFile(r.path);
            if (buf?.length) return { ok: true, buf, via: "task 资源里的本地路径", name: item.name || null, attempts };
          } catch (e) {
            note(`task 资源里的本地路径 ${r.path}`, e);
          }
        }
      }
    } catch (e) {
      note("getTaskResources", e);
    }
  } else {
    attempts.push({
      via: "getTaskResources",
      error: taskId ? "宿主没提供 media.getTaskResources" : "产物里没有 taskId（老版本契约？）"
    });
  }

  // ② 兜底：调用方给的路径 + 产物里带的路径
  const cands = [opts.path, ...pickPaths(res)].filter(isAbsolutePath);
  for (const p of cands) {
    try {
      const buf = await fs.readFile(p);
      if (buf?.length) return { ok: true, buf, via: "裸路径", name: p, attempts };
    } catch (e) {
      note(`裸路径 ${p}`, e);
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
