// lib/media/config.js — 出图用哪个引擎
//
// 用户点名要有这个开关："生成图片你也可以使用别的 APP 进行（比如 comfyuiAPP），
// 当然需要用户开关。"
//
// 两个后端，各自的代价不一样，所以开关不能含糊：
//   host   —— 宿主的媒体供应商（agnes 之类）。App 自己就能办，同步返回文件。
//   comfyui—— 本机 ComfyUI。画风、一致性、成本全在自己手里，但要：
//             ① ComfyUI 装着并且开着；② 指定用哪个工作流；③ 指定提示词写进哪个节点。
//             第 ②③ 条是这条路绕不开的：一个工作流里的提示词节点是**你的图**决定的，
//             App 猜不出来，猜错就是提交一堆 node_errors。
//
// 所以这个配置里，workflow 与 promptTarget 不是"高级选项"，是 comfyui 那条路的**必填项**。

import path from "node:path";
import { readJsonSafe, writeJsonLocked, ensureDir } from "../atomic.js";

const FILE = "image.json";

export const BACKENDS = [
  {
    id: "host",
    label: "宿主的媒体供应商",
    hint: "App 自己调，装上就能用；不用指定工作流。"
  },
  {
    id: "comfyui",
    label: "本机 ComfyUI",
    hint: "画风与一致性都在自己手里。要 ComfyUI 开着，并填好工作流与提示词节点。"
  }
];

export const DEFAULT_BACKEND = "host";

export function imageConfigPath(dataDir) {
  return path.join(dataDir, FILE);
}

export function emptyImageConfig() {
  return {
    backend: DEFAULT_BACKEND,
    workflow: "",
    promptTarget: ""
  };
}

function norm(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const backend = BACKENDS.some((b) => b.id === c.backend) ? c.backend : DEFAULT_BACKEND;
  return {
    backend,
    workflow: String(c.workflow ?? "").trim().slice(0, 200),
    // 形如 "6.text"。一个工作流里可能有好几个文本节点，所以必须写全。
    promptTarget: String(c.promptTarget ?? "").trim().slice(0, 60)
  };
}

export async function readImageConfig(dataDir) {
  return norm(await readJsonSafe(imageConfigPath(dataDir), null));
}

export async function writeImageConfig(dataDir, cfg) {
  await ensureDir(dataDir);
  await writeJsonLocked(imageConfigPath(dataDir), norm(cfg));
  return norm(cfg);
}

/** 合并补丁：缺字段 = 没改；空串 = 清空那一条。与 TTS 那边同一套口径。 */
export function mergeImageConfig(prev, patch) {
  const cur = norm(prev);
  const p = patch && typeof patch === "object" ? patch : {};
  const next = { ...cur };
  if (p.backend !== undefined && BACKENDS.some((b) => b.id === p.backend)) next.backend = p.backend;
  if (p.workflow !== undefined) next.workflow = String(p.workflow ?? "").trim();
  if (p.promptTarget !== undefined) next.promptTarget = String(p.promptTarget ?? "").trim();
  return norm(next);
}

/** 选中的这条路配全了没有；没配全就说清缺哪一项。 */
export function imageReadiness(cfg) {
  const c = norm(cfg);
  if (c.backend === "host") return { ready: true, reason: null };
  const miss = [];
  if (!c.workflow) miss.push("工作流");
  if (!c.promptTarget) miss.push("提示词节点");
  if (miss.length) return { ready: false, reason: `本机 ComfyUI 这条路还缺：${miss.join(" 与 ")}` };
  if (!/^\d+\.[a-zA-Z0-9_]+$/.test(c.promptTarget)) {
    return { ready: false, reason: `提示词节点要写成「节点号.输入名」，比如 6.text（现在填的是 ${c.promptTarget}）` };
  }
  return { ready: true, reason: null };
}

export function publicImageConfig(cfg) {
  const c = norm(cfg);
  const r = imageReadiness(c);
  return { ...c, ready: r.ready, reason: r.reason, backends: BACKENDS };
}
