// lib/conversations/archive.js — 三层滚动归档（卷/章/段）
//
// 与现有 conv.summary 的关系：追加式，不替换。
//   · conv.summary 管「近期未超预算的部分」——prepareHistory 按 token 预算丢最早消息时生成。
//   · conv.archive 管「已滚出短期记忆的部分」——段攒满滚成章、章攒满滚成卷、卷攒满入世界史。
// 两层都进 prompt：composeArchiveContext 拼在 summary 前面，摘要只压下一层（章压段、卷压章、
// 世界史压卷），不越层压原始消息（二次压缩丢细节，越层丢更多）。
//
// 段单位：一条 assistant 消息（剧情卡 cwv1 或普通都算一段）。
// 阈值挂 config，默认 8 段/章 · 8 章/卷 · 5 卷/世界史 · 章内超 12 段压前 4。

/** 归档默认阈值。 */
export const ARCHIVE_DEFAULTS = {
  segmentsPerChapter: 8,   // 几段滚一章
  chaptersPerVolume: 8,    // 几章滚一卷
  volumesPerHistory: 5,    // 几卷入世界史
  chapterCompressAt: 12    // 章内超过几段时压前 4 段
};

/** 空归档。 */
function emptyArchive(config = {}) {
  return {
    config: { ...ARCHIVE_DEFAULTS, ...config },
    chapters: [],
    volumes: [],
    worldHistory: [],
    pending: { segCount: 0, coveredCount: 0 }
  };
}

/**
 * 惰性初始化 conv.archive。老对话没有这层，不崩。
 * @returns {object} conv.archive（原地初始化并返回）
 */
export function ensureArchive(conv) {
  if (!conv || typeof conv !== "object") return emptyArchive();
  if (!conv.archive || typeof conv.archive !== "object") conv.archive = emptyArchive();
  const a = conv.archive;
  a.config = { ...ARCHIVE_DEFAULTS, ...(a.config || {}) };
  a.chapters = Array.isArray(a.chapters) ? a.chapters : [];
  a.volumes = Array.isArray(a.volumes) ? a.volumes : [];
  a.worldHistory = Array.isArray(a.worldHistory) ? a.worldHistory : [];
  a.pending = (a.pending && typeof a.pending === "object") ? a.pending : { segCount: 0, coveredCount: 0 };
  return a;
}

/**
 * 记一段。返回发生了什么（什么都没发生就回 null）。
 *
 * @param {object} conv
 * @param {object} message  assistant 消息（取 content 进摘要素材）
 * @returns {null|{rolledChapter?:object, compressedChapter?:object}}
 */
export function recordSegment(conv, message) {
  if (!conv || !message || message.role !== "assistant") return null;
  const a = ensureArchive(conv);
  const cfg = a.config;

  a.pending.segCount += 1;
  a.pending.coveredCount += 1;

  const out = {};
  // 章内超阈值：压前 4 段（章摘要重写由调用方做，这里只推进账）
  if (a.pending.segCount > cfg.chapterCompressAt) {
    out.compressedChapter = { dropFront: 4, note: `章内超 ${cfg.chapterCompressAt} 段，压前 4 段` };
    a.pending.segCount -= 4;
  }
  // 满一章：滚章
  if (a.pending.segCount >= cfg.segmentsPerChapter) {
    const n = a.chapters.length + 1;
    const ch = { n, summary: "", segCount: a.pending.segCount, coveredCount: a.pending.coveredCount };
    a.chapters.push(ch);
    a.pending.segCount = 0;
    out.rolledChapter = ch;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 满一卷：滚卷。返回新卷（或 null）。
 */
export function maybeRollVolume(conv) {
  const a = ensureArchive(conv);
  const cfg = a.config;
  if (a.chapters.length < cfg.chaptersPerVolume) return null;
  const n = a.volumes.length + 1;
  const vol = {
    n,
    summary: "",
    chapterCount: cfg.chaptersPerVolume,
    coveredCount: a.chapters[a.chapters.length - 1]?.coveredCount ?? a.pending.coveredCount
  };
  a.volumes.push(vol);
  // 滚出的章从 chapters 里挪走（它们的摘要已并进卷）
  a.chapters = a.chapters.slice(cfg.chaptersPerVolume);
  return vol;
}

/**
 * 满世界史阈值：入世界史。返回新世界史条（或 null）。
 */
export function maybeRollWorld(conv) {
  const a = ensureArchive(conv);
  const cfg = a.config;
  if (a.volumes.length < cfg.volumesPerHistory) return null;
  const fromVolume = a.volumes[0]?.n ?? 1;
  const toVolume = a.volumes[cfg.volumesPerHistory - 1]?.n ?? cfg.volumesPerHistory;
  const entry = {
    fromVolume,
    toVolume,
    summary: "",
    at: new Date().toISOString()
  };
  a.worldHistory.push(entry);
  // 滚出的卷挪走
  a.volumes = a.volumes.slice(cfg.volumesPerHistory);
  return entry;
}

/**
 * 给管线的前情提要增强文本。
 *
 * 拼「近 1 章摘要 + 近 1 卷摘要 + 世界史（如有）」，供 prompt 注入在现有 summary 前面。
 * 不替换 conv.summary——它管近期，这里管滚出。
 *
 * @returns {{text:string, chars:number, hasContent:boolean}}
 */
export function composeArchiveContext(conv) {
  const a = ensureArchive(conv);
  const parts = [];

  const recentChapter = a.chapters[a.chapters.length - 1];
  if (recentChapter?.summary) {
    parts.push(`第 ${recentChapter.n} 章：${recentChapter.summary}`);
  }
  const recentVolume = a.volumes[a.volumes.length - 1];
  if (recentVolume?.summary) {
    parts.push(`第 ${recentVolume.n} 卷：${recentVolume.summary}`);
  }
  for (const h of a.worldHistory) {
    if (h.summary) parts.push(`世界史（第 ${h.fromVolume}–${h.toVolume} 卷）：${h.summary}`);
  }

  const text = parts.length > 0 ? parts.join("\n") : "";
  return { text, chars: text.length, hasContent: parts.length > 0 };
}

export default {
  ARCHIVE_DEFAULTS,
  ensureArchive,
  recordSegment,
  maybeRollVolume,
  maybeRollWorld,
  composeArchiveContext
};
