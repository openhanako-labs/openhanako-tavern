// test/regression-director-multi-wire.mjs — 多条公式真的接进生成链路
//
// regression-director-multi.mjs 证明的是**零件**能转（排序、裁决、路由）。
// 这个文件证明**接上线**：一场绑两条公式之后，
//   · 提示里真的出现**两块**，且按 order 排列
//   · 两块各读各的进度，互不污染
//   · 覆盖声明只出现一次（两条各说一次会互相否定）
//   · 老对话（只有 directorId、__dir 是扁平的）照常能跑
//   · 结算时上报按名路由，同名量按 priority 裁决
//
// 最后一条最要紧：**老数据必须能读**——这是改形状时的底线。

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { ConversationRepo } = await import("../lib/conversations/repo.js");
const { CharacterRepo } = await import("../lib/characters/repo.js");
const { SettingRepo } = await import("../lib/settings/repo.js");
const { DirectorRepo } = await import("../lib/director/repo.js");
const { buildGenerationInput } = await import("../lib/conversations/pipeline.js");
const { makeApp, request } = await import("./lib/route-harness.mjs");
const { registerDirectorRoutes } = await import("../lib/director/routes.js");
const { registerConversationRoutes } = await import("../lib/conversations/routes.js");
const { DIRECTOR_VAR_KEY } = await import("../lib/director/model.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 端到端 · 多条公式接进生成链路 ===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-dir-multi-"));
const charRepo = new CharacterRepo(tmp); await charRepo.init();
const convRepo = new ConversationRepo(tmp); await convRepo.init();
const settingRepo = new SettingRepo(tmp); await settingRepo.init();
const directorRepo = new DirectorRepo(tmp); await directorRepo.init();

const repos = {
  conversationRepo: convRepo, characterRepo: charRepo, settingRepo,
  regexRepo: null, boardRepo: null, directorRepo
};

/** 张力型公式：每轮 +5，到 7 回落、到 10 触发不可逆。 */
const TENSION = {
  name: "张力",
  state: { tension: { init: 1, min: 0, max: 10 }, turn: { init: 0 } },
  rules: [
    { when: "always", effect: "tension += 5" },
    { when: "always", effect: "turn += 1" },
    { when: "tension >= 10", effect: "tension = 2", brief: "触发一次不可逆事件" },
    { when: "tension >= 7", effect: "tension -= 4", brief: "必须出现一次正面冲突" }
  ]
};

/** 悬疑型公式：每轮 +3，到 8 掀真相一角。 */
const SUSPENSE = {
  name: "悬疑",
  state: { 悬疑: { init: 0, min: 0, max: 8 }, 回合: { init: 0 } },
  rules: [
    { when: "always", effect: "悬疑 += 3" },
    { when: "always", effect: "回合 += 1" },
    { when: "悬疑 >= 8", effect: "悬疑 = 0", brief: "掀开真相的一角" }
  ]
};

const card = await charRepo.create({ name: "艾尔", description: "机甲训练官", first_mes: "「上机。」" });

async function build(convId, input = "我坐进了驾驶舱。") {
  await convRepo.addMessage(convId, "user", input);
  const fresh = await convRepo.get(convId);
  return buildGenerationInput(repos, fresh, card, input, {});
}

const MARK = "【导演 · 本轮】";

// ── ① 两条都注入，且按 order 排列 ─────────────────────
await okAsync("绑两条 → 提示里出现两块", async () => {
  const a = await directorRepo.create({ ...TENSION, order: 1 });
  const b = await directorRepo.create({ ...SUSPENSE, order: 2 });
  const conv = await convRepo.create(card.id, { directorIds: [a.id, b.id] });

  const { systemPrompt } = await build(conv.id);
  const hits = (systemPrompt.match(/【导演 · 本轮/g) || []).length;
  assert.equal(hits, 2, `应该有两块，实际 ${hits} 块`);
  assert.ok(/【导演 · 本轮 · 张力】/.test(systemPrompt), "缺张力块的名字");
  assert.ok(/【导演 · 本轮 · 悬疑】/.test(systemPrompt), "缺悬疑块的名字");
});

await okAsync("块按 order 排（不按绑定顺序）", async () => {
  const a = await directorRepo.create({ ...TENSION, name: "后写", order: 9 });
  const b = await directorRepo.create({ ...SUSPENSE, name: "先写", order: 1 });
  // 故意把 order 大的绑在前面
  const conv = await convRepo.create(card.id, { directorIds: [a.id, b.id] });

  const { systemPrompt } = await build(conv.id);
  const firstAt = systemPrompt.indexOf("【导演 · 本轮 · 先写】");
  const lastAt = systemPrompt.indexOf("【导演 · 本轮 · 后写】");
  assert.ok(firstAt >= 0 && lastAt >= 0, "两块没都出现");
  assert.ok(firstAt < lastAt, "order 小的没排在前面——绑定顺序不该决定注入顺序");
});

await okAsync("覆盖声明只出现一次", async () => {
  const a = await directorRepo.create({ ...TENSION, order: 1 });
  const b = await directorRepo.create({ ...SUSPENSE, order: 2 });
  const conv = await convRepo.create(card.id, { directorIds: [a.id, b.id] });
  const { systemPrompt } = await build(conv.id);
  const hits = (systemPrompt.match(/硬约束/g) || []).length;
  assert.equal(hits, 1, `覆盖声明出现 ${hits} 次——每块各说一次会互相否定`);
  assert.ok(/以上各段约束共同覆盖/.test(systemPrompt), "多条时应说「以上各段」");
});

// ── ② 进度各归各家 ───────────────────────────────────
await okAsync("两块各读各的进度（新形状 __dir）", async () => {
  const a = await directorRepo.create({ ...TENSION, order: 1 });
  const b = await directorRepo.create({ ...SUSPENSE, order: 2 });
  const conv = await convRepo.create(card.id, { directorIds: [a.id, b.id] });
  await convRepo.updateVariables(conv.id, {
    [DIRECTOR_VAR_KEY]: { [a.id]: { tension: 9, turn: 3 }, [b.id]: { 悬疑: 5, 回合: 7 } }
  });

  const { systemPrompt } = await build(conv.id);
  assert.ok(/tension 9\/10/.test(systemPrompt), "A 没读到自己的进度");
  assert.ok(/悬疑 5\/8/.test(systemPrompt), "B 没读到自己的进度");
  assert.ok(/回合 7/.test(systemPrompt), "B 的回合没读到");
});

await okAsync("**兼容**：老对话（扁平 __dir + 单值 directorId）照常跑", async () => {
  const a = await directorRepo.create({ ...TENSION, name: "老数据公式" });
  // 老对话：只有 directorId（没有 directorIds），__dir 是扁平的
  const conv = await convRepo.create(card.id, { directorId: a.id });
  await convRepo.updateVariables(conv.id, { [DIRECTOR_VAR_KEY]: { tension: 8, turn: 4 } });

  const { systemPrompt } = await build(conv.id);
  assert.ok(/tension 8\/10/.test(systemPrompt),
    "老对话的扁平进度没读到——改形状时破了兼容");
  assert.ok(!/【导演 · 本轮 · /.test(systemPrompt), "单条时块头不该带名字（会改动老对话的 prompt）");
});

// ── ③ 结算：上报按名路由 ──────────────────────────────
const app = makeApp();
registerDirectorRoutes(app, directorRepo);
registerConversationRoutes(app, convRepo, null, charRepo, settingRepo, null, null, null, { directorRepo });

await okAsync("**契约**：PATCH /directors 绑两条、读得回", async () => {
  const a = await directorRepo.create({ ...TENSION, name: "绑定测试甲" });
  const b = await directorRepo.create({ ...SUSPENSE, name: "绑定测试乙" });
  const conv = await convRepo.create(card.id);

  const r = await request(app, "PATCH", `/conversations/${conv.id}/directors`, {
    body: { directorIds: [a.id, b.id] }
  });
  assert.strictEqual(r.status, 200, `绑定失败：${r.error || ""}`);

  const saved = await convRepo.get(conv.id);
  assert.deepEqual(saved.directorIds, [a.id, b.id], "directorIds 没落盘");
  assert.strictEqual(saved.directorId, a.id, "旧的单值字段该保留第一条");
});

await okAsync("**契约**：绑到不存在的公式要拦下来", async () => {
  const conv = await convRepo.create(card.id);
  const r = await request(app, "PATCH", `/conversations/${conv.id}/directors`, {
    body: { directorIds: ["不存在"] }
  });
  assert.notStrictEqual(r.status, 200, "绑到不存在的公式该拦");
});

await okAsync("**契约**：旧的单值入口仍然能用（内部转调多值）", async () => {
  const a = await directorRepo.create({ ...TENSION, name: "单值入口测试" });
  const conv = await convRepo.create(card.id);
  const r = await request(app, "PATCH", `/conversations/${conv.id}/director`, {
    body: { directorId: a.id }
  });
  assert.strictEqual(r.status, 200, `单值绑定失败：${r.error || ""}`);
  const saved = await convRepo.get(conv.id);
  assert.deepEqual(saved.directorIds, [a.id], "单值入口没同步到 directorIds");
});

// ── ④ 关掉其中一条 ───────────────────────────────────
await okAsync("关掉一条 → 那一块不注入，另一块照常", async () => {
  const a = await directorRepo.create({ ...TENSION, name: "开着的" });
  const b = await directorRepo.create({ ...SUSPENSE, name: "关着的" });
  await directorRepo.update(b.id, { enabled: false });
  const conv = await convRepo.create(card.id, { directorIds: [a.id, b.id] });

  const { systemPrompt } = await build(conv.id);
  assert.ok(/【导演 · 本轮】/.test(systemPrompt), "开着的那条没注入");
  assert.ok(!/关着的/.test(systemPrompt), "关掉的那条还在注入");
  assert.ok(!/【导演 · 本轮 · 开着的】/.test(systemPrompt), "只剩一条时块头不该带名字");
});

await okAsync("两条都关掉 → 一个字都不注入，生成不失败", async () => {
  const a = await directorRepo.create({ ...TENSION, name: "全关甲" });
  const b = await directorRepo.create({ ...SUSPENSE, name: "全关乙" });
  await directorRepo.update(a.id, { enabled: false });
  await directorRepo.update(b.id, { enabled: false });
  const conv = await convRepo.create(card.id, { directorIds: [a.id, b.id] });

  const { systemPrompt } = await build(conv.id);
  assert.strictEqual(systemPrompt.includes(MARK), false);
});

// ── ⑤ 结算写回：形状要升格 ───────────────────────────
await okAsync("结算写回时进度升格成嵌套（多条）", async () => {
  const { settleMany, sortByOrder } = await import("../lib/director/engine.js");
  const { writeDirState } = await import("../lib/director/binding.js");

  const a = await directorRepo.create({ ...TENSION, name: "写回甲" });
  const b = await directorRepo.create({ ...SUSPENSE, name: "写回乙" });
  const ents = sortByOrder([await directorRepo.get(a.id), await directorRepo.get(b.id)]);

  // 老形状（扁平）作为起点
  let dir = { tension: 3, turn: 1 };
  const states = { [a.id]: { tension: 3, turn: 1 }, [b.id]: { 悬疑: 0, 回合: 0 } };
  const result = settleMany(ents, states, []);

  for (const e of ents) {
    dir = writeDirState(dir, e.id, result.states[e.id] || {}, {
      forceNested: true, migrateFrom: ents[0].id
    });
  }

  // 升格后：旧扁平数据归到第一条名下
  assert.ok(dir[a.id] && typeof dir[a.id] === "object", "第一条没拿到命名空间");
  assert.ok(dir[b.id] && typeof dir[b.id] === "object", "第二条没拿到命名空间");
  assert.equal(dir[a.id].tension, result.states[a.id].tension, "旧进度没搬过去");
  assert.equal(dir[b.id].悬疑, result.states[b.id].悬疑);
});

console.log("\n" + "=".repeat(50));
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
