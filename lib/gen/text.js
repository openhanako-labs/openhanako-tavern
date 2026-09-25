// lib/gen/text.js — 文本层（纯函数，无网络）
//
// 这一层是整个「自动生成卡与世界书」的地基：把网页/接口原文变成干净的正文。
// 它坏起来是最难查的一种坏——不报错、不崩，只是安静地把正文切成垃圾，
// 然后喂给模型，产出看着像那么回事的东西。所以它必须被单测钉死。

const MOEGIRL_ORIGIN = "https://zh.moegirl.org.cn";

/** 常用实体。够用即可，剩下的走数字实体兜底。 */
const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", middot: "·", bull: "•",
  laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  copy: "©", reg: "®", trade: "™", deg: "°", times: "×", divide: "÷",
  plusmn: "±", frac12: "½", frac14: "¼", permil: "‰", prime: "′", Prime: "″",
  euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔",
  infin: "∞", ne: "≠", le: "≤", ge: "≥", asymp: "≈", sum: "∑", prod: "∏",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ",
  eta: "η", theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν",
  xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", chi: "χ", psi: "ψ",
  omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω", eacute: "é", egrave: "è", uuml: "ü",
};

/** 解 HTML 实体（命名 + 数字）。只认带分号的写法——半吊子实体留着比猜错好。 */
export function decodeEntities(s) {
  return String(s).replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : whole;
  });
}

/** 剥标签（不负责解实体）。 */
function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, " ");
}

/** 压缩空白并 trim。 */
function collapse(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

/**
 * 网页 → 纯文本。
 *
 * 顺序有讲究：先去掉注释（里面的引号会干扰后续匹配），再去掉 head，
 * 然后按「连内容一起删」的规则处理 script/style，最后才剥标签。
 * 反过来做的话，`<script>if (a<b) …</script>` 会漏一段进正文。
 *
 * @param {string} html
 * @param {{max?: number}} [opts] 截断上限（默认 6000 字符）
 */
export function htmlToText(html, { max = 6000 } = {}) {
  if (typeof html !== "string" || html === "") return "";
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<head\b[\s\S]*?<\/head>/gi, " ");
  s = s.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<br\s*\/?>/gi, " ");
  s = s.replace(/<\/(p|div|li|tr|td|th|h[1-6]|section|blockquote)\s*>/gi, " ");
  s = s.replace(/<[^>]*>/g, "");
  s = collapse(decodeEntities(s));
  if (Number.isFinite(max) && max > 0 && s.length > max) s = s.slice(0, max).trim();
  return s;
}

/** 不该当条目链的东西。 */
const SKIP_HREF = /^\/(index\.php|api\.php|w\/|wiki\/Special)/i;

/**
 * 从搜索结果页抠条目链。
 *
 * 判据刻意吃得浅（只认 href / title 两个属性），不吃 class 名——
 * 站点改版时 class 最先变。形状变了就返回空数组，不抛：
 * 「这次没搜到」和「解析器崩了」是两件事，调用方要能分开处理。
 *
 * @returns {{url: string, title: string}[]} 去重、保序、补成绝对 URL
 */
export function parseSearchLinks(html) {
  if (typeof html !== "string" || html === "") return [];
  const out = [];
  const seen = new Set();

  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const attrs = m[1] || "";
    const hrefM = /\bhref\s*=\s*"([^"]*)"/i.exec(attrs);
    if (!hrefM) continue;

    const href = decodeEntities(hrefM[1]);
    if (!href.startsWith("/")) continue;        // 站外
    if (SKIP_HREF.test(href)) continue;         // 搜索页自身 / 特殊页

    const titleM = /\btitle\s*=\s*"([^"]*)"/i.exec(attrs);
    const title = collapse(decodeEntities(titleM ? titleM[1] : stripTags(m[2])));
    if (!title) continue;
    if (title.includes(":")) continue;          // Help: / 萌娘百科: / File: …命名空间

    const seg = href.slice(1).split(/[?#]/)[0];
    if (!seg) continue;

    const url = `${MOEGIRL_ORIGIN}/${seg}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title });
  }
  return out;
}

/** 取第一个 <tag>…</tag> 的内文。 */
function pickTag(block, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, "i").exec(block);
  return m ? m[1] : "";
}

/** 取第一个 <tag … attr="…"> 的属性值。 */
function pickAttr(block, tag, attr) {
  const m = new RegExp(`<${tag}\\b[^>]*\\b${attr}\\s*=\\s*"([^"]*)"`, "i").exec(block);
  return m ? decodeEntities(m[1]) : "";
}

/**
 * arXiv 的 atom 响应 → 条目数组。
 *
 * 摘要是这里的正文来源（论文全文不是我们要的东西），所以 text 取 summary。
 * 不是 atom 就返回空数组——同 parseSearchLinks 的取舍。
 *
 * @returns {{url: string, title: string, text: string}[]}
 */
export function parseAtom(xml) {
  if (typeof xml !== "string" || !/<feed[\s>]/i.test(xml)) return [];
  const out = [];
  for (const m of xml.matchAll(/<entry\b[\s\S]*?<\/entry\s*>/gi)) {
    const block = m[0];
    const title = collapse(decodeEntities(stripTags(pickTag(block, "title"))));
    const url = pickAttr(block, "link", "href");
    const text = collapse(decodeEntities(stripTags(pickTag(block, "summary"))));
    if (!title && !url) continue;
    out.push({ url, title, text });
  }
  return out;
}
