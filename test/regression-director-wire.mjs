// test/regression-director-wire.mjs — 配方真的走进提示、状态真的被推进
//
// 引擎自己有 30 条测试（regression-director.mjs），但那证明的是**零件**能转。
// 这个文件证明**接上线**：配方绑到某一场上之后，
//   · 每轮的提示里真的多了那块约束
//   · 它排在动态尾部最后（在预设的收尾指令之后）
//   · 读的是**这一场自己的**进度，不是全局共享的一份
//   · 场没绑 / 配方被关 / 配方被删 → 一个字都不注入，而且生成不失败
//
// 最后一条最容易被忽略：配方是配置，配置出问题不该让聊天发不出去。

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

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 端到端 · 配方接进生成链路 ===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-director-wire-"));
const charRepo = new CharacterRepo(tmp); await charRepo.init();
const convRepo = new ConversationRepo(tmp); await convRepo.init();
const settingRepo = new SettingRepo(tmp); await settingRepo.init();
const directorRepo = new DirectorRepo(tmp); await directorRepo.init();

const repos = {
  conversationRepo: convRepo,
  characterRepo: charRepo,
  settingRepo,
  regexRepo: null,
  boardRepo: null,
  directorRepo
};

const ACT = {
  name: "三幕剧",
  state: {
    tension: { init: 1, min: 0, max: 10 },
    turn: { init: 0 },
    confessed: { init: false }
  },
  rules: [
    { when: "always", effect: "tension += 5" },
    { when: "always", effect: "turn += 1" },
    { when: "tension >= 10", effect: "tension = 2", brief: "触发一次不可逆事件" },
    { when: "tension >= 7", effect: "tension -= 4", brief: "必须出现一次正面冲突" }
  ]
};

const card = await charRepo.create({ name: "艾尔", description: "机甲训练官", first_mes: "「上机。」" });

async function build(convId, input = "我坐进了驾驶舱。") {
  await convRepo.addMessage(convId, "user", input);
  const fresh = await convRepo.get(convId);
  return buildGenerationInput(repos, fresh, card, input, {});
}

const MARK = "【导演 · 本轮】";

// ── ① 没绑 → 一个字都不进 ──────────────────────────────
await okAsync("这一场没绑配方 → 提示里没有导演块", async () => {
  const conv = await convRepo.create(card.id);
  const { systemPrompt } = await build(conv.id);
  assert.strictEqual(systemPrompt.includes(MARK), false);
});

// ── ② 绑上 → 进尾部，且排在最后 ─────────────────────────
await okAsync("绑上配方 → 导演块出现在提示里", async () => {
  const one = await directorRepo.create(ACT);
  const conv = await convRepo.create(card.id, { directorId: one.id });

  const { systemPrompt, meta } = await build(conv.id);
  assert.ok(systemPrompt.includes(MARK), "导演块没进提示");
  assert.ok(/tension 1\/10/.test(systemPrompt), "状态读数没进去：" + systemPrompt.slice(-400));
  assert.ok(/tension 到 7 时，必须出现一次正面冲突/.test(systemPrompt), "约束没列出来");
  assert.ok(/覆盖本轮的一切收尾指令/.test(systemPrompt), "少了覆盖声明");
  fs.writeFileSync(path.join(tmp, "conv-id.txt"), conv.id);
});

await okAsync("导演块排在动态尾部**最后**（更靠后于其他尾部块）", async () => {
  const one = (await directorRepo.list())[0];
  const conv = await convRepo.create(card.id, { directorId: one.id });
  // 造一个会进尾部的世界书条目：关键词命中
  const { stWorldBookToSettings } = await import("../lib/settings/import.js");
  const settings = stWorldBookToSettings({
    entries: { 0: { uid: 0, key: ["驾驶舱"], content: "驾驶舱的座椅会贴合脊柱。", position: 1, order: 100 } }
  });
  await settingRepo.importSettings(settings);

  const { systemPrompt } = await build(conv.id, "我坐进了驾驶舱。");
  const loreAt = systemPrompt.indexOf("## 世界设定");
  const dirAt = systemPrompt.indexOf(MARK);
  assert.ok(loreAt >= 0, "世界书没进提示，这条测不到顺序");
  assert.ok(dirAt > loreAt, "导演块该在世界书之后（越靠后越贴近本轮）");
});

// ── ③ 进度是这一场自己的 ───────────────────────────────
await okAsync("进度存在这一场自己的变量里，两场互不覆盖", async () => {
  const one = (await directorRepo.list())[0];
  const a = await convRepo.create(card.id, { directorId: one.id });
  const b = await convRepo.create(card.id, { directorId: one.id });

  await convRepo.updateVariables(a.id, { __dir: { tension: 9, turn: 3, confessed: true } });

  const outA = await build(a.id, "甲。");
  const outB = await build(b.id, "乙。");
  assert.ok(/tension 9\/10/.test(outA.systemPrompt), "A 场没读到自己的进度");
  assert.ok(/tension 1\/10/.test(outB.systemPrompt), "B 场被 A 场的进度污染了：" + (outB.systemPrompt.match(/tension \d+\/10/) || [])[0]);
  assert.ok(/confessed/.test(outA.systemPrompt), "开关为真时该露出来");
  assert.ok(!/confessed/.test(outB.systemPrompt), "B 场不该有 A 场的开关");
});

await okAsync("预演越线的那一轮被标成 ▶ 本轮", async () => {
  const one = (await directorRepo.list())[0];
  const conv = await convRepo.create(card.id, { directorId: one.id });
  await convRepo.updateVariables(conv.id, { __dir: { tension: 6, turn: 0, confessed: false } });
  const { systemPrompt } = await build(conv.id, "再来。");
  // 6 + 5 = 11 → 越 10 → 不可逆事件该被点名
  assert.ok(/▶ 本轮：tension 到 10 时，触发一次不可逆事件/.test(systemPrompt),
    "该点名的那条没被标出来：\n" + systemPrompt.slice(-500));
});

// ── ④ 配置出问题不该让生成失败 ──────────────────────────
await okAsync("配方被关掉 → 不注入，但生成照常", async () => {
  const one = await directorRepo.create({ ...ACT, name: "关着的配方" });
  await directorRepo.update(one.id, { enabled: false });
  const conv = await convRepo.create(card.id, { directorId: one.id });
  const { systemPrompt } = await build(conv.id, "喂。");
  assert.strictEqual(systemPrompt.includes(MARK), false);
});

await okAsync("绑的配方被删了 → 不注入、不抛", async () => {
  const one = await directorRepo.create({ ...ACT, name: "命短的配方" });
  const conv = await convRepo.create(card.id, { directorId: one.id });
  await directorRepo.remove(one.id);
  const { systemPrompt } = await build(conv.id, "喂。");
  assert.strictEqual(systemPrompt.includes(MARK), false);
});

// ── ⑤ 路由：CRUD + 换绑 + 试算 ──────────────────────────
const app = makeApp();
registerDirectorRoutes(app, directorRepo);
registerConversationRoutes(app, convRepo, null, charRepo, settingRepo, null, null, null, { directorRepo });

await okAsync("**契约**：POST /directors 存下配方、GET 读得回", async () => {
  const r = await request(app, "POST", "/directors", { body: { ...ACT, name: "路由建的配方" } });
  assert.strictEqual(r.status, 200, `状态 ${r.status}（${r.error || ""}）`);
  const id = r.data?.id || r.data?.data?.id;
  assert.ok(id, "没回 id：" + JSON.stringify(r.data).slice(0, 120));

  const g = await request(app, "GET", "/directors/" + id);
  assert.strictEqual(g.status, 200);
  assert.strictEqual((g.data?.data || g.data).name, "路由建的配方");
});

await okAsync("**契约**：写错的规则存不进去，且错误里带得出问题", async () => {
  const bad = await request(app, "POST", "/directors", {
    body: { name: "坏配方", state: { a: { init: 0 } }, rules: [{ when: "always", effect: "b += 1" }] }
  });
  assert.notStrictEqual(bad.status, 200, "坏配方不该存成功");
  assert.ok(/没在 state 里声明/.test(String(bad.error || "")), "错误话没带出问题：" + bad.error);
});

await okAsync("**契约**：PATCH /conversations/:id/director 换绑、解绑、绑到不存在的配方要拦", async () => {
  const one = (await directorRepo.list())[0];
  const conv = await convRepo.create(card.id);

  const bind = await request(app, "PATCH", `/conversations/${conv.id}/director`, { body: { directorId: one.id } });
  assert.strictEqual(bind.status, 200, `绑定失败：${bind.error || ""}`);
  assert.strictEqual((await convRepo.get(conv.id)).directorId, one.id);

  const miss = await request(app, "PATCH", `/conversations/${conv.id}/director`, { body: { directorId: "不存在" } });
  assert.notStrictEqual(miss.status, 200, "绑到不存在的配方该拦下来");

  const off = await request(app, "PATCH", `/conversations/${conv.id}/director`, { body: { directorId: "" } });
  assert.strictEqual(off.status, 200);
  assert.strictEqual((await convRepo.get(conv.id)).directorId, "", "解绑没生效");
});

await okAsync("**契约**：POST /directors/:id/simulate 试算一轮（不落盘）", async () => {
  const one = await directorRepo.create({ ...ACT, name: "试算用" });
  const r = await request(app, "POST", `/directors/${one.id}/simulate`, {
    body: { state: { tension: 6, turn: 0, confessed: false }, text: "他直接冲了进去。\n[状态 tension+2 flag:confessed]" }
  });
  assert.strictEqual(r.status, 200, `试算失败：${r.error || ""}`);
  const d = r.data?.data || r.data;
  assert.strictEqual(d.next.confessed, true, "上报的开关没生效");
  assert.ok(d.block.includes(MARK), "试算该连注入块一起给出来");
  // 落盘没被动过
  const after = await directorRepo.get(one.id);
  assert.deepStrictEqual(after.state, ACT.state, "试算不该改配置");
});

await okAsync("**契约**：POST /directors/validate 校验草稿（新建时没有 id 也能查）", async () => {
  const good = await request(app, "POST", "/directors/validate", { body: { state: ACT.state, rules: ACT.rules } });
  assert.strictEqual(good.status, 200, `校验没跑起来：${good.error || ""}`);
  const g = good.data?.data || good.data;
  assert.strictEqual(g.ok, true, "好配方被报了问题：" + JSON.stringify(g.problems));
  assert.strictEqual(g.ruleCount, 4);
  assert.ok(g.block.includes(MARK), "校验通过时该连注入块一起给出来");

  const bad = await request(app, "POST", "/directors/validate", {
    body: { state: { a: { init: 0 } }, rules: [{ when: "b >= 1", effect: "a += 1" }] }
  });
  assert.strictEqual(bad.status, 200, "校验失败不该是一个 HTTP 错——它就是没通过");
  const b = bad.data?.data || bad.data;
  assert.strictEqual(b.ok, false);
  assert.ok(b.problems.some(p => /"b".*没在 state 里声明/.test(p)), "没抓到错：" + JSON.stringify(b.problems));
  assert.strictEqual(b.block, "", "结构没对就不该渲染注入块——给一份跑不起来的样例更误导人");
});

await okAsync("校验能拿这一场的真实进度预演，不总是从初值算", async () => {
  const one = await directorRepo.create({ ...ACT, name: "预演用" });
  const conv = await convRepo.create(card.id, { directorId: one.id });
  await convRepo.updateVariables(conv.id, { __dir: { tension: 6, turn: 0, confessed: false } });

  const r = await request(app, "POST", "/directors/validate", {
    body: { state: ACT.state, rules: ACT.rules, previewState: { tension: 6, turn: 0, confessed: false } }
  });
  const d = r.data?.data || r.data;
  assert.ok(/tension 6\/10/.test(d.summary), "没拿传进来的状态算：" + d.summary);
  // 6 + 5 = 11，越 10 → 那条该被点名
  assert.ok(/▶ 本轮：tension 到 10 时，触发一次不可逆事件/.test(d.block), "预演没越过线：\n" + d.block);
});

await okAsync("换绑不碰进度（实体是配置、状态是会话的）", async () => {
  const a = await directorRepo.create({ ...ACT, name: "旧配方" });
  const b = await directorRepo.create({ ...ACT, name: "新配方" });
  const conv = await convRepo.create(card.id, { directorId: a.id });
  await convRepo.updateVariables(conv.id, { __dir: { tension: 7, turn: 2, confessed: true } });

  await request(app, "PATCH", `/conversations/${conv.id}/director`, { body: { directorId: b.id } });
  const after = await convRepo.get(conv.id);
  assert.strictEqual(after.variables.__dir.tension, 7, "换绑把进度抹了");
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
