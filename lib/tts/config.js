// lib/tts/config.js — 语音合成的配置：读、写、以及"只回形状不回密钥"
//
// ## 一条硬纪律：密钥只进不出
//
// 用户在设置里填的 key 存在 App 自己的目录里（这是他自己填的凭据，
// 不是宿主代管的供应商凭据）。但从接口读回来时**永远不带原文**，
// 只回 hasKey —— 那一个布尔值就够界面说"已填好了"。
// 理由很实在：这个读接口会被前端、日志、截图随手带走，
// 一旦原文在里面，"用户自己填的东西"就变成了"随地可见的东西"。

import path from "node:path";
import { readJsonSafe, writeJsonLocked, ensureDir } from "../atomic.js";
import { emptyConfig, getProvider, DEFAULT_PROVIDER } from "./providers.js";

const FILE = "tts.json";

export function configPath(dataDir) {
  return path.join(dataDir, FILE);
}

function norm(raw) {
  const base = emptyConfig();
  const c = raw && typeof raw === "object" ? raw : {};
  const voices = {};
  if (c.voices && typeof c.voices === "object" && !Array.isArray(c.voices)) {
    for (const [k, v] of Object.entries(c.voices)) {
      const id = String(k || "").trim();
      const voice = String(v ?? "").trim();
      if (id && voice) voices[id] = voice.slice(0, 80);
    }
  }
  return {
    enabled: c.enabled === true,
    provider: getProvider(c.provider) ? c.provider : DEFAULT_PROVIDER,
    voice: String(c.voice ?? "").trim(),
    rate: String(c.rate ?? "").trim(),
    voices,
    azure: {
      region: String(c.azure?.region ?? "").trim(),
      key: String(c.azure?.key ?? "").trim()
    },
    openai: {
      baseUrl: String(c.openai?.baseUrl ?? "").trim(),
      model: String(c.openai?.model ?? "").trim() || base.model,
      key: String(c.openai?.key ?? "").trim()
    }
  };
}

export async function readConfig(dataDir) {
  return norm(await readJsonSafe(configPath(dataDir), null));
}

export async function writeConfig(dataDir, cfg) {
  await ensureDir(dataDir);
  await writeJsonLocked(configPath(dataDir), norm(cfg));
  return norm(cfg);
}

/**
 * 合并用户提交的补丁。
 *
 * 两条约定：
 *   · 字段没出现（undefined）→ 保持原值。界面只提交它改过的那几个字段。
 *   · 字符串是空串 → **清空**。因为"清空密钥"必须能被表达出来，
 *     而缺失字段又已经表示"没改"。这两件事不能共用一种写法。
 */
export function mergeConfig(prev, patch) {
  const cur = norm(prev);
  const p = patch && typeof patch === "object" ? patch : {};
  const next = {
    ...cur,
    voices: { ...cur.voices },
    azure: { ...cur.azure },
    openai: { ...cur.openai }
  };

  if (p.enabled !== undefined) next.enabled = p.enabled === true;
  if (p.provider !== undefined && getProvider(p.provider)) next.provider = p.provider;
  if (p.voice !== undefined) next.voice = String(p.voice ?? "").trim();
  if (p.rate !== undefined) next.rate = String(p.rate ?? "").trim();

  // 按角色分配：逐键合并。空串 = 把那个角色的声音去掉（回到全局）。
  if (p.voices && typeof p.voices === "object" && !Array.isArray(p.voices)) {
    for (const [k, v] of Object.entries(p.voices)) {
      const id = String(k || "").trim();
      if (!id) continue;
      const voice = String(v ?? "").trim();
      if (voice) next.voices[id] = voice.slice(0, 80);
      else delete next.voices[id];
    }
  }

  if (p.azure && typeof p.azure === "object") {
    if (p.azure.region !== undefined) next.azure.region = String(p.azure.region ?? "").trim();
    if (p.azure.key !== undefined) next.azure.key = String(p.azure.key ?? "").trim();
  }
  if (p.openai && typeof p.openai === "object") {
    if (p.openai.baseUrl !== undefined) next.openai.baseUrl = String(p.openai.baseUrl ?? "").trim();
    if (p.openai.model !== undefined) next.openai.model = String(p.openai.model ?? "").trim();
    if (p.openai.key !== undefined) next.openai.key = String(p.openai.key ?? "").trim();
  }

  return norm(next);
}

/** 当前选的那家，配全了没有。没配全时**说清缺什么**——界面照这句话显示。 */
export function readiness(cfg) {
  const c = norm(cfg);
  const p = getProvider(c.provider);
  if (!p) return { ready: false, reason: `不认识的语音提供方：${c.provider}` };

  if (p.id === "azure") {
    const miss = [];
    if (!c.azure.region) miss.push("region");
    if (!c.azure.key) miss.push("key");
    if (miss.length) return { ready: false, reason: `微软语音还缺 ${miss.join(" 与 ")}` };
  }
  if (p.id === "openai") {
    if (!c.openai.baseUrl) return { ready: false, reason: "这条路还缺 baseUrl" };
  }
  return { ready: true, reason: null };
}

/** 给界面看的配置：形状齐全，密钥只留一个"填没填"的布尔。 */
export function publicConfig(cfg) {
  const c = norm(cfg);
  const p = getProvider(c.provider);
  const r = readiness(c);
  return {
    enabled: c.enabled,
    provider: c.provider,
    providerLabel: p ? p.label : c.provider,
    voice: c.voice,
    defaultVoice: p ? p.defaultVoice : "",
    rate: c.rate,
    voices: { ...c.voices },
    azure: { region: c.azure.region, hasKey: !!c.azure.key },
    openai: { baseUrl: c.openai.baseUrl, model: c.openai.model, hasKey: !!c.openai.key },
    ready: r.ready,
    reason: r.reason
  };
}
