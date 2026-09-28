// lib/appearance/model.js — 外观配置：归一化、扩展名判定、文件名生成
//
// 纯函数层：不碰磁盘，不做 IO。所有落盘在 repo.js。
// 调用方（routes.js）只负责把请求喂进来、把结果回出去。

export const DEFAULTS = Object.freeze({
  veil: 0.78,
  blur: 0
});

export const LIMITS = Object.freeze({
  veil: [0.75, 0.99],
  blur: [0, 24]
});

export const ALLOWED_EXTS = Object.freeze(new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']));

export const MIME_MAP = Object.freeze({
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif:  'image/gif'
});

// content-type → 扩展名（取规范名，jpeg 不是 jpg）
const MIME_TO_EXT = Object.freeze({
  'image/png':  'png',
  'image/jpeg': 'jpeg',
  'image/jpg':  'jpg',
  'image/webp': 'webp',
  'image/gif':  'gif'
});

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

/**
 * 把任意输入归一化成规范的 appearance 配置。
 *
 * 契约（字段名不能改，前端按这个写）：
 *   { image: string|null, veil: number, blur: number, updatedAt: string }
 *
 * 归一化规则：
 *   · image：非空字符串保留，空串/undefined/null → null
 *   · veil：数字且有限 → 夹在 [0.75, 0.99]；否则用默认 0.78（0.86 只透 14%，照片几乎看不出来；0.78 透 22%，对比度 7.09:1）
 *     下限 0.75 不是口味，是算出来的：0.55 时正文色 #3d3427 压在纯黑照片上（此时合成色约 rgb(139,136,130)）的 WCAG 对比度只有 3.58:1，低于 AA 的 4.5:1；0.75 时为 6.57:1。虚线以下就得保证字能读。
 *   · blur：数字且有限 → 四舍五入后夹在 [0, 24]；否则用默认 0
 *   · updatedAt：非空字符串保留；否则用当前 ISO 时间
 *
 * @param {object} partial
 * @returns {{image:string|null, veil:number, blur:number, updatedAt:string}}
 */
export function normalizeAppearance(partial) {
  const p = (typeof partial === 'object' && partial !== null) ? partial : {};

  const image = (typeof p.image === 'string' && p.image.trim() !== '')
    ? p.image.trim()
    : null;

  const veil = (typeof p.veil === 'number' && Number.isFinite(p.veil))
    ? clamp(p.veil, LIMITS.veil[0], LIMITS.veil[1])
    : DEFAULTS.veil;

  const blur = (typeof p.blur === 'number' && Number.isFinite(p.blur))
    ? clamp(Math.round(p.blur), LIMITS.blur[0], LIMITS.blur[1])
    : DEFAULTS.blur;

  const updatedAt = (typeof p.updatedAt === 'string' && p.updatedAt !== '')
    ? p.updatedAt
    : new Date().toISOString();

  return { image, veil, blur, updatedAt };
}

/**
 * 判定上传文件的扩展名。
 *
 * 优先看 content-type，再看原文件名。两个都不认 → null。
 *
 * @param {string|undefined|null} contentType
 * @param {string|undefined|null} filename
 * @returns {string|null} 扩展名（不含点），或 null
 */
export function detectExt(contentType, filename) {
  if (typeof contentType === 'string' && contentType) {
    const ct = contentType.toLowerCase().split(';')[0].trim();
    const ext = MIME_TO_EXT[ct];
    if (ext && ALLOWED_EXTS.has(ext)) return ext;
  }
  if (typeof filename === 'string') {
    const m = /\.([a-z0-9]+)$/i.exec(filename);
    if (m) {
      const ext = m[1].toLowerCase();
      if (ALLOWED_EXTS.has(ext)) return ext;
    }
  }
  return null;
}

/** 扩展名 → Content-Type。认不出 → application/octet-stream。 */
export function mimeOf(ext) {
  return MIME_MAP[ext] || 'application/octet-stream';
}

/** 生成新的背景图文件名：bg-<Date.now()>.<ext> */
export function newImageFilename(ext) {
  return `bg-${Date.now()}.${ext}`;
}
