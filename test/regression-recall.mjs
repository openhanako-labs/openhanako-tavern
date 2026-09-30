// test/regression-recall.mjs — 预热召回（S3）
//
// 覆盖七件事：
//   1. 倒排索引：tokenize + build + search（含权重与过滤）
//   2. RecallContext：预算扣减、超限、去重、循环计数
//   3. ReAct 循环四条路径：ANSWER / 工具调用 / nudge / 兜底
//   4. 预热高置信直注入
//   5. 低置信进循环
//   6. 召回失败静默降级
//   7. memory/config.js 新加的三格 recall* 配置
//
// 依赖真仓库对象（characterRepo / settingRepo / conversationRepo）
// 都用注入模式（直接传 list）绕开 IO。
//
// 所有测试串行 await，保证汇总数字准确。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const R = await import("../lib/recall/index.js");
const C = await import("../lib/recall/context.js");
const L = await import("../lib/recall/loop.js");
const T = await import("../lib/recall/tools.js");
const CFG = await import("../lib/memory/config.js");

let pass = 0, fail = 0;
const results = [];
function record(name, ok, err) {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}\n     ${err?.message || err}`); }
  results.push({ name, ok, err: err?.message });
}

async function run(name, fn) {
  try { await fn(); record(name, true); }
  catch (e) { record(name, false, e); }
}

// ── 假的 LLM（按脚本回放） ────────────────────────────
function fakeLLM(script) {
  let i = 0;
  return {
    calls: 0,
    messages: [],
    async generate(messages, opts = {}) {
      this.calls++;
      this.messages.push([...messages]);
      const step = script[Math.min(i, script.length - 1)];
      i++;
      if (typeof step === "string") {
        return { content: step, usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }, stopReason: "stop" };
      }
      return { content: "", usage: { prompt_tokens: 50, completion_tokens: 0, total_tokens: 50 }, stopReason: "stop" };
    }
  };
}

// ── 测试夹具 ──────────────────────────────────────────
const SAMPLE_CHARS = [
  { id: "c1", name: "艾德娜·夜航", description: "夜之城街头枪手，曼恩团队的后卫。皮拉的妹妹。", personality: "嘴上不说但心里都懂", scenario: "霓虹暗巷", first_mes: "行。", system_prompt: "" },
  { id: "c2", name: "皮拉", description: "夜之城的医生，温柔但果断。", personality: "医者仁心", scenario: "诊所", first_mes: "进来吧。", system_prompt: "" }
];
const SAMPLE_SETTINGS = [
  { id: "s1", name: "夜之城背景", keywords: ["夜之城", "Night City"], content: "夜之城是一个虚构的赛博朋克都市，霓虹与暗巷并存。曼恩团队是街头活跃的雇佣兵小队。" },
  { id: "s2", name: "诊所说明", keywords: ["诊所", "医疗"], content: "皮拉的诊所位于夜之城东区，医疗水平高于平均。" }
];
const SAMPLE_CONVS = [
  { id: "d1", title: "夜航船日常", characterId: "c1", messages: [
    { role: "user", content: "你上次去哪了？" },
    { role: "assistant", content: "夜之城的酒吧，喝了两杯。" }
  ]},
  { id: "d2", title: "诊所探病", characterId: "c2", messages: [
    { role: "user", content: "你身体怎么样？" },
    { role: "assistant", content: "诊所里坐着，医生来看过我。" }
  ]}
];

function makeIdx() {
  const idx = new R.InvertedIndex();
  idx.addEntry({ id: "char:c1", title: "艾德娜·夜航", name: "艾德娜·夜航", body: "曼恩团队的枪手，夜之城街头。", kind: "character" });
  idx.addEntry({ id: "char:c2", title: "皮拉", name: "皮拉", body: "夜之城的医生。", kind: "character" });
  idx.addEntry({ id: "lore:s1", title: "曼恩团队", name: "曼恩", body: "夜之城雇佣兵小队。成员包括艾德娜与皮拉。", kind: "lore" });
  return idx;
}

// ── 主流程 ────────────────────────────────────────────

await (async () => {

console.log("\n=== 预热召回 · 倒排索引 ===\n");

await run("tokenize：中文 bigram", () => {
  const t = R.tokenize("夜航船酒馆");
  assert.ok(t.includes("夜航"), "应包含「夜航」，实际：" + t.join(","));
  assert.ok(t.includes("航船"));
  assert.ok(t.includes("船酒"));
  assert.ok(t.includes("酒馆"));
});

await run("tokenize：拉丁按 [a-z0-9_]{2,} 切", () => {
  const t = R.tokenize("Night City 2077 hello!");
  assert.ok(t.includes("night"));
  assert.ok(t.includes("city"));
  assert.ok(t.includes("2077"));
  assert.ok(t.includes("hello"));
});

await run("tokenize：去重", () => {
  const t = R.tokenize("夜航 夜航 夜航");
  assert.deepEqual(t, ["夜航"]);
});

await run("dropStopwords：中英文停用词都被去掉", () => {
  const raw = R.tokenize("the cat and 我你他");
  const cleaned = R.dropStopwords(raw);
  assert.ok(!cleaned.includes("the"));
  assert.ok(!cleaned.includes("and"));
  assert.ok(cleaned.includes("cat"));
});

await run("extractKeywords：按长度降序 + 数量上限", () => {
  const kws = R.extractKeywords("夜之城的艾德娜在诊所里见了皮拉", { maxWords: 5 });
  assert.ok(Array.isArray(kws));
  assert.ok(kws.length <= 5);
  for (let i = 1; i < kws.length; i++) {
    assert.ok(kws[i - 1].length >= kws[i].length, `第 ${i} 个应比第 ${i+1} 个长或等长：${kws[i-1]} vs ${kws[i]}`);
  }
});

await run("InvertedIndex：加入 + 检索", () => {
  const idx = new R.InvertedIndex();
  idx.addEntry({ id: "char:c1", title: "艾德娜·夜航", name: "艾德娜·夜航", body: "夜之城街头枪手，曼恩团队的后卫。", kind: "character" });
  idx.addEntry({ id: "char:c2", title: "皮拉", name: "皮拉", body: "夜之城的医生", kind: "character" });
  const hits = idx.search(["夜之城"], { topK: 5 });
  assert.ok(hits.length >= 1, "应至少有 1 条命中");
  assert.equal(hits[0].id, "char:c1", "title 命中的应排在 body 命中的前面：" + hits.map(h => h.id));
});

await run("InvertedIndex：权重顺序（title 3.0 / name 2.5 / body 1.0）", () => {
  const idx = new R.InvertedIndex();
  idx.addEntry({ id: "a", title: "", name: "", body: "夜航船酒馆" });
  idx.addEntry({ id: "b", title: "夜航船酒馆", name: "", body: "" });
  idx.addEntry({ id: "c", title: "", name: "夜航船酒馆", body: "" });
  const hits = idx.search(["夜航船酒馆"]);
  assert.equal(hits[0].id, "b", "title 命中应排最前：" + hits.map(h => h.id + "(" + h.score + ")"));
  assert.equal(hits[1].id, "c");
  assert.equal(hits[2].id, "a");
});

await run("InvertedIndex：characterId 过滤", () => {
  const idx = new R.InvertedIndex();
  idx.addEntry({ id: "conv:d1", title: "A", body: "x", characterId: "c1" });
  idx.addEntry({ id: "conv:d2", title: "A", body: "x", characterId: "c2" });
  idx.addEntry({ id: "conv:d3", title: "A", body: "x", characterId: null });
  const hits = idx.search(["A"], { characterId: "c1" });
  assert.ok(hits.every(h => h.characterId === "c1" || h.characterId === null), "应只保留 c1 和 null：" + hits.map(h => h.characterId));
});

await run("buildIndex：从注入的 lists 建索引", () => {
  const idx = R.buildIndex({ characters: SAMPLE_CHARS, settings: SAMPLE_SETTINGS, conversations: SAMPLE_CONVS });
  assert.equal(idx.size, SAMPLE_CHARS.length + SAMPLE_SETTINGS.length + SAMPLE_CONVS.length, "索引应有 6 条：" + idx.size);
  const hits = idx.search(["曼恩"], { topK: 3 });
  assert.ok(hits.some(h => h.id === "char:c1"), "应能命中艾德娜的卡：" + hits.map(h => h.id));
});

await run("buildIndex：跳过禁用条目", () => {
  const idx = R.buildIndex({
    characters: [],
    settings: [
      { id: "on", name: "开", content: "测试", enabled: true },
      { id: "off", name: "关", content: "测试", enabled: false }
    ],
    conversations: []
  });
  assert.equal(idx.size, 1, "只该有一条启用条目：" + idx.size);
});

console.log("\n=== 预热召回 · 账本 ===\n");

await run("RecallContext：默认预算与循环上限", () => {
  const ctx = new C.RecallContext();
  assert.equal(ctx.maxTokenBudget, 8000);
  assert.equal(ctx.maxLoops, 3);
  assert.equal(ctx.budgetRemaining, 8000);
});

await run("RecallContext：addLLMTokens + budgetRemaining", () => {
  const ctx = new C.RecallContext({ maxTokenBudget: 1000 });
  ctx.addLLMTokens(300, { total_tokens: 300 });
  assert.equal(ctx.totalLLMTokens, 300);
  assert.equal(ctx.budgetRemaining, 700);
  ctx.addLLMTokens(400, { total_tokens: 400 });
  assert.equal(ctx.budgetRemaining, 300);
});

await run("RecallContext：isBudgetExceeded（大于而非等于）", () => {
  const ctx = new C.RecallContext({ maxTokenBudget: 1000 });
  ctx.addLLMTokens(1000);
  assert.equal(ctx.isBudgetExceeded(), false, "等于预算时不算超");
  ctx.addLLMTokens(1);
  assert.equal(ctx.isBudgetExceeded(), true, "大于预算才算超");
});

await run("RecallContext：markEntryRead 去重", () => {
  const ctx = new C.RecallContext();
  ctx.markEntryRead("char:c1");
  assert.equal(ctx.isEntryRead("char:c1"), true);
  assert.equal(ctx.isEntryRead("char:c2"), false);
});

await run("RecallContext：循环计数与上限", () => {
  const ctx = new C.RecallContext({ maxLoops: 3 });
  assert.equal(ctx.isLoopLimitReached(), false);
  ctx.incrementLoop();
  ctx.incrementLoop();
  ctx.incrementLoop();
  assert.equal(ctx.isLoopLimitReached(), true);
});

await run("RecallContext：addLog + addSearch", () => {
  const ctx = new C.RecallContext();
  ctx.addSearch("夜之城|曼恩");
  ctx.addLog("search", 0, { hits: 3 });
  assert.equal(ctx.searchHistory.length, 1);
  assert.equal(ctx.retrievalLogs.length, 1);
  assert.equal(ctx.retrievalLogs[0].toolName, "search");
});

await run("RecallContext：summary() 一行摘要", () => {
  const ctx = new C.RecallContext({ maxTokenBudget: 1000, maxLoops: 3 });
  ctx.incrementLoop();
  ctx.addLLMTokens(100, { total_tokens: 100 });
  const s = ctx.summary();
  assert.ok(s.includes("loops=1/3"), s);
  assert.ok(s.includes("tokens=100/1000"), s);
});

console.log("\n=== 预热召回 · 工具表 ===\n");

await run("createRecallTools：search 返回结果文本", async () => {
  const idx = new R.InvertedIndex();
  idx.addEntry({ id: "char:c1", title: "艾德娜", name: "艾德娜", body: "曼恩团队的枪手", kind: "character" });
  idx.addEntry({ id: "char:c2", title: "皮拉", name: "皮拉", body: "医生", kind: "character" });
  const ctx = new C.RecallContext();
  const tools = T.createRecallTools({ index: idx, ctx });
  const r = await tools.search.execute({ keywords: ["曼恩"] });
  assert.equal(r.ok, true);
  assert.ok(r.text.includes("char:c1"), "结果里应有 c1：" + r.text);
  assert.equal(ctx.searchHistory.length, 1);
});

await run("createRecallTools：search 空 keywords 报错", async () => {
  const idx = new R.InvertedIndex();
  const ctx = new C.RecallContext();
  const tools = T.createRecallTools({ index: idx, ctx });
  const r = await tools.search.execute({ keywords: [] });
  assert.equal(r.ok, false);
  assert.ok(r.text.includes("keywords"));
});

await run("createRecallTools：read_entry 去重", async () => {
  const idx = new R.InvertedIndex();
  idx.addEntry({ id: "char:c1", title: "艾德娜", name: "艾德娜", body: "曼恩团队", kind: "character" });
  const ctx = new C.RecallContext();
  const tools = T.createRecallTools({ index: idx, ctx });
  const r1 = await tools.read_entry.execute({ id: "char:c1" });
  assert.equal(r1.ok, true);
  const r2 = await tools.read_entry.execute({ id: "char:c1" });
  assert.equal(r2.ok, false, "第二次读应被拒绝");
  assert.equal(r2.dedup, true);
  assert.ok(r2.text.includes("已经读过"));
});

await run("createRecallTools：read_entry 找不到条目", async () => {
  const idx = new R.InvertedIndex();
  const ctx = new C.RecallContext();
  const tools = T.createRecallTools({ index: idx, ctx });
  const r = await tools.read_entry.execute({ id: "char:不存在" });
  assert.equal(r.ok, false);
  assert.ok(r.text.includes("找不到"));
});

console.log("\n=== 预热召回 · ReAct 循环 ===\n");

await run("loop：ANSWER 标签直接收工（不调工具）", async () => {
  const llm = fakeLLM(["我有证据了：<ANSWER>曼恩团队里有艾德娜与皮拉。</ANSWER>"]);
  const ctx = new C.RecallContext({ maxTokenBudget: 8000, maxLoops: 3 });
  const { answer, ctx: c } = await L.runRecallLoop({
    llm, index: makeIdx(), ctx, query: "曼恩团队有谁？",
    initialKeywords: ["曼恩"], preloadedEvidence: "线索：char:c1 / lore:s1"
  });
  assert.equal(answer, "曼恩团队里有艾德娜与皮拉。");
  assert.equal(c.telemetry.finishedBy, "answer");
  assert.ok(c.loopCount >= 1, "至少跑了一次循环");
});

await run("loop：工具调用 → 下一轮 → ANSWER", async () => {
  const script = [
    '{"tool":"search","arguments":{"keywords":["曼恩团队"]}}',
    "<ANSWER>找到了。</ANSWER>"
  ];
  const llm = fakeLLM(script);
  const ctx = new C.RecallContext({ maxTokenBudget: 8000, maxLoops: 4 });
  const { answer, ctx: c } = await L.runRecallLoop({
    llm, index: makeIdx(), ctx, query: "曼恩团队有谁？"
  });
  assert.equal(answer, "找到了。");
  assert.ok(c.retrievalLogs.some(l => l.toolName === "search"), "应记录了 search 调用：" + JSON.stringify(c.retrievalLogs));
  assert.equal(llm.calls, 2, "LLM 应被调 2 次：" + llm.calls);
});

await run("loop：nudge 一次后成功", async () => {
  const script = [
    "哦我在想...",
    "<ANSWER>有曼恩团队。</ANSWER>"
  ];
  const llm = fakeLLM(script);
  const ctx = new C.RecallContext({ maxTokenBudget: 8000, maxLoops: 5 });
  const { answer } = await L.runRecallLoop({
    llm, index: makeIdx(), ctx, query: "测试"
  });
  assert.equal(answer, "有曼恩团队。");
  assert.equal(llm.calls, 2, "应调 LLM 两次（nudge 加一次）：" + llm.calls);
});

await run("loop：预算耗尽走兜底合成", async () => {
  const script = [
    "让我想想...",
    "再想想...",
    "<ANSWER>兜底的答案。</ANSWER>"
  ];
  const llm = fakeLLM(script);
  const ctx = new C.RecallContext({ maxTokenBudget: 500, maxLoops: 10 });
  const { answer, ctx: c } = await L.runRecallLoop({
    llm, index: makeIdx(), ctx, query: "测试"
  });
  assert.ok(typeof answer === "string");
  assert.ok(c.telemetry.forcedSynthesis || c.telemetry.hardBudgetExhausted, "应触发兜底：" + JSON.stringify(c.telemetry));
});

await run("loop：循环上限到达后走兜底", async () => {
  const script = [
    '让我搜一下...',
    '{"tool":"search","arguments":{"keywords":["a"]}}',
    '{"tool":"search","arguments":{"keywords":["b"]}}',
    "<ANSWER>循环上限后的兜底。</ANSWER>"
  ];
  const llm = fakeLLM(script);
  const ctx = new C.RecallContext({ maxTokenBudget: 8000, maxLoops: 2 });
  const { answer, ctx: c } = await L.runRecallLoop({
    llm, index: makeIdx(), ctx, query: "测试"
  });
  assert.equal(c.loopCount, 2, "循环数应停在 2：" + c.loopCount);
  assert.ok(answer.length > 0, "兜底应产出 answer：" + answer);
});

await run("loop：parseToolCall 支持代码块 JSON", () => {
  const text = '好的，我来搜一下：\n```json\n{"tool":"search","arguments":{"keywords":["夜之城"]}}\n```';
  const tc = L.parseToolCall(text, ["search", "read_entry"]);
  assert.ok(tc, "应能解析出工具调用：" + tc);
  assert.equal(tc.name, "search");
  assert.deepEqual(tc.args.keywords, ["夜之城"]);
});

await run("loop：parseToolCall 支持裸 JSON", () => {
  const text = '我准备调用 {"tool":"read_entry","arguments":{"id":"char:c1"}} 一下。';
  const tc = L.parseToolCall(text, ["search", "read_entry"]);
  assert.ok(tc);
  assert.equal(tc.name, "read_entry");
  assert.equal(tc.args.id, "char:c1");
});

await run("loop：parseToolCall 支持 name/args 键（Sirchmunk 兼容）", () => {
  const text = '{"name":"search","args":{"keywords":["皮拉"]}}';
  const tc = L.parseToolCall(text, ["search", "read_entry"]);
  assert.ok(tc);
  assert.equal(tc.name, "search");
  assert.deepEqual(tc.args.keywords, ["皮拉"]);
});

await run("loop：parseToolCall 未知工具返回 null", () => {
  const tc = L.parseToolCall('{"tool":"unknown","arguments":{}}', ["search", "read_entry"]);
  assert.equal(tc, null);
});

console.log("\n=== 预热召回 · 编排 ===\n");

await run("高置信直注入（不调 LLM）", async () => {
  const r = await R.recall({
    input: "曼恩团队在做什么？",
    characters: [
      { id: "c1", name: "曼恩团队", description: "曼恩团队曼恩团队曼恩团队", personality: "", scenario: "", first_mes: "" },
      { id: "c2", name: "无关", description: "x", personality: "", scenario: "", first_mes: "" }
    ],
    enabled: true,
    confidenceRatio: 2,
    confidenceMin: 1,
    llm: null
  });
  assert.equal(r.injected, true);
  assert.equal(r.mode, "direct");
  assert.ok(r.evidence && r.evidence.length > 0, "应注入证据文本：" + r.evidence);
});

await run("低置信进循环（走 LLM）", async () => {
  const llm = fakeLLM(["<ANSWER>结论：艾德娜是曼恩团队的成员。</ANSWER>"]);
  const r = await R.recall({
    input: "曼恩团队里的艾德娜是谁？",
    characters: [
      { id: "c1", name: "艾德娜·夜航", description: "曼恩团队的后卫，夜之城的枪手", personality: "", scenario: "", first_mes: "" },
      { id: "c2", name: "皮拉", description: "夜之城的医生，曼恩团队的医疗支援", personality: "", scenario: "", first_mes: "" }
    ],
    llm,
    budget: 8000,
    maxLoops: 3,
    confidenceRatio: 5,
    confidenceMin: 100
  });
  assert.equal(r.injected, true);
  assert.equal(r.mode, "loop");
  assert.ok(r.evidence && r.evidence.includes("结论"));
  assert.equal(llm.calls, 1, "LLM 应被调 1 次：" + llm.calls);
});

await run("召回失败静默降级（index 为空）", async () => {
  const r = await R.recall({
    input: "随便问点什么",
    characters: [], settings: [], conversations: [],
    enabled: true
  });
  assert.equal(r.injected, false);
  assert.equal(r.mode, "skip");
});

await run("召回失败静默降级（enabled=false）", async () => {
  const r = await R.recall({
    input: "测试",
    characters: SAMPLE_CHARS,
    enabled: false
  });
  assert.equal(r.injected, false);
  assert.equal(r.mode, "skip");
});

await run("召回失败静默降级（input 为空）", async () => {
  const r = await R.recall({
    input: "",
    characters: SAMPLE_CHARS
  });
  assert.equal(r.injected, false);
});

await run("召回失败静默降级（LLM 抛错）", async () => {
  const llm = {
    calls: 0,
    async generate() {
      this.calls++;
      throw new Error("模型超时");
    }
  };
  const r = await R.recall({
    input: "曼恩团队在哪里？",
    characters: SAMPLE_CHARS,
    llm,
    budget: 8000,
    maxLoops: 3,
    confidenceRatio: 5,
    confidenceMin: 100
  });
  assert.ok(
    (r.injected && r.evidence) || (r.injected === false),
    "LLM 抛错时不应报错，应返回注入或降级：" + JSON.stringify(r)
  );
});

await run("isHighConfidence 阈值判定", () => {
  const results = [
    { id: "a", score: 15 },
    { id: "b", score: 6 },
    { id: "c", score: 3 }
  ];
  assert.equal(R.isHighConfidence(results, { threshold: 5, ratio: 2 }), true, "15 vs 6 满足 2x 且过阈值");
  assert.equal(R.isHighConfidence(results, { threshold: 100, ratio: 2 }), false, "15 < 100 阈值不够");
  assert.equal(R.isHighConfidence([{ id: "x", score: 15 }], { threshold: 5, ratio: 2 }), true, "只有一条时次高分按 0");
  assert.equal(R.isHighConfidence([], { threshold: 5, ratio: 2 }), false, "空结果 false");
});

console.log("\n=== 预热召回 · 配置 ===\n");

await run("memory.config：DEFAULTS 加了三格 recall*", () => {
  assert.equal(CFG.DEFAULTS.recallEnabled, true);
  assert.equal(CFG.DEFAULTS.recallBudget, 8000);
  assert.equal(CFG.DEFAULTS.recallMaxLoops, 3);
});

await run("memory.config：norm 回默认值", () => {
  const c = CFG.norm({ recallEnabled: "yes", recallBudget: "abc", recallMaxLoops: null });
  assert.equal(c.recallEnabled, true);
  assert.equal(c.recallBudget, 8000);
  assert.equal(c.recallMaxLoops, 3);
});

await run("memory.config：norm 夹预算上下限", () => {
  assert.equal(CFG.norm({ recallBudget: 100 }).recallBudget, 800, "小于 800 应夹到 800");
  assert.equal(CFG.norm({ recallBudget: 999999 }).recallBudget, 64000, "大于 64000 应夹到 64000");
  assert.equal(CFG.norm({ recallMaxLoops: 0 }).recallMaxLoops, 1, "小于 1 应夹到 1");
  assert.equal(CFG.norm({ recallMaxLoops: 99 }).recallMaxLoops, 10, "大于 10 应夹到 10");
});

await run("memory.config：mergeConfig 支持 recall*", () => {
  const prev = CFG.norm({});
  const merged = CFG.mergeConfig(prev, { recallEnabled: false, recallBudget: 4000 });
  assert.equal(merged.recallEnabled, false);
  assert.equal(merged.recallBudget, 4000);
  assert.equal(merged.recallMaxLoops, 3, "没传的保留默认");
});

await run("memory.config：publicConfig 暴露 recall*", () => {
  const pub = CFG.publicConfig(CFG.norm({ recallEnabled: false, recallBudget: 2000, recallMaxLoops: 2 }));
  assert.equal(pub.recallEnabled, false);
  assert.equal(pub.recallBudget, 2000);
  assert.equal(pub.recallMaxLoops, 2);
  assert.ok(pub.limits.recallBudget);
  assert.ok(pub.limits.recallMaxLoops);
  assert.equal(pub.defaults.recallEnabled, true);
});

await run("memory.config：读写往返一致", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-cfg-"));
  try {
    await CFG.writeConfig(dataDir, { recallEnabled: false, recallBudget: 3000, recallMaxLoops: 2 });
    const read = await CFG.readConfig(dataDir);
    assert.equal(read.recallEnabled, false);
    assert.equal(read.recallBudget, 3000);
    assert.equal(read.recallMaxLoops, 2);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

})();

// ── 汇总 ──────────────────────────────────────────────
console.log(`\n=== 汇总 ===`);
console.log(`  ✅ pass: ${pass}`);
console.log(`  ❌ fail: ${fail}`);
console.log(`  total:  ${pass + fail}`);

if (fail > 0) process.exitCode = 1;
