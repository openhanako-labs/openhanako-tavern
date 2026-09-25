// lib/gen/verify.js — 第三道：出处核对
//
// 这是整个功能可信度的落点：它不是让模型"少编一点"，而是把编出来的东西
// **删掉并计数**——把幻觉从一个藏在正文里的风险，变成一个看得见的数字。
//
// ## 只核事实性字段，理由要写清楚
//
//   核：description、世界书条目正文
//   不核：first_mes / mes_example / personality / scenario / tags
//
// 台词本来就是编的——开场白要是必须"有出处"，那卡就没法用了，
// 而一个没法用的核对会被使用者直接关掉，等于没有。
// personality 是概括、tags 是索引，都不是"可复核的断言"。
//
// ## 匹配为什么是宽松的
//
// 句子和事实几乎不会逐字相同（模型会换语序、加修饰）。所以按
// **词元覆盖率**判：句子里的词元有六成能在事实池里找到，就算有出处。
// 阈值刻意偏低：宁可少删，不可错删——错删会把用户想要的内容切碎，
// 那种损失比漏掉一句多半句要难挽回得多。

/** 少于这个字数（去标点后）的句子不参与核对：多半是风格短语。 */
const MIN_SENTENCE_CHARS = 8;

/** 词元覆盖率门槛。 */
const COVERAGE_MIN = 0.6;

const PUNCT = /[\s。！？!?；;、，,.·—…「」『』“”"'（）()《》〈〉【】\[\]]/g;

/** 把文本切成词元：拉丁词/数字串 + 中日韩 2-gram。 */
export function tokenize(text) {
  const s = String(text || "").toLowerCase();
  const out = [];

  for (const m of s.matchAll(/[a-z0-9]+/g)) {
    const w = m[0];
    // 纯数字串保留（年份、日期、编号都是有意义的断言）；
    // 拉丁词少于 3 个字母的多半是冠词介词，算进去只会拉高假阳性
    if (/^\d+$/.test(w) || w.length >= 3) out.push(w);
  }

  for (const m of s.matchAll(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g)) {
    const run = m[0];
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }

  return out;
}

/** 按句末标点切句，保留标点。 */
export function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[。！？!?；;])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function coverage(sentence, pool) {
  const toks = tokenize(sentence);
  if (toks.length === 0) return 1;                 // 没有可比的词元，不算越界
  let hit = 0;
  for (const t of toks) if (pool.has(t)) hit++;
  return hit / toks.length;
}

function isCheckable(sentence) {
  return sentence.replace(PUNCT, "").length >= MIN_SENTENCE_CHARS;
}

/** 核一段文字，返回保留下来的文字与被删句子。 */
function verifyText(text, pool) {
  const original = String(text || "");
  if (!original.trim()) return { text: original, dropped: [] };

  const sentences = splitSentences(original);
  const kept = [];
  const dropped = [];

  for (const s of sentences) {
    if (!isCheckable(s) || coverage(s, pool) >= COVERAGE_MIN) {
      kept.push(s);
    } else {
      dropped.push(s);
    }
  }

  // 一句都没删就原样返回——别把用户的文本重新拼一遍（拼一遍就多一次改动）
  if (dropped.length === 0) return { text: original, dropped: [] };
  return { text: kept.join(""), dropped };
}

/**
 * 核对并清理。
 *
 * @param {{card: object, book: object, facts: object[]}} args
 * @returns {{card: object, book: object, dropped: string[]}}
 */
export function verifyProvenance({ card, book, facts }) {
  const pool = new Set(tokenize((Array.isArray(facts) ? facts : []).map((f) => f.fact).join(" ")));
  const dropped = [];

  const outCard = { ...(card || {}) };
  const desc = verifyText(outCard.description, pool);
  outCard.description = desc.text;
  dropped.push(...desc.dropped);

  const entries = [];
  for (const e of book?.entries || []) {
    const v = verifyText(e.content, pool);
    if (v.dropped.length > 0 && v.text.replace(PUNCT, "").length === 0) {
      // 整条都被删空 → 条目本身没意义了，丢掉并记下内容
      dropped.push(...v.dropped);
      continue;
    }
    dropped.push(...v.dropped);
    entries.push({ ...e, content: v.text });
  }

  return { card: outCard, book: { entries }, dropped };
}
