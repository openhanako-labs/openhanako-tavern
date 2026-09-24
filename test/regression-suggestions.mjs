// test/regression-suggestions.mjs — 行动候选项：解析 + 存储 + **不进正文 prompt**
//
// 最后那一条是这一整块的命。
// 候选项一旦漏进正文 prompt，每轮前面就多一段会变的东西，
// 前缀缓存被它从那个位置往后砸穿——而且是静默的：
// 没人会报错，只会发现"缓存命中率莫名其妙很低"。

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
const { parseSuggestions, SUGGESTION_LIMIT } = await import("../lib/conversations/suggestions.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 行动候选项 ===\n");

// ── 解析 ──────────────────────────────────────────────

await okAsync("解析：正常四行 → 四条，无丢弃", () => {
  const r = parseSuggestions("- 推开哨塔的门\n- 站在门口听一会儿风\n- 问她那道疤的来历\n- 掉头下山");
  assert.strictEqual(r.items.length, 4);
  assert.strictEqual(r.dropped.length, 0, `不该有丢弃：${JSON.stringify(r.dropped)}`);
  assert.strictEqual(r.note, "", `不该有说明：${r.note}`);
});

await okAsync("解析：JSON / 代码块 → 判失败，不猜", () => {
  const json = parseSuggestions('{"actions":["a","b"],"scene":"c"}');
  assert.strictEqual(json.items.length, 0, "JSON 不该被当成选项");
  assert.ok(/JSON/.test(json.dropped[0].why), json.dropped[0].why);

  const fence = parseSuggestions("```\n- 推开哨塔的门\n```");
  assert.strictEqual(fence.items.length, 0, "代码块不该被当成选项");
});

await okAsync("解析：重复 / 非列表行 / 超上限 —— 都要进 dropped 且带理由", () => {
  const r = parseSuggestions([
    "好的，这是几个选项：",
    "- 推开哨塔的门",
    "- 推开哨塔的门",
    "- 站在门口听一会儿风",
    "- 问她那道疤的来历",
    "- 掉头下山，不等天亮",
    "- 第五条不该进来"
  ].join("\n"));

  assert.strictEqual(r.items.length, SUGGESTION_LIMIT, `应当截到 ${SUGGESTION_LIMIT} 条`);
  const whys = r.dropped.map(d => d.why).join(" | ");
  assert.ok(/没有 `- ` 前缀/.test(whys), `非列表行没被记下：${whys}`);
  assert.ok(/重复/.test(whys), `重复没被记下：${whys}`);
  assert.ok(/超出上限/.test(whys), `超上限没被记下：${whys}`);
});

await okAsync("解析：空 → 空手 + 一句说明（不一声不吭）", () => {
  const r = parseSuggestions("   ");
  assert.strictEqual(r.items.length, 0);
  assert.ok(r.note, "应当给一句说明");
});

await okAsync("解析：只有两条 → 如实说只给到两条，不硬凑", () => {
  const r = parseSuggestions("- 转身离开\n- 留在原地等她开口");
  assert.strictEqual(r.items.length, 2);
  assert.ok(/只给到 2 条/.test(r.note), r.note);
});

// ── 存储 + 路由 ───────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-sug-"));
const charRepo = new CharacterRepo(tmp); await charRepo.init();
const convRepo = new ConversationRepo(tmp); await convRepo.init();
const setRepo = new SettingRepo(tmp); await setRepo.init();

const character = await charRepo.create({
  name: "薇拉", description: "守夜法师", first_mes: "「又是你。」"
});
const conv = await convRepo.create(character.id);
await convRepo.addMessage(conv.id, "user", "你在守什么？");
await convRepo.addMessage(conv.id, "assistant", "「守着别让人上来。」");

const SUGGESTION_TEXT = "推开哨塔的门往里走";
const fakeLlm = {
  available: true,
  lastTarget: { model: "sug-stub" },
  resolveContextWindow: async () => 32000,
  generate: async () => ({
    content: [
      `- ${SUGGESTION_TEXT}`,
      "- 站在门口听一会儿风",
      "- 问她左眼那道疤的来历",
      "- 掉头下山，不等天亮"
    ].join("\n"),
    usage: { prompt_tokens: 90, completion_tokens: 40 },
    target: { model: "sug-stub" }
  })
};

await okAsync("路由：生成 → 解析 → 挂到最后一条 assistant 消息上", async () => {
  const app = makeApp();
  registerConversationRoutes(app, convRepo, fakeLlm, charRepo, setRepo, null, null, null);

  const r = await request(app, "POST", `/conversations/${conv.id}/suggestions`, { body: {} });
  assert.ok(r, "路由没匹配上");
  assert.strictEqual(r.status, 200, `状态 ${r.status}（${r.error || ""}）`);
  assert.strictEqual(r.data.items.length, 4, `选项数不对：${JSON.stringify(r.data.items)}`);
  assert.ok(r.data.attachedTo, "没有挂到消息上");

  const after = await convRepo.get(conv.id);
  const msg = after.messages.find(m => m.id === r.data.attachedTo);
  assert.strictEqual(msg.role, "assistant", "挂错了消息（应当挂到最后一条 assistant）");
  assert.strictEqual(msg.suggestions.length, 4, "没有真的落盘");
});

// ── 命：候选项不许进正文 prompt ───────────────────────

await okAsync("候选项**不进正文 prompt**（前缀缓存靠这条活着）", async () => {
  const fresh = await convRepo.get(conv.id);
  const out = await buildGenerationInput(
    { conversationRepo: convRepo, characterRepo: charRepo, settingRepo: setRepo, regexRepo: null, boardRepo: null },
    fresh, character, "她抬头。", {}
  );

  const hay = out.systemPrompt + "\n" + out.messages.map(m => String(m.content ?? "")).join("\n");
  assert.ok(
    !hay.includes(SUGGESTION_TEXT),
    "候选项漏进正文 prompt 了——每轮前面多一段会变的东西，前缀缓存会被它从那里往后砸穿"
  );
  // 反证：这条判据本身要有牙——把候选项文本塞进去必须能被抓到
  assert.ok((hay + SUGGESTION_TEXT).includes(SUGGESTION_TEXT), "判据没有牙（连塞进去都抓不到）");
});

await okAsync("候选项挂在消息上：删掉那条消息，它就跟着走", async () => {
  const before = await convRepo.get(conv.id);
  const last = [...before.messages].reverse().find(m => m.role === "assistant");
  assert.ok(last.suggestions?.length > 0, "前置条件：那条消息上应当已经有候选项");
  await convRepo.deleteMessage(conv.id, last.id);
  const after = await convRepo.get(conv.id);
  assert.ok(
    !JSON.stringify(after.messages).includes(SUGGESTION_TEXT),
    "消息删了，候选项还留在对话里"
  );
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
