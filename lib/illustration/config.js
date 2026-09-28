// lib/illustration/config.js — 场景插图设置
//
// 与 lib/media/config.js（出图引擎）分工：
//   · media/config.js 管"用哪条路出图"（宿主 / 本机 ComfyUI）
//   · 本文件管"什么条件下出图"（scene.enabled / mode / characterRef / style）
//
// 三个开关各自的理由：
//   enabled    —— 总闸。默认关，因为它是花钱的动作（模型 API + 显存）。
//                 计划 §5 判据 2 的硬要求：**默认关是硬要求**。
//   mode       —— marker | off。marker = 只有模型给了 [场景] 才画；
//                 off = 完全不出图（相当于 enabled 关掉，但是**分开开关**，
//                 保留 enabled=true 的语义用于手动补一张的入口）。
//   characterRef —— 提示词里要不要带角色卡的描述/性格，以及要不要把立绘当参考图挂上去。
//                 默认**开**。2026-09-27 真机复测（本机实跑两张，对照看图）：
//                 宿主**收** referenceImages，而且真的在用——立绘上那些具体的造型细节
//                 （斗篷的金色菱形扣、前臂那圈皮革护腕）都进了场景图，
//                 而那些细节提示词文字里根本没有。开着不失败，也不降级。
//                 对照：关掉时提示词里**只剩名字**，画出来的人和卡毫无关系。
//
//                 与同日早先一次实测（开着就报 Media task failed）对不上，
//                 中间宿主侧可能变过；以复测为准：**现在能用**。
//                 service.js 的降级重试仍是安全网：哪天后端又不认了，
//                 最坏也只是白花一次调用，图照出。
//
// 为什么 style 独立于 image.json 的 backend：
//   立绘用的是 portraitPrompt 的默认风格，场景插图用的是
//   sceneIllustrationPrompt 的默认风格（宽画幅）。两条风格各自独立，
//   改一边的默认值不应该影响另一边。

import path from "node:path";
import { readJsonSafe, writeJsonLocked, ensureDir } from "../atomic.js";

const FILE = "scene.json";

export const MODES = ["marker", "off"];
export const DEFAULT_MODE = "marker";

function norm(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const mode = MODES.includes(c.mode) ? c.mode : DEFAULT_MODE;
  return {
    enabled: c.enabled === true,        // 严格：只认 === true
    mode,
    // 默认开：缺字段 = 没表态 = 用默认；显式 false 才关。
    characterRef: c.characterRef === false ? false : true,
    style: typeof c.style === "string" ? c.style.trim().slice(0, 160) : ""
  };
}

export function sceneConfigPath(dataDir) {
  if (!dataDir) throw new Error("scene-config 需要 dataDir");
  return path.join(dataDir, FILE);
}

export function emptySceneConfig() {
  return {
    enabled: false,       // 默认关：不替用户决定花钱
    mode: DEFAULT_MODE,
    characterRef: true,    // 默认开：宿主收参考图且在用（见文件头）
    style: ""
  };
}

export async function readSceneConfig(dataDir) {
  return norm(await readJsonSafe(sceneConfigPath(dataDir), null));
}

export async function writeSceneConfig(dataDir, cfg) {
  await ensureDir(dataDir);
  await writeJsonLocked(sceneConfigPath(dataDir), norm(cfg));
  return norm(cfg);
}

/** 合并补丁：缺字段 = 没改。语义与 media/config.js 的 mergeImageConfig 一致。 */
export function mergeSceneConfig(prev, patch) {
  const cur = norm(prev);
  const p = patch && typeof patch === "object" ? patch : {};
  const next = { ...cur };
  if (p.enabled === true || p.enabled === false) next.enabled = p.enabled;
  if (p.mode !== undefined && MODES.includes(p.mode)) next.mode = p.mode;
  if (p.characterRef === true || p.characterRef === false) next.characterRef = p.characterRef;
  if (p.style !== undefined) next.style = String(p.style ?? "").trim().slice(0, 160);
  return norm(next);
}

/**
 * 这条配置当前对"自动出图"是否生效。
 *   enabled=false → 不出（总闸）
 *   mode=off      → 不出（这条路径全关）
 *   其余          → 生效
 *
 * 只判定"要不要出"，不判定"出得出来不"（那是 media/config 的事）。
 */
export function sceneAutoTrigger(cfg) {
  const c = norm(cfg);
  if (!c.enabled) return { active: false, reason: "scene.enabled=false" };
  if (c.mode === "off") return { active: false, reason: "scene.mode=off" };
  return { active: true, reason: null };
}

/** 给界面看的形状：带上 modes 枚举与当前"实际是否会触发自动出图"。 */
export function publicSceneConfig(cfg) {
  const c = norm(cfg);
  const t = sceneAutoTrigger(c);
  return { ...c, modes: MODES, autoTriggerActive: t.active, autoTriggerReason: t.reason };
}
