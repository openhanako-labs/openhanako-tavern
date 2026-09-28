// lib/tts/match.js — 声音匹配的五级优先序
//
// 背景：以前只按 characterId 精确取 voices[characterId]，只能给「有角色卡、
// 且在这一场对话里」的人分配声音。用户要的是**按名字关键词匹配**——
// 世界书里的人、旁白、别的对话里的角色，都能靠名字分配。
//
// 于是 `voices` 的键从「只能 characterId」扩成「任意名字字符串」，id 键与
// 名字键**共存同一个 map**，共用一套合并、一套读取、一套清理。
//
// 匹配顺序（写死在这里，改这里就是改语义）：
//   1. characterId 精确    —— 老逻辑，最可信（后端知道这段消息属于哪个角色卡）
//   2. speaker 全等        —— 前端传来的「发言者名字」整字匹配
//   3. speaker 包含        —— 名字里含有某个 key（"薇拉"能匹配"薇拉·霜语"）
//   4. 全局默认 voice      —— cfg.voice
//   5. 供应商默认          —— provider.defaultVoice
//
// ## 为什么「包含匹配」要写这么严
//
// 用户明说了「云」这种单字关键词会撞车（几乎匹配所有人），这是**接受的代价**
// ——不拦、不阻止，但要给用户一个**匹配预览**让他自己看出来。
// 匹配算法本身尽量诚实：
//   · 先长后短——「薇拉·霜语」排在「薇拉」前面，避免先匹配到不完整的
//   · 同长优先靠前的（voices 是一个 map，JS 保证插入顺序）
//   · 命中一个就返回，把「赢的那个 key」与「在文本里的位置」都记下来
//
// ## voiceSource 与 voiceMatch 的分工
//
//   voiceSource：老字段，三档语义（caller/global/default），
//     老测试与老 UI 都认这个——**不能改**。
//     · caller  = 有 characterId 或 speaker，且匹配到了 voices map
//     · global  = 前面四级都没匹配，落到 cfg.voice
//     · default = 上面都没有，落到 provider.defaultVoice
//
//   voiceMatch：新字段，五档明细，只用来让响应里能说明「这段是用哪一级匹配的」。
//     日志、排查、以后加 UI 都靠它。老测试不认这个字段。
//
// 两个字段并存，各自服务于不同的读法。

import { getProvider } from "./providers.js";

/**
 * 从 voices map 里按五个级别找一个声音。
 *
 * @param {object} cfg 已归一化的配置（含 voices / voice / provider）
 * @param {object} opts
 *   characterId   角色卡 id（字符串或空）
 *   speaker       发言者名字（字符串或空；前端从消息元数据里带过来）
 *   text          要朗读的原文（匹配预览用它；不用于匹配本身，
 *                 放在同一个 opts 里方便调用方）
 * @returns {{
 *   voice: string,           // 最终决定用的声音
 *   voiceSource: string,     // caller | global | default
 *   voiceMatch: string       // charId | speakerExact | speakerContains | global | provider
 *   matchedKey?: string      // 当 voiceMatch=speakerContains 时，命中的那个 key
 * }}
 */
export function resolveVoice(cfg, opts = {}) {
  const c = cfg || {};
  const voices = c.voices && typeof c.voices === "object" ? c.voices : {};
  const characterId = String(opts.characterId ?? "").trim();
  const speaker = String(opts.speaker ?? "").trim();

  // 1. characterId 精确取
  if (characterId && typeof voices[characterId] === "string" && voices[characterId]) {
    return { voice: voices[characterId], voiceSource: "caller", voiceMatch: "charId" };
  }

  // 2. speaker 全等
  if (speaker) {
    if (typeof voices[speaker] === "string" && voices[speaker]) {
      return { voice: voices[speaker], voiceSource: "caller", voiceMatch: "speakerExact" };
    }
    // 3. speaker 包含（先长后短：先匹配最具体的名字）
    const hits = [];
    for (const [k, v] of Object.entries(voices)) {
      if (typeof v !== "string" || !v) continue;
      const key = String(k ?? "").trim();
      if (!key) continue;
      const idx = speaker.indexOf(key);
      if (idx >= 0) hits.push({ key, voice: v, idx, len: key.length });
    }
    if (hits.length > 0) {
      hits.sort((a, b) => (b.len - a.len) || (a.idx - b.idx));
      const h = hits[0];
      return { voice: h.voice, voiceSource: "caller", voiceMatch: "speakerContains", matchedKey: h.key };
    }
  }

  // 4. 全局默认 voice
  const globalVoice = String(c.voice ?? "").trim();
  if (globalVoice) {
    return { voice: globalVoice, voiceSource: "global", voiceMatch: "global" };
  }

  // 5. 供应商默认
  const prov = getProvider(String(c.provider ?? "") || "azure");
  return {
    voice: prov ? prov.defaultVoice : "",
    voiceSource: "default",
    voiceMatch: "provider"
  };
}

/**
 * 遍历一段文本，找出所有 voices key 的命中位置——给「匹配预览」用。
 *
 * 不是朗读时用的（朗读只看 characterId 与 speaker）；只用来在界面上高亮
 * 「这段话里出现了哪些名字、每个会用哪个声音」。
 *
 * 为什么单独一个函数：朗读接口不关心文本里出现了谁，它只按 speaker 找。
 * 但**匹配预览**要告诉用户「如果一段话里出现了老城主，会匹配到 X 声音」——
 * 这个信息朗读时不会用，但少它用户会以为是自己没配好。
 *
 * @param {string} text 要预览的文本
 * @param {object} voices voices map（{ name: voiceName }）
 * @returns {Array<{key: string, voice: string, start: number, end: number}>}
 */
export function previewMatches(text, voices) {
  const t = String(text ?? "");
  if (!t) return [];
  const map = voices && typeof voices === "object" ? voices : {};
  const out = [];
  for (const [k, v] of Object.entries(map)) {
    if (typeof v !== "string" || !v) continue;
    const key = String(k ?? "").trim();
    if (!key) continue;
    // 找出 text 里所有出现 key 的位置
    let from = 0;
    while (true) {
      const idx = t.indexOf(key, from);
      if (idx < 0) break;
      out.push({ key, voice: v, start: idx, end: idx + key.length });
      from = idx + 1;
    }
  }
  // 排序：先按起点，起点相同先长后短
  out.sort((a, b) => (a.start - b.start) || (b.key.length - a.key.length));
  return out;
}
