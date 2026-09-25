// test/regression-group.mjs — 群聊地基：参与者 / 名册进前缀 / 谁在说话进尾部
//
// 这一层只有一个设计决定要守住：
//   **名册（有哪些人）是稳定的 → 进稳定前缀；
//     这一轮谁在说话（每轮都变）→ 进动态尾部。**
// 混在一起的话，每换一个发言者就砸一次前缀缓存，而且是静默的
// （没人报错，只会发现命中率莫名很低）。
//
// 第二件要守的：**单角色路径逐字节不变**。
// 给一个新功能加料的同时把主路径的缓存悄悄搞坏，是这一场最不想犯的错。

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { makeApp, request } = await import("./lib/route-harness.mjs");
const { ConversationRepo } = await import("../lib/conversations/repo.js");
const { CharacterRepo } = await import("../lib/characters/repo.js");
const { SettingRepo } = await import("../lib/settings/repo.js");
const { registerConversationRoutes } = await import("../lib/conversations/routes.js");
const { buildGenerationInput, resetPrefixWatch, renderCastRoster } = await import("../lib/conversations/pipeline.js");
const { participantsOf, visibleMessagesFor } = await import("../lib/conversations/model.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 群聊地基 ===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-grp-"));
const charRepo = new CharacterRepo(tmp); await charRepo.init();
const convRepo = new ConversationRepo(tmp); await convRepo.init();
const setRepo = new SettingRepo(tmp); await setRepo.init();

const vera = await charRepo.create({ name: "薇拉", description: "守夜法师，话少", first_mes: "「又是你。」" });
const ren = await charRepo.create({ name: "任十九", description: "山下杂货铺的老板娘，什么都听得到", first_mes: "「山上的风变了。」" });
const solo = await charRepo.create({ name: "独行客", description: "一个人", first_mes: "「就我一个。」" });

const repos = { settingRepo: setRepo, regexRepo: null, conversationRepo: convRepo, characterRepo: charRepo, boardRepo: null };
const OPT = { contextWindow: 32000, maxTokens: 1000 };

// ── ① 参与者读侧要能兜旧数据 ──────────────────────────
await okAsync("participantsOf：旧对话（只有 characterId）也读得出参与者", () => {
  assert.deepStrictEqual(participantsOf({ characterId: "a" }), ["a"], "旧对话文件里没有 characterIds，读侧必须兜");
  assert.deepStrictEqual(participantsOf({ characterId: "a", characterIds: ["a", "b"] }), ["a", "b"]);
  assert.deepStrictEqual(participantsOf({}), []);
  assert.deepStrictEqual(participantsOf(null), []);
});

// ── ② 建一场群聊 ────────────────────────────────────
await okAsync("路由：建群聊（两个角色）——第一位是主角；两人的开场白都种下、都带署名", async () => {
  const app = makeApp();
  registerConversationRoutes(app, convRepo, { available: true, generate: async () => ({ content: "x" }) }, charRepo, setRepo, null, null, null);

  const r = await request(app, "POST", "/conversations", { body: { characterIds: [vera.id, ren.id] } });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.characterId, vera.id, "主角 = 第一个");
  assert.deepStrictEqual(r.data.characterIds, [vera.id, ren.id]);
  assert.strictEqual(r.data.characterName, "薇拉", "列表用的角色名该是主角的");
  assert.strictEqual(r.data.messages.length, 2, `两位参与者的开场白都该种下，实际 ${r.data.messages.length} 条`);
  assert.deepStrictEqual(r.data.messages.map(m => m.role), ["assistant", "assistant"]);
  assert.deepStrictEqual(r.data.messages.map(m => m.speakerId), [vera.id, ren.id], "各条要署各自的名");
  assert.ok(r.data.messages[0].content.trim() && r.data.messages[1].content.trim(), "正文不该是空的");
});

// ── ②b 署名规则：单人省、多人写 ──────────────────────
// 旧行为是「speakerId === 主角就不写」。单人对话里这条对（信息多余），
// 但套到群聊上，主角的话就变成无主气泡——界面上看着像旁白。
// （group-ui 探针：“我 | 角色(薇拉·霜语) | 角色”，最后那个就是主角。）
await okAsync("群聊里主角发言也要署名（单人那条“多余”的规则不能套到多人身上）", async () => {
  const app = makeApp();
  registerConversationRoutes(app, convRepo, { available: true, generate: async () => ({ content: "x" }) }, charRepo, setRepo, null, null, null);

  const r = await request(app, "POST", "/conversations", { body: { characterIds: [vera.id, ren.id], greeting: false } });
  const sent = await request(app, "POST", `/conversations/${r.data.id}/messages`, {
    body: { content: "谁在？", speakerId: vera.id }
  });
  assert.strictEqual(sent.status, 200, `状态 ${sent.status}：${sent.error || ""}`);
  assert.strictEqual(sent.data.assistantMessage?.speakerId, vera.id, "主角在群聊里也要署名");
});

await okAsync("开场白在**落盘时**结算一次性宏（屏幕与 prompt 不能各说各话）", async () => {
  const dmg = await charRepo.create({
    name: "掷骰者", description: "开场白里有骰子", first_mes: "我掷了 {{roll 1d100}}。"
  });
  const app = makeApp();
  registerConversationRoutes(app, convRepo, { available: true, generate: async () => ({ content: "x" }) }, charRepo, setRepo, null, null, null);

  const r = await request(app, "POST", "/conversations", { body: { characterId: dmg.id } });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  const content = r.data.messages?.[0]?.content || "";
  assert.ok(content.length > 0, "开场白该已经种下");
  assert.ok(!content.includes("{{"), `落盘的开场白还带着宏：${content}`);
});

// ── ③ 改参与者：加人 / 减人 / 换主角 ────────────────────
function groupApp() {
  const app = makeApp();
  registerConversationRoutes(app, convRepo, { available: true, generate: async () => ({ content: "x" }) }, charRepo, setRepo, null, null, null);
  return app;
}

await okAsync("加第三个人：名单变 3，且名册真的跟着变", async () => {
  const third = await charRepo.create({ name: "阿石", description: "塔下的石匠", first_mes: "「石头记得。」" });
  const app = groupApp();
  const made = await request(app, "POST", "/conversations", { body: { characterIds: [vera.id, ren.id], greeting: false } });

  const r = await request(app, "PATCH", `/conversations/${made.data.id}/participants`, {
    body: { characterIds: [vera.id, ren.id, third.id] }
  });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.deepStrictEqual(r.data.characterIds, [vera.id, ren.id, third.id]);
  assert.strictEqual(r.data.characterId, vera.id, "没换主角就不该动他");
  assert.deepStrictEqual(participantsOf(r.data), [vera.id, ren.id, third.id]);
});

await okAsync("减到剩一位：真的变回单人（同场名册从 prompt 里消失）", async () => {
  const app = groupApp();
  const made = await request(app, "POST", "/conversations", { body: { characterIds: [vera.id, ren.id], greeting: false } });

  const r = await request(app, "PATCH", `/conversations/${made.data.id}/participants`, {
    body: { characterIds: [vera.id] }
  });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.deepStrictEqual(r.data.characterIds, [vera.id]);

  // 这一步才是真的：“名单里只剩一个”与“走单人路径”必须是同一件事。
  await convRepo.addMessage(made.data.id, "user", "就你一个？");
  const conv = await convRepo.get(made.data.id);
  const out = await buildGenerationInput(repos, conv, vera, "嗯", OPT);
  assert.ok(!out.systemPrompt.includes("## 同场角色"), "只剩一位了，不该还有同场名册");
  assert.ok(!out.systemPrompt.includes("## 本轮发言者"), "只剩一位了，不该还有本轮发言者");
});

await okAsync("主角不在新名单里 → **报错说清**，不安静换人", async () => {
  const app = groupApp();
  const made = await request(app, "POST", "/conversations", { body: { characterIds: [vera.id, ren.id], greeting: false } });

  const r = await request(app, "PATCH", `/conversations/${made.data.id}/participants`, {
    body: { characterIds: [ren.id] }
  });
  assert.ok(r.status >= 400, `该报错，实际 ${r.status}`);
  assert.ok(/主角.*不在新名单/.test(r.error || ""), `报错要说清：${r.error}`);
  assert.ok((r.error || "").includes(ren.id), "该把可选的新主角列出来");
});

await okAsync("显式指定新主角：换了人，列表用的名字也跟着换", async () => {
  const app = groupApp();
  const made = await request(app, "POST", "/conversations", { body: { characterIds: [vera.id, ren.id], greeting: false } });

  const r = await request(app, "PATCH", `/conversations/${made.data.id}/participants`, {
    body: { characterIds: [ren.id, vera.id], characterId: ren.id }
  });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.characterId, ren.id);
  assert.strictEqual(r.data.characterName, "任十九", "列表里显示的名字该是主角的");
});

await okAsync("名单里混进不存在的角色 → 说清是哪一个", async () => {
  const app = groupApp();
  const made = await request(app, "POST", "/conversations", { body: { characterIds: [vera.id, ren.id], greeting: false } });
  const r = await request(app, "PATCH", `/conversations/${made.data.id}/participants`, {
    body: { characterIds: [vera.id, "没有这个 id"] }
  });
  assert.ok(r.status >= 400, `该报错，实际 ${r.status}`);
  assert.ok(/角色不存在/.test(r.error || ""), `报错要说清：${r.error}`);
});

await okAsync("空名单 → 报错（一场没法说话的对话没有意义）", async () => {
  const app = groupApp();
  const made = await request(app, "POST", "/conversations", { body: { characterIds: [vera.id, ren.id], greeting: false } });
  const r = await request(app, "PATCH", `/conversations/${made.data.id}/participants`, { body: { characterIds: [] } });
  assert.ok(r.status >= 400, `该报错，实际 ${r.status}`);
  assert.ok(/至少留一位/.test(r.error || ""), `报错要说清：${r.error}`);
});

await okAsync("改名单不动历史：已有消息的署名一条不变", async () => {
  const app = groupApp();
  const made = await request(app, "POST", "/conversations", { body: { characterIds: [vera.id, ren.id] } });
  const before = (made.data.messages || []).map(m => `${m.id}:${m.speakerId}`).join("|");
  assert.ok(before.length > 0, "这场开场白该已经种下");

  const r = await request(app, "PATCH", `/conversations/${made.data.id}/participants`, {
    body: { characterIds: [vera.id, ren.id, solo.id] }
  });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  const after = (r.data.messages || []).map(m => `${m.id}:${m.speakerId}`).join("|");
  assert.strictEqual(after, before, "改参与者把历史消息改了");
  assert.strictEqual(r.data.messages.length, 2, "新加的人不该被补种开场白");
});

// ── ⑤ 私语：只给该听的人听 ────────────────────
await okAsync("可见性：没标签的公开 / 空数组谁都看不到 / 指定了才给（fail closed）", () => {
  const conv = {
    messages: [
      { role: "user", content: "公开的" },
      { role: "user", content: "给十九的", audience: [ren.id] },
      { role: "user", content: "谁都不给", audience: [] }
    ]
  };
  assert.deepStrictEqual(visibleMessagesFor(conv, vera.id).map(m => m.content), ["公开的"], "薇拉不该看到给十九的");
  assert.deepStrictEqual(visibleMessagesFor(conv, ren.id).map(m => m.content), ["公开的", "给十九的"]);
  assert.deepStrictEqual(visibleMessagesFor(conv, null).map(m => m.content), ["公开的"], "没有发言人时私语一律不给");
});

await okAsync("生成时按发言人过滤：私语进得了该听的人、进不了别人", async () => {
  const conv = await convRepo.create(vera.id, { characterIds: [vera.id, ren.id] });
  await convRepo.addMessage(conv.id, "user", "大家都听得到的。");
  await convRepo.addMessage(conv.id, "user", "只跟十九说的话。", { audience: [ren.id] });

  const fresh = await convRepo.get(conv.id);
  const forVera = await buildGenerationInput(repos, fresh, vera, "嗯", { ...OPT, speakerId: vera.id });
  const forRen = await buildGenerationInput(repos, fresh, ren, "嗯", { ...OPT, speakerId: ren.id });
  const dump = (r) => `${r.systemPrompt}\n${(r.messages || []).map(m => m.content).join("\n")}`;

  assert.ok(!dump(forVera).includes("只跟十九说的话"), "薇拉的 prompt 里出现了给别人的私语");
  assert.ok(dump(forRen).includes("只跟十九说的话"), "十九该听得到那条私语");
});

await okAsync("私语**永不进共享摘要**（摘要是所有人共用的一份）", async () => {
  const { prepareHistory } = await import("../lib/llm/history.js");
  const messages = [
    { role: "user", content: "很久以前的一句普通话。".repeat(40) },
    { role: "user", content: "很久以前的私语：『别告诉别人』。".repeat(40), audience: [ren.id] },
    { role: "user", content: "最近的一句。".repeat(40) }
  ];
  const r = prepareHistory(messages, { maxTokens: 400, summarize: true, keepRecent: 1, summaryFilter: (m) => !m.audience });
  assert.ok(r.dropped > 0, "这个预算下该有东西被折");
  const text = r.summaryRecord?.text || "";
  assert.ok(!text.includes("别告诉别人"), `私语漏进摘要了：${text.slice(0, 120)}`);
});

await okAsync("路由：私语对象必须是这一场的人（不在就报错说清）", async () => {
  const app = groupApp();
  const made = await request(app, "POST", "/conversations", { body: { characterIds: [vera.id, ren.id], greeting: false } });
  const bad = await request(app, "POST", `/conversations/${made.data.id}/messages`, {
    body: { content: "喂", audience: [solo.id] }
  });
  assert.ok(bad.status >= 400, `该报错，实际 ${bad.status}`);
  assert.ok(/私语对象不在这一场/.test(bad.error || ""), `报错要说清：${bad.error}`);
});

// ── ⑥ 自动轮换：存在**对话**上，不是全局设置 ──────────
await okAsync("新对话默认不自动轮换", async () => {
  const app = groupApp();
  const made = await request(app, "POST", "/conversations", { body: { characterIds: [vera.id, ren.id], greeting: false } });
  assert.strictEqual(made.data.autoRotate, false);
});

await okAsync("改这一场的轮换开关：存得住", async () => {
  const app = groupApp();
  const made = await request(app, "POST", "/conversations", { body: { characterIds: [vera.id, ren.id], greeting: false } });

  const on = await request(app, "PUT", `/conversations/${made.data.id}/rotation`, { body: { autoRotate: true } });
  assert.strictEqual(on.status, 200, `状态 ${on.status}：${on.error || ""}`);
  assert.strictEqual(on.data.autoRotate, true);

  // 真的落了盘（不是只回了一个改过的对象）
  const back = await request(app, "GET", `/conversations/${made.data.id}`);
  assert.strictEqual(back.data.autoRotate, true);

  const off = await request(app, "PUT", `/conversations/${made.data.id}/rotation`, { body: { autoRotate: false } });
  assert.strictEqual(off.data.autoRotate, false);
});

await okAsync("轮换开关只收布尔值（不安静地把「yes」当成开）", async () => {
  const app = groupApp();
  const made = await request(app, "POST", "/conversations", { body: { characterIds: [vera.id, ren.id], greeting: false } });
  const r = await request(app, "PUT", `/conversations/${made.data.id}/rotation`, { body: { autoRotate: "yes" } });
  assert.ok(r.status >= 400, `该报错，实际 ${r.status}`);
  assert.ok(/必须是布尔值/.test(r.error || ""), `报错要说清：${r.error}`);
});

await okAsync("开一场不会影响另一场（这一场是场景属性）", async () => {
  const app = groupApp();
  const a = await request(app, "POST", "/conversations", { body: { characterIds: [vera.id, ren.id], greeting: false } });
  const b = await request(app, "POST", "/conversations", { body: { characterIds: [vera.id, ren.id], greeting: false } });
  await request(app, "PUT", `/conversations/${a.data.id}/rotation`, { body: { autoRotate: true } });

  const backB = await request(app, "GET", `/conversations/${b.data.id}`);
  assert.strictEqual(backB.data.autoRotate, false, "改一场把另一场也改了——那就退回了全局设置");
});

await okAsync("单人对话里同一个 id 仍然不写署名（与以前逐字节一致）", async () => {
  const app = makeApp();
  registerConversationRoutes(app, convRepo, { available: true, generate: async () => ({ content: "x" }) }, charRepo, setRepo, null, null, null);

  const r = await request(app, "POST", "/conversations", { body: { characterId: solo.id, greeting: false } });
  const sent = await request(app, "POST", `/conversations/${r.data.id}/messages`, {
    body: { content: "在吗", speakerId: solo.id }
  });
  assert.strictEqual(sent.status, 200, `状态 ${sent.status}：${sent.error || ""}`);
  assert.ok(!sent.data.assistantMessage?.speakerId, `单人对话不该写署名，实际 ${sent.data.assistantMessage?.speakerId}`);
});

await okAsync("路由：某个角色不存在 → 报错说清是哪一个（不自作主张用空名）", async () => {
  const app = makeApp();
  registerConversationRoutes(app, convRepo, { available: true, generate: async () => ({ content: "x" }) }, charRepo, setRepo, null, null, null);
  const r = await request(app, "POST", "/conversations", { body: { characterIds: [vera.id, "没有这个 id"] } });
  assert.ok(r.status >= 400, `该报错，实际 ${r.status}`);
  assert.ok(/角色不存在/.test(r.error || ""), `报错要说清：${r.error}`);
});

// ── ③ 单角色：逐字节不变 ─────────────────────────────
await okAsync("**单角色路径不变**：没有名册、没有发言者块，账里写明为什么没有", async () => {
  resetPrefixWatch();
  const conv = await convRepo.create(solo.id);
  await convRepo.addMessage(conv.id, "user", "你一个人？");

  const r = await buildGenerationInput(repos, await convRepo.get(conv.id), solo, "嗯", OPT);
  const all = r.systemPrompt;
  assert.ok(!all.includes("## 同场角色"), "单角色不该出现同场名册");
  assert.ok(!all.includes("## 本轮发言者"), "单角色不该出现“本轮发言者”");

  const kinds = (r.audit.omitted || []).filter(o => o.kind === "cast" || o.kind === "turn");
  assert.strictEqual(kinds.length, 2, `账里该各有两笔“没进来”：${JSON.stringify(r.audit.omitted)}`);
  assert.ok(kinds.every(o => o.reason.includes("只有一位")), `理由是“只有一位角色”：${JSON.stringify(kinds)}`);
});

// ── ④ 群聊：名册在，发言者在，且顺序对 ─────────────────
await okAsync("群聊：名册列出两位 + 本轮发言者写明；名册在**前**、发言者块在**后**", async () => {
  resetPrefixWatch();
  const conv = await convRepo.create(vera.id, { characterIds: [vera.id, ren.id] });
  await convRepo.addMessage(conv.id, "user", "你们两个都在？");

  const r = await buildGenerationInput(repos, await convRepo.get(conv.id), vera, "嗯", OPT);
  const s = r.systemPrompt;
  assert.ok(s.includes("## 同场角色"), "该有同场名册");
  assert.ok(s.includes("薇拉") && s.includes("任十九"), "名册要把两位都写上");
  assert.ok(s.includes("## 本轮发言者"), "该写明这一轮谁说话");
  const turnAt = s.indexOf("## 本轮发言者");
  assert.ok(s.slice(turnAt).includes("薇拉"), `本轮发言者该是薇拉：${s.slice(turnAt, turnAt + 80)}`);
  assert.ok(s.indexOf("## 同场角色") < turnAt, "名册在前、发言者块在后（名册属于前缀，发言者属于尾部）");

  const cast = (r.audit.included || []).find(i => i.kind === "cast");
  const turn = (r.audit.included || []).find(i => i.kind === "turn");
  assert.ok(cast && turn, `账里该有 cast 与 turn 两笔：${JSON.stringify((r.audit.included || []).map(i => i.kind))}`);
  assert.ok(/稳定前缀/.test(cast.note), `名册那笔要说清它属于前缀：${cast.note}`);
  assert.ok(/尾部/.test(turn.note), `发言者那笔要说清它在尾部：${turn.note}`);
});

// ── ⑤ 换发言者：砸的是 base，**不该砸 cast** ────────────
await okAsync("换发言者：前缀变化里只该有 base，**不该有 cast**（名册与发言者无关）", async () => {
  resetPrefixWatch();
  const conv = await convRepo.create(vera.id, { characterIds: [vera.id, ren.id] });
  await convRepo.addMessage(conv.id, "user", "谁先说？");
  const full = await convRepo.get(conv.id);

  await buildGenerationInput(repos, full, vera, "嗯", OPT);
  const second = await buildGenerationInput(repos, full, ren, "嗯", OPT);

  const changed = second.audit?.prefix?.changed?.parts || null;
  assert.ok(changed, "换了发言者，base 那块本来就该变（发言者的卡是底子）");
  assert.ok(changed.includes("base"), `base 该在变化名单里：${JSON.stringify(changed)}`);
  assert.ok(!changed.includes("cast"), `**名册不该跟着发言者变**：${JSON.stringify(changed)}`);
  assert.ok(!changed.includes("board-static"), `常驻格也不该跟着变：${JSON.stringify(changed)}`);
});

await okAsync("名册是纯函数：同两张卡、换个顺序也一样（不掺发言者）", () => {
  const a = renderCastRoster([vera, ren]);
  const b = renderCastRoster([vera, ren]);
  assert.strictEqual(a, b);
  assert.ok(a.includes("薇拉") && a.includes("任十九"));
  // 名册里可以讲“每一轮只有一位发言”这条规则，但**不能点名**谁在说
  assert.ok(!a.includes("## 本轮发言者"), "名册不该带“本轮发言者”那块（那块是尾部的）");
  assert.strictEqual(renderCastRoster([vera]), "", "一个人不给名册");
});

// ── ⑥ 消息上的发言者字段能存下来 ──────────────────────
await okAsync("消息能记住发言者（UI 要靠它标谁说的）", async () => {
  const conv = await convRepo.create(vera.id, { characterIds: [vera.id, ren.id] });
  const msg = await convRepo.addMessage(conv.id, "assistant", "「山上的风变了。」", {
    speakerId: ren.id, speakerName: "任十九"
  });
  const back = (await convRepo.get(conv.id)).messages.find(m => m.id === msg.id);
  assert.strictEqual(back.speakerName, "任十九");
  assert.strictEqual(back.speakerId, ren.id);
});

// ── ⑦ 路由：发言者真的落到回复上 ────────────────────
await okAsync("路由：带 speakerId 发一条 → 回复上记着是谁说的", async () => {
  const app = makeApp();
  const llm = { available: true, generate: async () => ({ content: "「山上的风变了。」", usage: {}, target: { model: "grp-stub" } }), resolveContextWindow: async () => 32000 };
  registerConversationRoutes(app, convRepo, llm, charRepo, setRepo, null, null, null);

  const conv = await convRepo.create(vera.id, { characterIds: [vera.id, ren.id] });
  const r = await request(app, "POST", `/conversations/${conv.id}/messages`, {
    body: { content: "谁先说？", speakerId: ren.id }
  });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.assistantMessage.speakerId, ren.id, "回复该署上发言者");
  assert.strictEqual(r.data.assistantMessage.speakerName, "任十九");
});

await okAsync("路由：发言者不在这一场里 → 报错说清（不偷偷用主角顶上）", async () => {
  const app = makeApp();
  const llm = { available: true, generate: async () => ({ content: "x", usage: {}, target: {} }), resolveContextWindow: async () => 32000 };
  registerConversationRoutes(app, convRepo, llm, charRepo, setRepo, null, null, null);

  const conv = await convRepo.create(vera.id, { characterIds: [vera.id, ren.id] });
  const r = await request(app, "POST", `/conversations/${conv.id}/messages`, {
    body: { content: "喂", speakerId: solo.id }
  });
  assert.ok(r.status >= 400, `该报错，实际 ${r.status}`);
  assert.ok(/发言者不在这一场里/.test(r.error || ""), `报错要说清：${r.error}`);
});

await okAsync("单人对话：不写 speakerId（那条信息多余，也会改掉单角色路径的落盘形状）", async () => {
  const app = makeApp();
  const llm = { available: true, generate: async () => ({ content: "嗯。", usage: {}, target: {} }), resolveContextWindow: async () => 32000 };
  registerConversationRoutes(app, convRepo, llm, charRepo, setRepo, null, null, null);

  const conv = await convRepo.create(solo.id);
  const r = await request(app, "POST", `/conversations/${conv.id}/messages`, { body: { content: "你一个人？" } });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.ok(!r.data.assistantMessage.speakerId, `不该写发言者：${JSON.stringify(r.data.assistantMessage.speakerId)}`);
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
