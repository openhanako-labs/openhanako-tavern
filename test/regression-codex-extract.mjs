// test/regression-codex-extract.mjs — 图鉴抽取（C1-2 二期）回归
//
// 三条验收（对齐 extract-codex.js 的三条红线）：
//   ① 抽出的条目一律 pending + source="extract"，绝不自动转正
//   ② 同一名称已存在（不管 pending 与否）→ 不造重复条目
//   ③ 抽取失败静默（不抛），不影响正文链路；不重试
//
// 加一条：关系抽取的两端名字解析不到 → 丢这条边（宁可少，不编 id）

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { CodexSource } = await import("../lib/codex/model.js");
const { createCodexRepo } = await import("../lib/codex/repo.js");
const { codexExtractPrompt, parseCodexExtract, CODEX_EXTRACT_RULES } = await import("../lib/gen/prompt.js");
const { extractCodexEntities } = await import("../lib/conversations/extract-codex.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.stack || e.message}`); fail++; }
}

async function freshSetup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-extract-"));
  const convsDir = path.join(dataDir, "conversations");
  fs.mkdirSync(convsDir, { recursive: true });
  const convId = "conv-test-1";
  fs.writeFileSync(
    path.join(convsDir, `${convId}.json`),
    JSON.stringify({ id: convId, characterId: "c", messages: [], createdAt: new Date().toISOString() }),
    "utf8"
  );
  return { dataDir, convId };
}

function cleanup(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** 假 LLM：直接把 content 当模型回话。 */
function fakeLlm(content) {
  return {
    available: true,
    generate: async (messages, opts) => ({ content, usage: { prompt_tokens: 10, completion_tokens: 10 } })
  };
}

console.log("\n=== 图鉴抽取（C1-2 二期）===\n");

// ── Prompt 侧 ─────────────────────────────────────────

await okAsync("prompt：三条红线都写进规则文本", () => {
  // 关键红线短语必须出现——漏一条就等于给模型开绿灯
  assert.ok(CODEX_EXTRACT_RULES.includes("只许从给定的正文中提取"), "缺「只许从正文提取」");
  assert.ok(CODEX_EXTRACT_RULES.includes("不许推测"), "缺「不许推测」");
  assert.ok(CODEX_EXTRACT_RULES.includes("已收录"), "缺「已收录名单不要重复」");
  assert.ok(CODEX_EXTRACT_RULES.includes("严格的 JSON 对象"), "缺「严格 JSON 对象」");
  assert.ok(CODEX_EXTRACT_RULES.includes("不要输出任何其他字段"), "缺「不要输出其他字段」");
});

await okAsync("prompt：把已收录名单回填进 user 消息", () => {
  const { systemPrompt, messages } = codexExtractPrompt({
    text: "我走进了皇宫。",
    characterName: "主角",
    existing: {
      persons: ["李玥", "王五"],
      places: ["皇宫"],
      relations: ["李玥 —王五（师徒）"]
    }
  });
  assert.equal(systemPrompt, CODEX_EXTRACT_RULES);
  const userMsg = messages[0].content;
  assert.ok(userMsg.includes("主角"), "缺当前主角");
  assert.ok(userMsg.includes("李玥") && userMsg.includes("王五"), "缺已收录人物");
  assert.ok(userMsg.includes("皇宫"), "缺已收录地点");
  assert.ok(userMsg.includes("皇宫"), "缺已收录关系");
  assert.ok(userMsg.includes("我走进了皇宫"), "缺正文");
});

await okAsync("parse：坏 JSON 抛错", () => {
  assert.throws(() => parseCodexExtract("这不是 JSON"), /不是合法 JSON/);
  assert.throws(() => parseCodexExtract("[]"), /该是对象/);
});

await okAsync("parse：顶层字段只准三个人物 / 地点 / 关系", () => {
  const good = parseCodexExtract(JSON.stringify({ persons: [], places: [], relations: [] }));
  assert.deepEqual(good, { persons: [], places: [], relations: [] });
  // 多一个字段 → 抛错（模型想要「额外发挥」的信号）
  assert.throws(() => parseCodexExtract(JSON.stringify({ persons: [], places: [], relations: [], extra: 1 })), /未允许的字段/);
});

// ── 主流程：抽取 → 落图鉴 ─────────────────────────────

await okAsync("抽取新人物：pending + source=extract", async () => {
  const { dataDir, convId } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  const llm = fakeLlm(JSON.stringify({
    persons: [{ name: "张铁", attitude: "戒备", status: "在外", tags: ["禁军"] }],
    places: [],
    relations: []
  }));
  const r = await extractCodexEntities({
    llm, text: "……张铁拦住了我……", codexRepo: repo, conversationId: convId, characterName: "主角"
  });
  assert.equal(r.ok, true);
  assert.equal(r.created.persons, 1);

  const list = await repo.list("persons", convId);
  assert.equal(list.length, 1);
  const p = list[0];
  assert.equal(p.name, "张铁");
  assert.equal(p.attitude, "戒备");
  assert.equal(p.status, "在外");
  assert.equal(p.pending, true, "必须待确认");
  assert.equal(p.source, CodexSource.EXTRACT, "source 必须是 extract");
  assert.equal(p.lifespan, "chat", "抽出来的候选挂在这场（chat 级）");
  cleanup(dataDir);
});

await okAsync("幂等：同名已存在（pending 与否都算）→ 不重复", async () => {
  const { dataDir, convId } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  // 先建一个已确认（pending=false）
  await repo.create("persons", { name: "李玥", lifespan: "chat", pending: false }, convId);

  const llm = fakeLlm(JSON.stringify({
    persons: [{ name: "李玥", attitude: "疑惑" }, { name: "王五" }],
    places: [], relations: []
  }));
  const r = await extractCodexEntities({
    llm, text: "李玥和王五", codexRepo: repo, conversationId: convId
  });
  assert.equal(r.ok, true);
  assert.equal(r.created.persons, 1, "只新建王五，李玥跳过");

  const list = await repo.list("persons", convId);
  assert.equal(list.length, 2);
  const ly = list.find(x => x.name === "李玥");
  assert.equal(ly.pending, false, "已存在的 pending 状态不被抽取覆盖");
  const wy = list.find(x => x.name === "王五");
  assert.equal(wy.pending, true, "新抽的王五待确认");
  cleanup(dataDir);
});

await okAsync("关系：两端都能解到名字 → 挂上边；任一端解不到 → 丢", async () => {
  const { dataDir, convId } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  // 先放一个已确认的人，供关系引用
  await repo.create("persons", { name: "师父", lifespan: "chat" }, convId);

  const llm = fakeLlm(JSON.stringify({
    persons: [{ name: "弟子" }],
    places: [],
    relations: [
      // 两端都能解到（师父已存在，弟子本轮新建）
      { from: "弟子", to: "师父", kind: "师徒", direction: "directed" },
      // 一端是"神秘人"（既没在正文也没在图鉴）→ 应被丢
      { from: "弟子", to: "神秘人", kind: "仇敌" }
    ]
  }));
  const r = await extractCodexEntities({
    llm, text: "弟子拜了师父……", codexRepo: repo, conversationId: convId
  });
  assert.equal(r.ok, true);
  assert.equal(r.created.relations, 1, "只挂一条能解析的关系");
  assert.equal(r.created.skippedRelations, 1, "另一端解不到的关系被丢");

  const rels = await repo.list("relations", convId);
  assert.equal(rels.length, 1);
  const rel = rels[0];
  assert.equal(rel.kind, "师徒");
  assert.ok(rel.from.startsWith("p_") && rel.to.startsWith("p_"), "关系端点带 p_ 前缀");
  assert.equal(rel.pending, true);
  assert.equal(rel.source, CodexSource.EXTRACT);
  cleanup(dataDir);
});

await okAsync("幂等：同一 (from,to,kind) 关系不重复", async () => {
  const { dataDir, convId } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  await repo.create("persons", { name: "A", lifespan: "chat" }, convId);
  await repo.create("persons", { name: "B", lifespan: "chat" }, convId);

  const payload = JSON.stringify({
    persons: [], places: [],
    relations: [
      { from: "A", to: "B", kind: "朋友" },
      { from: "A", to: "B", kind: "朋友" }   // 重复
    ]
  });
  await extractCodexEntities({
    llm: fakeLlm(payload), text: "A 和 B", codexRepo: repo, conversationId: convId
  });
  const rels = await repo.list("relations", convId);
  assert.equal(rels.length, 1, "同一 (from,to,kind) 关系不重复");
  cleanup(dataDir);
});

await okAsync("静默失败：LLM 回坏 JSON → 不抛，只 warn", async () => {
  const { dataDir, convId } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(" "));
  try {
    const r = await extractCodexEntities({
      llm: fakeLlm("这不是 JSON"),
      text: "任意正文", codexRepo: repo, conversationId: convId
    });
    assert.equal(r.ok, false, "返回 ok:false");
    assert.ok(String(r.why).includes("图鉴抽取不是合法 JSON"), `why 应为 JSON 解析失败：${r.why}`);
    assert.ok(warns.some(s => s.includes("[extract-codex]")), "console.warn 有记录");
  } finally {
    console.warn = origWarn;
  }
  cleanup(dataDir);
});

await okAsync("静默失败：LLM 抛错 → 不抛", async () => {
  const { dataDir, convId } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  const llm = { generate: async () => { throw new Error("网络挂了"); } };
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(" "));
  try {
    const r = await extractCodexEntities({
      llm, text: "任意正文", codexRepo: repo, conversationId: convId
    });
    assert.equal(r.ok, false);
    assert.ok(String(r.why).includes("网络挂了"));
    assert.ok(warns.length >= 1);
  } finally {
    console.warn = origWarn;
  }
  cleanup(dataDir);
});

await okAsync("无 codexRepo → 静默跳过，不抛", async () => {
  const r = await extractCodexEntities({
    llm: fakeLlm("{}"), text: "任意正文", codexRepo: null, conversationId: "x"
  });
  assert.equal(r.skipped, "no codexRepo");
});

await okAsync("空正文 → 静默跳过", async () => {
  const { dataDir, convId } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  const r = await extractCodexEntities({
    llm: fakeLlm("{}"), text: "", codexRepo: repo, conversationId: convId
  });
  assert.equal(r.skipped, "empty text");
  cleanup(dataDir);
});

await okAsync("model：pending 只认真值（字符串/数字都当 false）", async () => {
  const { createPerson, createPlace, createRelation, normalizePerson } = await import("../lib/codex/model.js");
  assert.equal(createPerson({ pending: true }).pending, true);
  assert.equal(createPerson({ pending: "true" }).pending, false, "字符串 true 不算");
  assert.equal(createPerson({ pending: 1 }).pending, false, "数字 1 不算");
  assert.equal(createPerson().pending, false, "默认 false");
  assert.equal(createPlace({ pending: true }).pending, true);
  assert.equal(createRelation({ pending: true }).pending, true);
  // 老数据没有 pending 字段 → 默认 false
  assert.equal(normalizePerson({ id: "x", name: "A" }).pending, false);
});

// ── 汇总 ──────────────────────────────────────────────

console.log(`\n${pass + fail === 0 ? "无" : ""}通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
