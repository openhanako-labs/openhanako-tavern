// test/regression-cache-layering.mjs — 前缀分层重组的黄金断言
//
// 缓存处方把 systemPrompt 拆成 [静态前缀][动态尾巴]，四件事必须钉死：
//   1. 同输入两次逐字节相等（确定性 = 命中的前提）
//   2. 静态段在前、世界书在尾（字节序 = 缓存 key 的序）
//   3. 激活集合变化时，静态段逐字节不变（前缀不断 = 命中不断）
//   4. 预设禁用 lore 块时整段不拼（用户关世界书的自由）
// 少了任何一条，分层都可能被"顺手"改回去而没人发现。

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { ConversationRepo } = await import("../lib/conversations/repo.js");
const { CharacterRepo } = await import("../lib/characters/repo.js");
const { SettingRepo } = await import("../lib/settings/repo.js");
const { buildGenerationInput, applyMacrosToCharacter } = await import("../lib/conversations/pipeline.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 缓存前缀分层 ===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-layer-"));
const charRepo = new CharacterRepo(tmp); await charRepo.init();
const convRepo = new ConversationRepo(tmp); await convRepo.init();
const settingRepo = new SettingRepo(tmp); await settingRepo.init();

const repos = { conversationRepo: convRepo, characterRepo: charRepo, settingRepo, regexRepo: null };

const STATIC_ANCHOR = "主提示固定文本";       // 静态段的独有指纹（literal 块）
const LORE_MARK = "## 世界设定";

const card = await charRepo.create({ name: "薇拉", description: "守夜法师", first_mes: "「又是你。」" });
const conv = await convRepo.create(card.id);

// 一条能被"北境"命中的世界书
await settingRepo.create({
  comment: "北境防线",
  content: "北境的防线由守夜人轮值。",
  keywords: ["北境"],
  tier: "core"
});

// 含 lore 块的预设（默认形态）与禁用 lore 块的预设
const withLore = {
  id: "p-lore",
  blocks: [
    { id: "main", source: "literal", content: STATIC_ANCHOR, position: "system", order: 0, enabled: true },
    { id: "lore", source: "lore", position: "system", order: 50, enabled: true }
  ]
};
const noLore = {
  id: "p-nolore",
  blocks: [
    { id: "main", source: "literal", content: STATIC_ANCHOR, position: "system", order: 0, enabled: true },
    { id: "lore", source: "lore", position: "system", order: 50, enabled: false }
  ]
};

async function buildIn(convId, input, preset) {
  await convRepo.addMessage(convId, "user", input);
  const fresh = await convRepo.get(convId);
  const r = await buildGenerationInput(repos, fresh, card, input, preset ? { preset } : {});
  return r.systemPrompt;
}

async function build(input, preset) {
  return buildIn(conv.id, input, preset);
}

// 场景 1：同输入两次，逐字节相等
await okAsync("同输入两次 → systemPrompt 逐字节相等", async () => {
  const a = await build("北境的夜。", withLore);
  const b = await build("北境的夜。", withLore);
  assert.strictEqual(a, b);
});

// 场景 2：静态段在前、世界书在尾
await okAsync("静态段在前、世界书在尾", async () => {
  const sp = await build("北境的夜再一晚。", withLore);
  const iStatic = sp.indexOf(STATIC_ANCHOR);
  const iLore = sp.indexOf(LORE_MARK);
  assert.ok(iStatic >= 0, "静态指纹应当存在");
  assert.ok(iLore > iStatic, `世界书应在静态段之后（static@${iStatic}, lore@${iLore}）`);
  // 尾部结构：世界书标记之后直接是内容，不再夹静态块
  assert.ok(sp.trimEnd().includes("守夜人轮值"), "世界书内容应在提示内");
});

// 场景 3：激活集合变了，静态段逐字节不变（前缀不断 = 命中不断）
await okAsync("激活集合变化 → 静态前缀逐字节不变", async () => {
  // 用另一条命中的世界书改变激活集合
  await settingRepo.create({
    comment: "天气",
    content: "塔顶终年飘着细雪。",
    keywords: ["塔顶"],
    tier: "core"
  });
  const a = await build("北境的夜又一晚。", withLore);
  const b = await build("塔顶的风。", withLore);       // 新增命中：集合变大
  const staticOf = (sp) => sp.split(LORE_MARK)[0];
  assert.notStrictEqual(a.split(LORE_MARK)[1], b.split(LORE_MARK)[1], "尾部激活内容应不同");
  assert.strictEqual(staticOf(a), staticOf(b), "静态前缀必须逐字节不变");
});

// 场景 4：预设禁用 lore 块 → 尾部不拼
await okAsync("预设禁用 lore 块 → 世界书整段不拼", async () => {
  const sp = await build("塔顶的风再起。", noLore);
  assert.ok(!sp.includes(LORE_MARK), "禁用后不应出现世界书段");
  assert.ok(sp.includes(STATIC_ANCHOR), "静态段照常");
});

// 场景 5：无尾巴那次，应当是有尾巴那次的**字节前缀**
//
// 这是缓存真正依赖的性质：provider 比的是最长公共前缀。
// 曾经这里错过——分隔符 `\n\n` 写在前缀那一侧，于是本轮没尾巴时前缀少
// 两个字节、有尾巴时多两个字节，「前缀」变成了一个依赖尾巴是否存在的量。
// 只差 2 字节、命中不受影响，但那种表述一旦被后人当真就会出事。
await okAsync("无尾巴那次 → 是有尾巴那次的字节前缀（分隔符归尾部）", async () => {
  // 干净历史：扫描窗口是最近 8 条，旧消息里的「北境」会继续命中
  const fresh = await convRepo.create(card.id);
  const cold = await buildIn(fresh.id, "一句没有关键词的话。", withLore);
  const hot = await buildIn(fresh.id, "北境的夜。", withLore);

  assert.ok(!cold.includes(LORE_MARK), "这一句不该命中世界书");
  assert.ok(hot.includes(LORE_MARK), "这一句应当命中世界书");
  assert.ok(hot.startsWith(cold), "有尾巴时，无尾巴那次的内容不是它的字节前缀");
});

// ── 账（audit）：谁进了、谁没进、为什么 ──
//
// 这一块存在的理由：拼好的正文是给模型看的，**対不出「该进没进」**。
// 人验收得看账。参考了同类项目 dsh-tavern 的 context-planner
// （见 docs/notes-dsh-tavern.md），但字段是按我们自己的拼装点定的。

await okAsync("账：每段都有出处，没进的都要写理由，总数与真发出去的一致", async () => {
  const out = await buildGenerationInput(repos, conv, card, "又一句没关键词的话。", {});
  const a = out.audit;
  assert.ok(a && Array.isArray(a.included) && Array.isArray(a.omitted), "没有账");

  assert.ok(a.included.some(x => x.kind === "base" && x.chars > 0), "账上没有底子段");

  // 没进**必须**写理由。没写就等于「忘了」——那正是这块要防的事。
  for (const o of a.omitted) {
    assert.ok(String(o.reason || "").trim().length > 0, `omitted 缺理由：${JSON.stringify(o)}`);
  }
  // 每段都要有 where，界面靠它分「系统 / 消息」两栏
  for (const x of a.included) {
    assert.ok(x.where === "system" || x.where === "messages", `section 缺 where：${JSON.stringify(x)}`);
  }

  // 算术：账上的总数 = 真发出去的系统提示 + 消息正文
  const expect = out.systemPrompt.length
    + out.messages.reduce((n, m) => n + String(m.content ?? "").length, 0);
  assert.strictEqual(a.totalChars, expect, "账上的总字符数与真发出去的对不上");
});

await okAsync("账：卡里没有时间宏 → time 那一条要写明为什么没拼", async () => {
  const out = await buildGenerationInput(repos, conv, card, "又一句没关键词的话。", {});
  const t = out.audit.omitted.find(x => x.kind === "time");
  assert.ok(t, "没时间宏的卡，账上应当有一条 time 的 omitted");
  assert.ok(/时间宏/.test(t.reason), `理由没说清：${t.reason}`);
});

await okAsync("账：卡里用了时间宏 → time 进系统栏，且不再出现在 omitted 里", async () => {
  const timed = await charRepo.create({
    name: "看钟的人", description: "现在是 {{time}}。", first_mes: "「你来了。」"
  });
  const c2 = await convRepo.create(timed.id);
  // 必须跟真路径一样先过宏：needsTimeBlock 看的是**处理过的卡**上的指路标记，
  // 直接拿原始卡（还写着 {{time}}）它当然说「没时间宏」。
  const out = await buildGenerationInput(repos, c2, applyMacrosToCharacter(timed, c2, {}), "嗯。", {});
  assert.ok(out.audit.included.some(x => x.kind === "time" && x.where === "system"), "时间块没进账");
  assert.ok(!out.audit.omitted.some(x => x.kind === "time"), "时间块进了，却还报着没进");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
