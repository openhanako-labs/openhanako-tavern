// test/regression-archive.mjs — 三层滚动归档（第 3 期 A/E）
// node test/regression-archive.mjs

import { ensureArchive, recordSegment, maybeRollVolume, maybeRollWorld, composeArchiveContext, ARCHIVE_DEFAULTS } from "../lib/conversations/archive.js";

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label); }
}

// ── ensureArchive 幂等 + 老对话不崩 ──
{
  const a = ensureArchive({});
  ok(a.config.segmentsPerChapter === 8, "ensureArchive：默认阈值 8 段/章");
  const b = ensureArchive({ archive: { config: { segmentsPerChapter: 4 } } });
  ok(b.config.segmentsPerChapter === 4, "ensureArchive：用户配置覆盖默认");
  const conv = {};
  const c = ensureArchive(conv);
  const d = ensureArchive(conv);
  ok(c === d, "ensureArchive：幂等（同一对象返回）");
}

// ── recordSegment 滚章 ──
{
  const conv = {};
  let rolled = null;
  for (let i = 0; i < 8; i++) {
    const r = recordSegment(conv, { role: "assistant", content: `第 ${i+1} 段` });
    if (r?.rolledChapter) rolled = r.rolledChapter;
  }
  ok(rolled?.n === 1, "8 段滚出第 1 章");
  ok(rolled.coveredCount === 8, "章 coveredCount 推进");
  ok(conv.archive.pending.segCount === 0, "滚章后 pending 归零");
}

// ── 章内超 12 压前 4 ──
{
  const conv = {};
  conv.archive = { config: { segmentsPerChapter: 100, chapterCompressAt: 12 } };
  let compressed = null;
  for (let i = 0; i < 13; i++) {
    const r = recordSegment(conv, { role: "assistant", content: `段 ${i+1}` });
    if (r?.compressedChapter) compressed = r.compressedChapter;
  }
  ok(compressed?.dropFront === 4, "章内超 12 段压前 4");
  ok(conv.archive.pending.segCount === 9, "压后 pending 减 4");
}

// ── 滚卷 ──
{
  const conv = {};
  conv.archive = { config: { segmentsPerChapter: 2, chaptersPerVolume: 3 } };
  let vol = null;
  for (let i = 0; i < 6; i++) {
    recordSegment(conv, { role: "assistant", content: `段 ${i+1}` });
    const v = maybeRollVolume(conv);
    if (v) vol = v;
  }
  ok(vol?.n === 1 && vol.chapterCount === 3, "3 章滚出第 1 卷");
  ok(conv.archive.chapters.length === 0, "滚卷后已滚出的章挪走");
}

// ── 滚世界史 ──
{
  const conv = {};
  conv.archive = { config: { segmentsPerChapter: 1, chaptersPerVolume: 1, volumesPerHistory: 2 } };
  let entry = null;
  for (let i = 0; i < 4; i++) {
    recordSegment(conv, { role: "assistant", content: `段 ${i+1}` });
    maybeRollVolume(conv);
    const e = maybeRollWorld(conv);
    if (e) entry = e;
  }
  ok(entry?.fromVolume === 1 && entry?.toVolume === 2, "2 卷入世界史（1–2）");
  ok(conv.archive.volumes.length === 0, "入世界史后已滚出的卷挪走");
}

// ── composeArchiveContext ──
{
  const conv = {};
  ensureArchive(conv);
  conv.archive.chapters.push({ n: 1, summary: "第一章干了这些", segCount: 8, coveredCount: 8 });
  conv.archive.volumes.push({ n: 1, summary: "第一卷干了那些", chapterCount: 1, coveredCount: 8 });
  const r = composeArchiveContext(conv);
  ok(r.hasContent === true, "有归档时 hasContent=true");
  ok(r.text.includes("第一章干了这些") && r.text.includes("第一卷干了那些"), "章/卷摘要都进上下文");
  ok(r.chars === r.text.length, "chars 与 text 一致");
}

{
  const conv = {};
  const r = composeArchiveContext(conv);
  ok(r.hasContent === false && r.text === "", "无归档时零内容");
}

// ── 非 assistant 消息不记段 ──
{
  const conv = {};
  ensureArchive(conv);
  const r = recordSegment(conv, { role: "user", content: "用户的话" });
  ok(r === null && conv.archive.pending.segCount === 0, "用户消息不记段");
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
