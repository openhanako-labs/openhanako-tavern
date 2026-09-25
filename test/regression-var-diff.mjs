// test/regression-var-diff.mjs — 本轮变量变化：结算 + 落盘 + 显示
//
// 这一块有两半，而且**两半都是真 bug**：
//
//   ① 回复里的 {{setvar}} 一直是静默失效的。
//      宏引擎把变量写收敛到 onVariableChange 回调，注释写明「由调用方决定何时落盘」，
//      而调用方从没落盘过；`conv` 又是加用户消息之前取的旧对象，
//      repo.addMessage 会从磁盘重读。所以那句话写完就蒸发了——
//      没有报错、没有提示，界面上当然也永远没有「变量变化」可显示。
//
//   ② 账要挂在消息上，而且**不许进正文 prompt**（同候选项那一条：
//      每轮前面多一段会变的东西，前缀缓存从那里往后全废）。

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
const { snapshotVars, diffVars, describeVarDiff } = await import("../lib/variables/diff.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 本轮变量变化 ===\n");

// ── 纯函数：账从状态长出来 ────────────────────────────

await okAsync("快照：数字与字符串同值不算变化（7 与 \"7\" 是同一个值）", () => {
  const d = diffVars({ 好感: 7 }, { 好感: "7" });
  assert.deepStrictEqual(d, [], "同一个值被报成了一次改动——那是纯噪音");
});

await okAsync("快照：null 归一成空串，undefined 直接不进快照", () => {
  assert.deepStrictEqual(snapshotVars({ a: null, b: undefined, c: 3 }), { a: "", c: "3" });
});

await okAsync("差：新增 / 改写 / 移除，且按名字排序（中文按码位：好感 < 新线索 < 旧线索）", () => {
  const d = diffVars({ 好感: "3", 旧线索: "x" }, { 好感: "4", 新线索: "y" });
  assert.deepStrictEqual(d, [
    { name: "好感", change: "set", from: "3", to: "4" },
    { name: "新线索", change: "add", from: null, to: "y" },
    { name: "旧线索", change: "remove", from: "x", to: null }
  ]);
});

await okAsync("描述：长值截断，不让一条几百字的变量撑破整行", () => {
  const long = "字".repeat(80);
  const s = describeVarDiff({ name: "笔记", change: "set", from: "a", to: long });
  assert.ok(s.length < 60, `没截断：${s.length} 字`);
  assert.ok(s.includes("…"), s);
});

await okAsync("描述：三种形状都说人话", () => {
  assert.strictEqual(describeVarDiff({ name: "好感", change: "set", from: "3", to: "4" }), "好感 3 → 4");
  assert.strictEqual(describeVarDiff({ name: "势力", change: "add", from: null, to: "5" }), "势力 → 5");
  assert.ok(/已移除/.test(describeVarDiff({ name: "旧线索", change: "remove", from: "x", to: null })));
});

// ── 路由：写要真的落盘 ────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-vardiff-"));
const charRepo = new CharacterRepo(tmp); await charRepo.init();
const convRepo = new ConversationRepo(tmp); await convRepo.init();
const setRepo = new SettingRepo(tmp); await setRepo.init();

const character = await charRepo.create({
  name: "薇拉", description: "守夜法师", first_mes: "「又是你。」"
});
const conv = await convRepo.create(character.id);

/** 按调用次序吐不同回复的桩。 */
function stubLlm(replies) {
  let i = 0;
  return {
    available: true,
    lastTarget: { model: "vardiff-stub" },
    resolveContextWindow: async () => 32000,
    generate: async () => {
      const content = replies[Math.min(i, replies.length - 1)];
      i++;
      return { content, usage: { prompt_tokens: 80, completion_tokens: 20 }, target: { model: "vardiff-stub" } };
    }
  };
}

async function send(app, text) {
  const r = await request(app, "POST", `/conversations/${conv.id}/messages`, { body: { content: text } });
  assert.ok(r, "路由没匹配上（路径变了？）");
  assert.strictEqual(r.status, 200, `状态 ${r.status}（${r.error || ""}）`);
  return r.data;
}

await okAsync("回复里的 {{setvar}} **真的落盘了**（此前是静默失效）", async () => {
  const app = makeApp();
  registerConversationRoutes(app, convRepo, stubLlm(["她看了你一眼。{{setvar::好感::7}}"]), charRepo, setRepo, null, null, null);

  const data = await send(app, "你还在吗？");
  const stored = data.assistantMessage;

  assert.ok(!String(stored.content).includes("{{setvar"), `宏没被执行：${stored.content}`);
  assert.ok(String(stored.content).includes("她看了你一眼"), "正文被宏吃掉了");

  const after = await convRepo.get(conv.id);
  assert.strictEqual(after.variables?.好感, "7", `变量没落盘：${JSON.stringify(after.variables)}`);
});

await okAsync("账挂在消息上：形状对、change 是 add、文字是服务端拼好的", async () => {
  const after = await convRepo.get(conv.id);
  const last = [...after.messages].reverse().find(m => m.role === "assistant");
  assert.ok(Array.isArray(last.varDiff), `消息上没有账：${JSON.stringify(last.varDiff)}`);
  const d = last.varDiff[0];
  assert.deepStrictEqual(
    { name: d.name, change: d.change, from: d.from, to: d.to },
    { name: "好感", change: "add", from: null, to: "7" }
  );
  // 显示用的那行字由服务端拼好（前端不再养一份拼字逻辑）
  assert.strictEqual(d.text, "好感 → 7", `文字不对：${d.text}`);
});

await okAsync("第二轮改写：change 是 set，from 是上一轮的值", async () => {
  const app = makeApp();
  registerConversationRoutes(app, convRepo, stubLlm(["「嗯。」{{setvar::好感::9}}"]), charRepo, setRepo, null, null, null);

  const data = await send(app, "那我走了。");
  const d = data.assistantMessage.varDiff?.[0];
  assert.deepStrictEqual(
    { name: d?.name, change: d?.change, from: d?.from, to: d?.to },
    { name: "好感", change: "set", from: "7", to: "9" }
  );
  assert.strictEqual(d.text, "好感 7 → 9", `文字不对：${d.text}`);
  const after = await convRepo.get(conv.id);
  assert.strictEqual(after.variables?.好感, "9");
});

await okAsync("写同一个值：回调照样会响，但账里**不该有这一笔**（账从状态来，不从自报来）", async () => {
  const app = makeApp();
  registerConversationRoutes(app, convRepo, stubLlm(["「还是九。」{{setvar::好感::9}}"]), charRepo, setRepo, null, null, null);

  const data = await send(app, "还是九吗？");
  assert.ok(
    !data.assistantMessage.varDiff,
    `值没变却记了一笔：${JSON.stringify(data.assistantMessage.varDiff)}`
  );
  const after = await convRepo.get(conv.id);
  assert.strictEqual(after.variables?.好感, "9", "值不该被动过");
});

await okAsync("没有 setvar 的一轮：没有账（不生成空账）", async () => {
  const app = makeApp();
  registerConversationRoutes(app, convRepo, stubLlm(["她没说话，只是点了点头。"]), charRepo, setRepo, null, null, null);

  const data = await send(app, "……");
  assert.ok(!data.assistantMessage.varDiff, "这一轮没有变量变化，不该有账");
});

// ── 命：账不许进正文 prompt ───────────────────────────

await okAsync("账**不进正文 prompt**（前缀缓存靠这条活着）", async () => {
  const fresh = await convRepo.get(conv.id);
  const out = await buildGenerationInput(
    { conversationRepo: convRepo, characterRepo: charRepo, settingRepo: setRepo, regexRepo: null, boardRepo: null },
    fresh, character, "她说：还行。", {}
  );
  const hay = out.systemPrompt + "\n" + out.messages.map(m => String(m.content ?? "")).join("\n");
  const line = describeVarDiff({ name: "好感", change: "set", from: "7", to: "9" });
  assert.ok(!hay.includes(line), `账漏进正文 prompt 了（${line}）`);
  // 反证：这条判据本身要有牙
  assert.ok((hay + line).includes(line), "判据没有牙（连塞进去都抓不到）");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
