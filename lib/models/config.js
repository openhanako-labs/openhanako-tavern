// lib/models/config.js — 模型按用途分选：全局默认 + 按用途覆盖
//
// ## 结构
//
//   {
//     default: { provider, model } | null,     // 全局默认；不设 = 走宿主目录挑出来的第一个
//     chat:    "default" | { provider, model }, // 正文生成（发消息、重生成）
//     vars:    "default" | { provider, model }, // 变量 / 状态更新（预留：目前仓库里没有对应的生成调用）
//     summary: "default" | { provider, model }, // 前情提要重写
//     suggest: "default" | { provider, model }, // 行动候选项
//     embed:   "default" | { provider, model }  // 向量：只读展示位，本 App 不接管 lib/embed 的那条路
//   }
//
// 每用途二态：`"default"` = 跟随全局默认；`{provider, model}` = 指定模型。
// 全局默认是 `null` 而用途又是 `"default"` 时，`resolveTargetFor()` 返回 `null`
// —— 交给 LLMService 走目录默认（`pickChatTargets(catalog)[0]`）。
//
// ## 为什么和 settings/model.js 名字相似却不是同一个东西
//
// settings/model.js 管的是「世界书条目」的数据模型。这个文件管的是
// 「用哪个模型」的 App 级配置。命名上刻意分开——两者互不相干，
// 但都属「配置」，放同一个目录会误导后来人。
//
// ## 落盘位置
//
// `<dataDir>/models.json`，与其它 App 配置（scene.json / tts.json /
// image.json）同层。不塞进 settings.json——那是世界书条目，语义完全不同。
//
// ## 与 llm/service.js resolveTarget 的边界
//
// 本文件负责「按用途选出该用谁」；`resolveTarget` 负责「把 {provider, model}
// 解析成宿主能认的目标，找不到就退回目录默认」。两者分工清楚：
//   · 本文件不知道目录长什么样——它是"配置意图"层
//   · service 不知道配置长什么样——它是"目录解析"层
// 调用点做粘合：`resolveTargetFor(purpose)` 拿到结果后传给 `generate`/`streamEvents`
// 的 `target` 参数，缺失时 resolveTarget 自己回退。

import path from "node:path";
import { readJsonSafe, writeJsonLocked, ensureDir } from "../atomic.js";

const FILE = "models.json";

/**
 * 用途枚举。
 *
 * 顺序即 UI 从上到下的顺序：先全局，再正文，再衍生用途，最后向量。
 * 新增用途时先在这里加，再在 UI 与调用点补上——两处不同步就是「配了没生效」。
 */
export const PURPOSES = ["chat", "vars", "summary", "suggest", "embed"];

/** 每用途的中文名。界面显示用；后端不依赖它。 */
export const PURPOSE_LABELS = {
  chat: "正文生成",
  vars: "变量与状态",
  summary: "前情提要",
  suggest: "行动候选",
  embed: "向量"
};

/** 每用途的一句说明。界面副标题；后端不依赖。 */
export const PURPOSE_NOTES = {
  chat: "发消息与重生成走的这一路。改它影响最大——所有对话都会换模型。",
  vars: "变量账与状态更新走的那一路（预留：目前仓库里没有独立的生成调用，配了暂时不动）。",
  summary: "把旧历史折叠成前情提要的那一次。它短、稳，适合便宜的模型。",
  suggest: "每轮正文后自动给的行动候选。独立一次调用，不进正文 prompt。",
  embed: "向量检索走的那一路（lib/embed 自管）。这里**只展示当前值**，改它不会动 lib/embed。"
};

/** 单个用途的默认状态：跟随全局。 */
function emptyPurpose() {
  return { mode: "default" };
}

/** 全新配置：一切都跟随默认，等价于「什么都没配」= 走宿主目录。 */
export function emptyConfig() {
  return {
    default: null,
    chat: emptyPurpose(),
    vars: emptyPurpose(),
    summary: emptyPurpose(),
    suggest: emptyPurpose(),
    embed: emptyPurpose()
  };
}

export function configPath(dataDir) {
  if (!dataDir) throw new Error("models-config 需要 dataDir");
  return path.join(dataDir, FILE);
}

/** 把一个原始条目归一成 { provider, model }；不合规返回 null。 */
function normTarget(raw) {
  if (!raw || typeof raw !== "object") return null;
  const provider = String(raw.provider ?? "").trim();
  const model = String(raw.model ?? "").trim();
  if (!provider || !model) return null;
  return { provider, model };
}

/**
 * 归一整个配置。缺字段一律按「跟随默认」补齐——
 * 而不是按「没配」，否则一次补丁就把整份配置削没了。
 *
 * `default: null` 是显式合法的（用户主动清掉默认）；空对象与坏值都当 null。
 */
export function norm(raw) {
  const base = emptyConfig();
  const c = raw && typeof raw === "object" ? raw : {};

  base.default = normTarget(c.default) || null;

  for (const p of PURPOSES) {
    const v = c[p];
    if (!v || typeof v !== "object") {
      // 缺失或非对象 → 跟随默认
      base[p] = emptyPurpose();
    } else {
      const t = normTarget(v);
      base[p] = t ? { mode: "target", provider: t.provider, model: t.model } : emptyPurpose();
    }
  }

  return base;
}

export async function readConfig(dataDir) {
  if (!dataDir) return emptyConfig();
  return norm(await readJsonSafe(configPath(dataDir), null));
}

export async function writeConfig(dataDir, cfg) {
  if (!dataDir) throw new Error("写 models 配置需要 dataDir");
  await ensureDir(dataDir);
  await writeJsonLocked(configPath(dataDir), norm(cfg));
  return norm(cfg);
}

/**
 * 合并补丁。
 *
 * 三条约定（与 tts/config.js 保持一致）：
 *   · 字段没出现 → 保持原值。前端只提交改过的那一格。
 *   · `default: null` 是**显式清空**（不是"没改"）。
 *   · 单用途传 `"default"` 或 `{mode:"default"}` = 回到跟随默认；
 *     传 `{provider, model}` 或 `{mode:"target", provider, model}` = 指定。
 */
export function mergeConfig(prev, patch) {
  const cur = norm(prev);
  const p = patch && typeof patch === "object" ? patch : {};
  const next = { ...cur };

  // 全局默认：显式 null = 清空；对象 = 覆盖；不出现 = 不改
  if (Object.prototype.hasOwnProperty.call(p, "default")) {
    next.default = p.default === null ? null : (normTarget(p.default) || null);
  }

  for (const key of PURPOSES) {
    if (!Object.prototype.hasOwnProperty.call(p, key)) continue;
    const v = p[key];
    if (v === "default" || (v && typeof v === "object" && v.mode === "default")) {
      next[key] = emptyPurpose();
      continue;
    }
    const t = normTarget(v);
    next[key] = t ? { mode: "target", provider: t.provider, model: t.model } : emptyPurpose();
  }

  return norm(next);
}

/**
 * 解析某个用途该用谁。
 *
 * 三层回退：
 *   1. 该用途指定了模型 → 用它
 *   2. 该用途「跟随默认」而全局默认有值 → 用全局默认
 *   3. 全局默认也没设 → null（交给 LLMService.resolveTarget 走目录默认）
 *
 * 返回 `{ provider, model }` 或 `null`。调用方把它塞进 generate/streamEvents 的
 * `target` 参数——resolveTarget 见到 null 就走目录第一个 chat 模型。
 */
export function resolveTargetFor(cfg, purpose) {
  const c = norm(cfg);
  const p = PURPOSES.includes(purpose) ? purpose : "chat";
  const entry = c[p] || emptyPurpose();
  if (entry.mode === "target" && entry.provider && entry.model) {
    return { provider: entry.provider, model: entry.model };
  }
  return c.default ? { provider: c.default.provider, model: c.default.model } : null;
}

/**
 * 给界面用的形状：带上枚举、标签、当前每用途实际生效的目标。
 *
 * 之所以单独给一个 publicConfig 而不直接回 config：
 *   · config 里 mode 是内部语义（"default" / "target"），UI 更想拿到「当前是谁」
 *   · purposes 枚举带上顺序，UI 不需要知道代码里怎么排的
 *   · 每个用途的 effectiveTarget 是**已应用三层回退之后**的结果——
 *     UI 一行就能画出「现在用的是 X，跟随默认」/「现在用的是 Y，本项指定」
 */
export function publicConfig(cfg) {
  const c = norm(cfg);
  const purposes = PURPOSES.map(p => {
    const entry = c[p];
    const effective = resolveTargetFor(c, p);
    return {
      id: p,
      label: PURPOSE_LABELS[p] || p,
      note: PURPOSE_NOTES[p] || "",
      // mode：内部语义透出，UI 判断「跟随 / 指定」二态用它
      mode: entry.mode,
      // 该用途自己指定的目标（可能为空 = 跟随默认）
      target: entry.mode === "target" ? { provider: entry.provider, model: entry.model } : null,
      // 当前实际生效的目标（已经过回退）
      effectiveTarget: effective
    };
  });
  return {
    default: c.default,
    purposes,
    available: PURPOSES
  };
}
