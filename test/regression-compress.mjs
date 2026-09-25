// test/regression-compress.mjs — 长对话折叠：真的丢了吗 / 摘要真的进 prompt 了吗 / 真的落盘了吗
//
// 为什么要有它：压缩这条路**建得很早、很讲究**（滑窗、增量合并、前缀断点标记），
// 但它一直**没有自己的测试**——也就没人知道它在真对话上到底跑不跑。
// 而它有个要命的性质：坏了也不会报错，只会"模型忽然不记得前面发生过什么"。
//
// 三件事必须分开验（今天已经栽过几次"我以为"）：
//   ① 短对话**不许**折叠（不然每轮都白丢东西）
//   ② 长对话**必须**折叠，且摘要是**真的进 prompt**（不是只在 meta 里算了一下）
//   ③ 摘要要**真的落盘**（走一遍路由），否则下一轮又从头算

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { makeApp, request } = await import("./lib/route-harness.mjs");
const { ConversationRepo } = await import("../lib/conversations/repo.js");
const { CharacterRepo } = await import("../lib/characters/repo.js");
const { SettingRepo } = await import("../lib/settings/repo.js");
const { registerConversationRoutes } = await import("../lib/conversations/routes.js");
const { buildGenerationInput } = await import("../lib/conversations/pipeline.js");
const { estimateTokens } = await import("../lib/llm/history.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 长对话折叠 ===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-cmp-"));
const charRepo = new CharacterRepo(tmp); await charRepo.init();
const convRepo = new ConversationRepo(tmp); await convRepo.init();
const setRepo = new SettingRepo(tmp); await setRepo.init();

const character = await charRepo.create({
  name: "薇拉", description: "守夜法师，话少", first_mes: "「又是你。」"
});

const repos = { settingRepo: setRepo, regexRepo: null, conversationRepo: convRepo, characterRepo: charRepo, boardRepo: null };
const OPT = { contextWindow: 8000, maxTokens: 1000 }; // → 历史预算 4900 token

// ── ① 短对话：不许折叠 ────────────────────────────────
const short = await convRepo.create(character.id);
await convRepo.addMessage(short.id, "user", "你在守什么？");
await convRepo.addMessage(short.id, "assistant", "「守着别让人上来。」");

await okAsync("短对话：不折叠，且账里写明**为什么不折**", async () => {
  const conv = await convRepo.get(short.id);
  const r = await buildGenerationInput(repos, conv, character, "继续", OPT);

  assert.strictEqual(r.meta.pressure.folded, false, "短对话不该折叠");
  assert.strictEqual(r.meta.pressure.dropped, 0, `不该丢消息，丢了 ${r.meta.pressure.dropped} 条`);
  assert.ok(
    !r.messages.some(m => String(m.content).includes("[前情提要]")),
    "不该出现前情提要"
  );
  assert.ok(
    !r.messages.some(m => m._prefixBroken),
    "没折叠就不该标前缀断点（标了会白砸缓存）"
  );
  const om = (r.audit.omitted || []).find(o => o.kind === "summary");
  assert.ok(om, `账里应当有一笔 summary 的“没进来”，实际 omitted=${JSON.stringify(r.audit.omitted)}`);
  assert.ok(/阈值|不需要/.test(om.reason), `理由要写清楚，实际是：${om.reason}`);
});

// ── ② 长对话：必须折叠，且摘要真的进 prompt ──────────────
const long = await convRepo.create(character.id);
for (let i = 0; i < 40; i++) {
  await convRepo.addMessage(long.id, "user", `第 ${i + 1} 句：${"雪落下来的时候她在塔顶站着，风里全是冰屑的味道，我问她冷不冷，她没回头，只说这个时辰山上不该有人。".repeat(2)}`);
  await convRepo.addMessage(long.id, "assistant", `第 ${i + 1} 答：${"「冷是给活着的人准备的。」她把霜从袖口抖下去，指尖的裂口里透出一点白，像灯快要灭了又勉强亮起来。".repeat(2)}`);
}

let longBuilt = null;
await okAsync("长对话：折叠发生，条数与读数都摆在账上", async () => {
  const conv = await convRepo.get(long.id);
  longBuilt = await buildGenerationInput(repos, conv, character, "继续", OPT);

  const p = longBuilt.meta.pressure;
  assert.strictEqual(p.folded, true, "长对话必须折叠");
  assert.ok(p.dropped > 0, `应当丢了若干条，实际 ${p.dropped}`);
  assert.ok(p.parts.history <= p.historyBudget, `历史段 ${p.parts.history} 超了预算 ${p.historyBudget}`);
});

await okAsync("摘要**真的在 prompt 里**（不只是 meta 里算了一下）", () => {
  const r = longBuilt;
  const first = r.messages[0];
  assert.strictEqual(first.role, "user");
  assert.ok(String(first.content).startsWith("[前情提要]"), `第一条不是前情提要：${String(first.content).slice(0, 60)}`);
  assert.ok(/已折叠/.test(first.content), `摘要里该写清折了几条：${String(first.content).slice(0, 120)}`);
  assert.ok(r.meta.summaryAttached === true, "meta 也要说清这一轮带了摘要");
});

await okAsync("折叠了就要标前缀断点（保留的消息前面接的已经不是原来那段）", () => {
  const kept = longBuilt.messages.filter(m => !String(m.content).startsWith("[前情提要]"));
  assert.ok(kept.length > 0, "总得留下点消息");
  assert.ok(kept.every(m => m._prefixBroken === true), "留下的消息都应带前缀断点标记");
});

// ── ③ 增量：第二轮不该从头再压一遍 ─────────────────────
await okAsync("第二轮：旧摘要在、折叠数没变 → 复用（不再重算），且读数不说谎", async () => {
  const patch = longBuilt.meta.summaryPatch;
  assert.ok(patch?.text, "管线应当给出摘要建议值");
  await convRepo.update(long.id, { summary: patch });

  const conv = await convRepo.get(long.id);
  const again = await buildGenerationInput(repos, conv, character, "继续", OPT);

  const first0 = String(longBuilt.messages[0].content);
  const again0 = String(again.messages[0].content);
  assert.strictEqual(again0, first0, "折叠范围没变时，摘要应当逐字相同（复用，而不是重压一遍）");

  /*
   * `summaryReused` 这个读数原先写成 `coveredCount > 0` —— **恒真**：
   * 第一轮刚刚算出来的摘要，它也会报"复用了"。这不是读数，是装饰。
   * 真含义应当是"旧摘要已经盖住了这次要折的全部"，才叫复用。
   */
  assert.strictEqual(
    again.meta.summaryReused, true,
    "第二轮确实是复用（旧摘要已覆盖），这个读数该为真"
  );
});

await okAsync("第一次折叠时 summaryReused 必须为 false（原先是恒真，属于假读数）", async () => {
  const conv2 = await convRepo.create(character.id);
  for (let i = 0; i < 40; i++) {
    await convRepo.addMessage(conv2.id, "user", `第 ${i + 1} 句：${"塔顶的结界在响。".repeat(20)}`);
    await convRepo.addMessage(conv2.id, "assistant", `第 ${i + 1} 答：${"她把霜从袖口抖下去。".repeat(20)}`);
  }
  const r = await buildGenerationInput(repos, await convRepo.get(conv2.id), character, "继续", OPT);
  assert.strictEqual(r.meta.pressure.folded, true, "这份也该折叠");
  assert.strictEqual(
    r.meta.summaryReused, false,
    "旧摘要都不存在，凭什么说“复用”"
  );
});

// ── ④ 落盘：走一遍路由，摘要要真写进对话文件 ───────────
await okAsync("路由：生成一轮之后，摘要在对话里（下一轮才有得复用）", async () => {
  const app = makeApp();
  const llm = {
    available: true,
    lastTarget: { model: "cmp-stub" },
    resolveContextWindow: async () => 8000,
    generate: async () => ({ content: "「山上不该有人。」", usage: {}, target: { model: "cmp-stub" } })
  };
  registerConversationRoutes(app, convRepo, llm, charRepo, setRepo, null, null, null);

  const r = await request(app, "POST", `/conversations/${long.id}/messages`, { body: { content: "再说一句话" } });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);

  // 落盘是 fire-and-forget：给它一点时间，然后核对
  let saved = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((res) => setTimeout(res, 50));
    saved = (await convRepo.get(long.id))?.summary;
    if (saved?.text) break;
  }
  assert.ok(saved?.text, "摘要没落盘——下一轮又得从头压一遍");
  assert.ok(saved.coveredCount > 0, `coveredCount 该是正数：${JSON.stringify(saved)}`);
});

// ── ⑤ 前情提要：读 / 改 / 清 ─────────────────────────
//
// 这一节的存在理由：“哪一段不重要”是**价值判断**，不该只由机器做。
// 界面上给它一个能读、能改、能清的家，就得有路由担着，
// 而且两条约定要钉住：手改不动覆盖范围、清掉不动消息。

const sumApp = makeApp();
registerConversationRoutes(sumApp, convRepo, { available: true, generate: async () => ({ content: "x" }) }, charRepo, setRepo, null, null, null);

await okAsync("路由：读得到前情提要", async () => {
  const r = await request(sumApp, "GET", `/conversations/${long.id}/summary`);
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.ok(r.data.summary?.text, "上一轮已落盘，这里该读得到");
});

await okAsync("路由：手改**不动 coveredCount**（改的是“怎么写”，不是“盖到哪”）", async () => {
  const before = (await convRepo.get(long.id)).summary;
  const r = await request(sumApp, "PUT", `/conversations/${long.id}/summary`, {
    body: { text: "我手写的一份前情提要：她在塔顶守了三夜。" }
  });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.summary.text, "我手写的一份前情提要：她在塔顶守了三夜。");
  assert.strictEqual(
    r.data.summary.coveredCount, before.coveredCount,
    "覆盖范围被手改重置了——下一轮会把同一段再压一遍、追加在后面"
  );
  assert.ok(r.data.summary.editedAt, "该留下改过的时间");
});

await okAsync("手改之后：下一轮直接用它，不重算", async () => {
  const conv = await convRepo.get(long.id);
  const r = await buildGenerationInput(repos, conv, character, "继续", OPT);
  assert.ok(
    String(r.messages[0].content).includes("我手写的一份前情提要：她在塔顶守了三夜。"),
    "手写的摘要该原样进 prompt"
  );
  assert.strictEqual(r.meta.summaryReused, true, "覆盖范围没变 → 该说复用");
});

await okAsync("清掉：摘要没了，但**消息一条不少**", async () => {
  const before = (await convRepo.get(long.id)).messages.length;
  const r = await request(sumApp, "PUT", `/conversations/${long.id}/summary`, { body: { text: null } });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.cleared, true);
  const conv = await convRepo.get(long.id);
  assert.ok(!conv.summary, "该清掉");
  assert.strictEqual(conv.messages.length, before, "清摘要不该动消息（折叠本来就是算出来的，不是删出来的）");
});

await okAsync("清掉之后：下一轮重新压一遍（不是从此就不折了）", async () => {
  const conv = await convRepo.get(long.id);
  const r = await buildGenerationInput(repos, conv, character, "继续", OPT);
  assert.strictEqual(r.meta.pressure.folded, true, "该重新折叠");
  assert.ok(r.meta.summaryPatch?.text, "该给出新的摘要建议值");
  assert.strictEqual(r.meta.summaryReused, false, "这次是从头压的，不该说复用");
});

// ── ⑥ 模型写的摘要（手动触发的那一次调用） ──────────────
//
// 这一节验的是：提示词真拦住了三件事（新增 / 对话口吻 / 长度），
// 清洗容错但也真会空手，而且**模型看到的确实是那批要被折掉的历史**。

const { buildSummaryInput, parseSummary, SUMMARY_MAX_CHARS } = await import("../lib/conversations/summary-llm.js");
const { mergeSummary } = await import("../lib/llm/history.js");

await okAsync("提示词：三条约束都在（不许新增 / 不许对话口吻 / 长度上限）", () => {
  const input = buildSummaryInput({ name: "薇拉" }, [{ role: "user", content: "你在守什么？" }]);
  const p = input.systemPrompt;
  assert.ok(/不许新增/.test(p), "没有“只许压缩不许新增”——模型会顺手编事件");
  assert.ok(/不要写成对话/.test(p), "没有拦住对话口吻——它会被放在 prompt 最前面，写成“我们继续”就是一句用户指令");
  assert.ok(new RegExp(String(SUMMARY_MAX_CHARS)).test(p), `提示词里该写清长度上限 ${SUMMARY_MAX_CHARS}`);
  assert.ok(/薇拉/.test(p), "该告诉它是哪个角色");
  assert.strictEqual(input.messages.length, 1, "被折的那批要**合并成一条** user 消息——拆多轮模型会顺着往下写");
});

await okAsync("提示词：被折的内容真在里面", () => {
  const rows = [
    { role: "user", content: "塔顶的结界在响" },
    { role: "assistant", content: "她把霜从袖口抖下去" }
  ];
  const input = buildSummaryInput(null, rows);
  assert.strictEqual(input.count, 2);
  assert.ok(input.messages[0].content.includes("塔顶的结界在响"));
  assert.ok(input.messages[0].content.includes("她把霜从袖口抖下去"));
});

await okAsync("清洗：围栏 / 引号 / 寒暄 / 标签都去掉", () => {
  assert.strictEqual(parseSummary("```\n她在塔顶守了三夜。\n```").text, "她在塔顶守了三夜。");
  assert.strictEqual(parseSummary("「她在塔顶守了三夜。」").text, "她在塔顶守了三夜。");
  assert.strictEqual(parseSummary("好的，她在塔顶守了三夜。").text, "她在塔顶守了三夜。");
  assert.strictEqual(parseSummary("前情提要：她在塔顶守了三夜。").text, "她在塔顶守了三夜。");
});

await okAsync("清洗：空手就空手（不把“好的”存成摘要）", () => {
  for (const empty of ["", "   ", "```\n```", "好的，"]) {
    const r = parseSummary(empty);
    assert.strictEqual(r.text, null, `“${empty}”不该被当成摘要`);
    assert.ok(r.why, "空手要带一句为什么");
  }
});

await okAsync("清洗：超长要截到上限并且看得出来被截了", () => {
  const r = parseSummary("很长".repeat(600), { maxChars: 50 });
  assert.ok(r.text.length <= 51, `实际 ${r.text.length}`);
  assert.ok(r.text.endsWith("…"), "截了要留个记号");
});

await okAsync("情形 0：模型写的摘要 + 又多折了几条 → 保持原样、只推覆盖范围（不拼机械骨架）", () => {
  const prev = { text: "她在塔顶守了三夜。", coveredCount: 10, byModel: true };
  const rows = Array.from({ length: 14 }, (_, i) => ({ role: "user", content: `第${i}句` }));
  const merged = mergeSummary(prev, rows);
  assert.strictEqual(merged.text, "她在塔顶守了三夜。", "不该往模型写的叙述后面拼“起点：…”“涉及角色：…”那类标签");
  assert.strictEqual(merged.coveredCount, 14, "覆盖范围要推到新的折叠数");
  assert.strictEqual(merged.byModel, true);
});

await okAsync("路由：真调一次模型，并把**它看到的那批历史**核一遍", async () => {
  const seen = [];
  const app2 = makeApp();
  const llm2 = {
    available: true,
    lastTarget: { model: "sum-stub" },
    resolveContextWindow: async () => 8000,
    generate: async (messages, options) => {
      seen.push({ messages, options });
      return { content: "```\n她在塔顶守了三夜，霜结在袖口上。\n```", usage: { total_tokens: 321 }, target: { model: "sum-stub" } };
    }
  };
  registerConversationRoutes(app2, convRepo, llm2, charRepo, setRepo, null, null, null);

  const r = await request(app2, "POST", `/conversations/${long.id}/summary/summarize`, { body: {} });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.ok, true);
  assert.ok(r.data.folded > 0, `该说清压了几条：${JSON.stringify(r.data)}`);
  assert.strictEqual(r.data.summary.text, "她在塔顶守了三夜，霜结在袖口上。", "围栏要被清掉");
  assert.strictEqual(r.data.summary.byModel, true, "要标明这是模型写的");
  assert.strictEqual(r.data.summary.coveredCount, r.data.folded);
  assert.strictEqual(r.data.usage.total_tokens, 321, "用量要回传，成本要看得见");

  assert.strictEqual(seen.length, 1, "应当只调用一次模型");
  assert.ok(/不许新增/.test(seen[0].options.systemPrompt), "带的是压缩器的系统提示");
  assert.ok(
    String(seen[0].messages[0].content).includes("第 1 句"),
    "模型看到的该是最早那批要被折掉的历史"
  );

  const conv = await convRepo.get(long.id);
  assert.strictEqual(conv.summary.byModel, true, "要真落盘");
});

await okAsync("路由：没有可折的就**不假装成功**（直说还没到折叠的地方）", async () => {
  const app3 = makeApp();
  const llm3 = {
    available: true,
    generate: async () => { throw new Error("不该被调用"); },
    resolveContextWindow: async () => 8000
  };
  registerConversationRoutes(app3, convRepo, llm3, charRepo, setRepo, null, null, null);

  const r = await request(app3, "POST", `/conversations/${short.id}/summary/summarize`, { body: {} });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.ok, false);
  assert.ok(/折叠/.test(r.data.reason), `理由要说人话：${r.data.reason}`);
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
