// lib/memory/config.js — 记忆面板：三格硬编码参数提到 App 配置
//
// ## 三格
//
//   {
//     keepRecent:      4,          // 短期记忆至少保留最近多少条（history.trimHistory）
//     summaryMaxChars: 500,        // 前情提要的字数上限（summary-llm.SUMMARY_MAX_CHARS）
//     summaryPrompt:   ""          // 前情提要的 systemPrompt；空 = 用 summary-llm 里的默认模板
//   }
//
// ## 为什么单独一个文件、不塞进 settings
//
// settings.json 里是「世界书条目」——每个条目有自己的开关、触发条件、正文。
// 这个文件是 App 级偏好，跟 tts/image/scene 一个语义。落盘位置也是同层：
// <dataDir>/memory.json。
//
// ## 为什么不接向量记忆开关
//
// lib/embed 目前只有 `embed()`（算向量）和 `status()`（体检），
// 没有把向量存下来、也没有按余弦检索历史的路子。加一个「向量记忆」开关
// 只能做成「关了走现状」「开了也是走现状」——两条路一样，等于没接。
// 评估结论写在方案文档 §四 S2，等存储 + 检索那两块真正到位再回来接。
//
// ## 与 llm/history.js 的边界
//
// keepRecent 只是**默认值**——trimHistory 里 keepRecent 仍然是一个函数默认值，
// 本文件只提供 App 级偏好，调用方（pipeline）读出来传进去。
// 这样「不读配置文件就直接调 trimHistory」的老路径不变。
//
// ## 与 summary-llm.js 的边界
//
// summary-llm.js 顶部的三条防编约束（只压缩、不新增、不写成对话口吻）写在默认
// 模板里。用户可以在这里覆盖 summaryPrompt——覆盖之后那三条由用户负责，
// UI 会把默认模板展示出来让人知道改掉了什么。默认模板一字不动。

import path from "node:path";
import { readJsonSafe, writeJsonLocked, ensureDir } from "../atomic.js";
import { DEFAULT_SUMMARY_PROMPT_TEMPLATE } from "../conversations/summary-llm.js";

const FILE = "memory.json";

/** 默认值。所有默认值都是仓库当前硬编码的常量——改这里就是改默认行为。 */
export const DEFAULTS = {
  keepRecent: 4,
  summaryMaxChars: 500,
  summaryPrompt: "",
  // 预热召回（S3）：发消息时对世界书/角色卡/对话历史做关键词召回。
  // 高置信直接注入，低置信进轻 ReAct 循环（≤ maxLoops）。
  // 三格默认全开——这是**默认行为**，不是"加了一层保险"。
  recallEnabled: true,
  recallBudget: 8000,   // LLM token 预算（低置信路径）
  recallMaxLoops: 3     // ReAct 循环上限
};

/** 上下限。防止用户填一个 0（等于关）或者 10^9（等于没上限）。 */
const LIMITS = {
  keepRecent:       { min: 1, max: 40 },
  summaryMaxChars:  { min: 50, max: 5000 },
  summaryPrompt:    { maxLen: 4000 },
  // 召回预算：太小循环跑不起来，太大一次发消息烧太多 token。
  //   min 800：至少够一次 LLM 调用 + 系统提示
  //   max 64000：与 Sirchmunk 默认对齐；再大就属于"失控"了
  recallBudget:     { min: 800, max: 64000 },
  // 循环上限：一次循环大约花 1500–3000 token，
  //   min 1 允许"只搜不循环"，max 10 是 Sirchmunk 默认
  recallMaxLoops:   { min: 1, max: 10 }
};

export function configPath(dataDir) {
  if (!dataDir) throw new Error("memory-config 需要 dataDir");
  return path.join(dataDir, FILE);
}

/** 全新配置。等价于「什么都没配」= 走仓库现状。 */
export function emptyConfig() {
  return { ...DEFAULTS };
}

/** 把一个数值塞进 [min, max] 区间；不合规一律回默认值。
 *
 * null / undefined 与 “非数字” 回默认值；显式 0 与负数 = 按上限夹住。
 */
function clampNum(v, key) {
  const d = DEFAULTS[key];
  const { min, max } = LIMITS[key];
  if (v == null) return d;   // null / undefined
  const n = Number(v);
  if (!Number.isFinite(n) || Number.isNaN(n)) return d;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * 归一整个配置。缺字段一律补齐默认——
 * 前端 patch 里少一格不影响另几格。
 */
export function norm(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const prompt = typeof c.summaryPrompt === "string" ? c.summaryPrompt : "";
  return {
    keepRecent: clampNum(c.keepRecent, "keepRecent"),
    summaryMaxChars: clampNum(c.summaryMaxChars, "summaryMaxChars"),
    // summaryPrompt 只保字符串；超长截断，不静默丢弃
    summaryPrompt: prompt.length > LIMITS.summaryPrompt.maxLen
      ? prompt.slice(0, LIMITS.summaryPrompt.maxLen)
      : prompt,
    // 召回开关：非 boolean 一律回默认（true）
    recallEnabled: typeof c.recallEnabled === "boolean"
      ? c.recallEnabled
      : DEFAULTS.recallEnabled,
    recallBudget: clampNum(c.recallBudget, "recallBudget"),
    recallMaxLoops: clampNum(c.recallMaxLoops, "recallMaxLoops")
  };
}

export async function readConfig(dataDir) {
  if (!dataDir) return emptyConfig();
  return norm(await readJsonSafe(configPath(dataDir), null));
}

export async function writeConfig(dataDir, cfg) {
  if (!dataDir) throw new Error("写 memory 配置需要 dataDir");
  await ensureDir(dataDir);
  await writeJsonLocked(configPath(dataDir), norm(cfg));
  return norm(cfg);
}

/**
 * 合并补丁。约定与 lib/models/config.js 一致：
 *   · 字段没出现 → 保持原值
 *   · 显式空字符串 = 清掉自定义提示词（回默认模板）
 *   · 显式 0 / 负数 / 非数字 → 回默认值（norm 里已经挡掉）
 */
export function mergeConfig(prev, patch) {
  const cur = norm(prev);
  const p = patch && typeof patch === "object" ? patch : {};
  const next = { ...cur };

  if (Object.prototype.hasOwnProperty.call(p, "keepRecent")) {
    next.keepRecent = clampNum(p.keepRecent, "keepRecent");
  }
  if (Object.prototype.hasOwnProperty.call(p, "summaryMaxChars")) {
    next.summaryMaxChars = clampNum(p.summaryMaxChars, "summaryMaxChars");
  }
  if (Object.prototype.hasOwnProperty.call(p, "summaryPrompt")) {
    next.summaryPrompt = typeof p.summaryPrompt === "string" ? p.summaryPrompt : "";
  }
  if (Object.prototype.hasOwnProperty.call(p, "recallEnabled")) {
    next.recallEnabled = typeof p.recallEnabled === "boolean" ? p.recallEnabled : cur.recallEnabled;
  }
  if (Object.prototype.hasOwnProperty.call(p, "recallBudget")) {
    next.recallBudget = clampNum(p.recallBudget, "recallBudget");
  }
  if (Object.prototype.hasOwnProperty.call(p, "recallMaxLoops")) {
    next.recallMaxLoops = clampNum(p.recallMaxLoops, "recallMaxLoops");
  }

  return norm(next);
}

/** 上限枚举给 UI 画输入框的 min/max。 */
export function limits() {
  return {
    keepRecent: LIMITS.keepRecent,
    summaryMaxChars: LIMITS.summaryMaxChars,
    summaryPrompt: { maxLength: LIMITS.summaryPrompt.maxLen },
    recallBudget: LIMITS.recallBudget,
    recallMaxLoops: LIMITS.recallMaxLoops
  };
}

/**
 * 给界面用的形状：默认值 + 当前值 + 是否覆盖（自定义提示词 vs 默认模板）。
 */
export function publicConfig(cfg) {
  const c = norm(cfg);
  return {
    keepRecent: c.keepRecent,
    summaryMaxChars: c.summaryMaxChars,
    summaryPrompt: c.summaryPrompt,
    // isCustom 只判断非空串——空串就是「用默认模板」
    summaryPromptIsCustom: c.summaryPrompt.trim().length > 0,
    recallEnabled: c.recallEnabled,
    recallBudget: c.recallBudget,
    recallMaxLoops: c.recallMaxLoops,
    defaults: { ...DEFAULTS },
    limits: limits(),
    // 默认模板原样下发，UI 展示「你现在改掉了什么」——不写进文件（它跟代码同生命周期）。
    defaultSummaryPromptTemplate: DEFAULT_SUMMARY_PROMPT_TEMPLATE
  };
}
