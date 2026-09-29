// test/regression-codex-repo.mjs — 图鉴（C1）仓储与路由回归
//
// 三张表：persons / places / factions。
// 三条验收（对齐 data-model.md 一页纸）：
//   · 读侧 normalize：坏值回默认，不写迁移（老文件也能读）
//   · 寿命两级：world 与 chat 都能建、能读、能改、能删；改寿命会搬家
//   · persons.notes 追加制：只加不改，只走 POST /codex/persons/:id/notes
//
// 加红线：source 全部 "manual"（extract 是二期）；图鉴不互嵌角色卡。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { CodexLifespan, CodexSource } = await import("../lib/codex/model.js");
const { createCodexRepo } = await import("../lib/codex/repo.js");
const { registerCodexRoutes } = await import("../lib/codex/routes.js");
const { makeApp, request } = await import("./lib/route-harness.mjs");

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

/** 起一个临时 dataDir + 一个假对话文件（对话级存储要用）。 */
async function freshSetup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-codex-"));
  const convsDir = path.join(dataDir, "conversations");
  fs.mkdirSync(convsDir, { recursive: true });
  // 假一场对话，方便测 chat 级
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

console.log("\n=== 图鉴（C1）===\n");

// ── 建条目：三种实体 ─────────────────────────────────

await okAsync("create：persons 默认字段（source=manual, lifespan=world, affinity=null）", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  const p = await repo.create("persons", { name: "李玥", tags: ["皇室"] });
  assert.equal(p.name, "李玥");
  assert.equal(p.lifespan, CodexLifespan.WORLD);
  assert.equal(p.affinity, null, "未知 = null，不编 0");
  assert.equal(p.source, CodexSource.MANUAL);
  assert.deepEqual(p.tags, ["皇室"]);
  assert.equal(p.characterId, null);
  assert.deepEqual(p.notes, []);
  cleanup(dataDir);
});

await okAsync("create：places 支持 parentId", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  const p = await repo.create("places", { name: "皇宫" });
  const g = await repo.create("places", { name: "御花园", parentId: p.id, description: "假山" });
  assert.equal(g.parentId, p.id);
  assert.equal(g.description, "假山");
  assert.equal(g.situation, "");
  cleanup(dataDir);
});

await okAsync("create：factions 只有四格", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  const f = await repo.create("factions", { name: "禁军", description: "宫廷武力", tags: ["皇室"] });
  assert.equal(f.name, "禁军");
  assert.equal(f.description, "宫廷武力");
  assert.deepEqual(f.tags, ["皇室"]);
  // factions 不该有人物/地点的字段
  assert.equal(f.characterId, undefined);
  assert.equal(f.affinity, undefined);
  assert.equal(f.parentId, undefined);
  cleanup(dataDir);
});

// ── 寿命两级 ─────────────────────────────────────────

await okAsync("寿命两级：chat 级条目需要 conversationId", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  await assert.rejects(
    () => repo.create("persons", { name: "酒馆老板", lifespan: "chat" }),
    /conversationId/,
    "缺 conversationId 应报错"
  );
  cleanup(dataDir);
});

await okAsync("寿命两级：chat 级写入对话文件", async () => {
  const { dataDir, convId } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  const p = await repo.create("persons", { name: "酒馆老板", lifespan: "chat" }, convId);
  // 对话文件里能读到
  const conv = JSON.parse(fs.readFileSync(path.join(dataDir, "conversations", `${convId}.json`), "utf8"));
  assert.equal(conv.codexPersons.length, 1);
  assert.equal(conv.codexPersons[0].id, p.id);
  // 世界级文件里查不到
  const worldPersons = JSON.parse(fs.readFileSync(path.join(dataDir, "codex", "persons.json"), "utf8"));
  assert.equal(worldPersons.length, 0);
  cleanup(dataDir);
});

await okAsync("list：合并两块盘（world 在前，chat 在后）", async () => {
  const { dataDir, convId } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  await repo.create("persons", { name: "A", lifespan: "world" });
  const b = await repo.create("persons", { name: "B", lifespan: "chat" }, convId);
  const merged = await repo.list("persons", convId);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].name, "A");
  assert.equal(merged[1].name, "B");
  assert.equal(merged[1].lifespan, "chat");
  cleanup(dataDir);
});

await okAsync("update：改寿命会搬家（world → chat）", async () => {
  const { dataDir, convId } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  const p = await repo.create("persons", { name: "X", lifespan: "world" });
  // 先在世界级
  const worldBefore = await repo.listWorld("persons");
  assert.equal(worldBefore.length, 1);
  assert.equal(worldBefore[0].id, p.id);

  const next = await repo.update("persons", p.id, { lifespan: "chat" }, convId);
  assert.equal(next.lifespan, "chat");

  // 搬家了
  const worldAfter = await repo.listWorld("persons");
  assert.equal(worldAfter.length, 0, "world 里应该没了");
  const chatAfter = await repo.listChat("persons", convId);
  assert.equal(chatAfter.length, 1);
  assert.equal(chatAfter[0].id, p.id);
  cleanup(dataDir);
});

await okAsync("update：改寿命为 chat 但没给 conversationId → 报错", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  const p = await repo.create("persons", { name: "Y", lifespan: "world" });
  await assert.rejects(
    () => repo.update("persons", p.id, { lifespan: "chat" }),
    /conversationId/
  );
  cleanup(dataDir);
});

await okAsync("update：局部字段合并，不清空其它字段", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  await repo.create("persons", { name: "M", tags: ["皇室"], affinity: 30 });
  // 只改 attitude，不该清 tags 与 affinity
  const all = await repo.listWorld("persons");
  const next = await repo.update("persons", all[0].id, { attitude: "戒备" });
  assert.equal(next.attitude, "戒备");
  assert.deepEqual(next.tags, ["皇室"]);
  assert.equal(next.affinity, 30);
  cleanup(dataDir);
});

// ── 删除 ─────────────────────────────────────────────

await okAsync("delete：先从 world 找，找不到再去 chat", async () => {
  const { dataDir, convId } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  const w = await repo.create("persons", { name: "w", lifespan: "world" });
  const c = await repo.create("persons", { name: "c", lifespan: "chat" }, convId);

  assert.equal(await repo.delete("persons", w.id), true);
  assert.equal(await repo.delete("persons", c.id, convId), true);
  assert.equal(await repo.delete("persons", "not-exists", convId), false);
  cleanup(dataDir);
});

// ── persons.notes 追加制 ─────────────────────────────

await okAsync("appendNote：只加不改，不动其它字段", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  const p = await repo.create("persons", { name: "李", notes: [] });

  const r1 = await repo.appendNote(p.id, { text: "中秋宴上替主角解围", conversationId: "conv-1" });
  assert.equal(r1.notes.length, 1);
  assert.equal(r1.notes[0].text, "中秋宴上替主角解围");

  const r2 = await repo.appendNote(p.id, { text: "第二件事" });
  assert.equal(r2.notes.length, 2);
  assert.equal(r2.notes[0].text, "中秋宴上替主角解围", "旧条目还在");
  assert.equal(r2.notes[1].text, "第二件事");
  // 其它字段没动
  assert.equal(r2.name, "李");
  cleanup(dataDir);
});

await okAsync("appendNote：空文本 / 找不到条目 → 返回 null", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  await repo.create("persons", { name: "李" });

  const r = await repo.appendNote("not-exists", { text: "test" });
  assert.equal(r, null);
  cleanup(dataDir);
});

// ── 读侧 normalize（不做迁移）───────────────────────

await okAsync("normalize：老文件缺字段也能读，不炸", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  // 手写一份"最小"人物到盘上
  const worldFile = path.join(dataDir, "codex", "persons.json");
  fs.writeFileSync(worldFile, JSON.stringify([{
    id: "p-old",
    name: "老条目"
    // 缺 lifespan、affinity、tags、notes、characterId、source、createdAt、updatedAt
  }]), "utf8");

  const list = await repo.listWorld("persons");
  assert.equal(list.length, 1);
  const p = list[0];
  assert.equal(p.id, "p-old");
  assert.equal(p.name, "老条目");
  assert.equal(p.lifespan, "world", "缺 lifespan → 默认 world");
  assert.equal(p.affinity, null, "缺 affinity → null");
  assert.deepEqual(p.tags, []);
  assert.deepEqual(p.notes, []);
  assert.equal(p.characterId, null);
  assert.equal(p.source, "manual");
  assert.ok(p.createdAt && p.updatedAt, "缺 createdAt/updatedAt → 补上");
  cleanup(dataDir);
});

await okAsync("normalize：坏 affinity 归到 null，不产出 NaN", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  const worldFile = path.join(dataDir, "codex", "persons.json");
  fs.writeFileSync(worldFile, JSON.stringify([
    { id: "p1", name: "A", affinity: "abc" },
    { id: "p2", name: "B", affinity: 9999 },
    { id: "p3", name: "C", affinity: -50 }
  ]), "utf8");
  const list = await repo.listWorld("persons");
  assert.equal(list[0].affinity, null);
  assert.equal(list[1].affinity, 100, "越上界夹到 100");
  assert.equal(list[2].affinity, -50);
  cleanup(dataDir);
});

// ── 红线 ────────────────────────────────────────────

await okAsync("红线：source 只有 manual / extract / import 三个枚举", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  const p = await repo.create("persons", { name: "X", source: "weird-source" });
  assert.equal(p.source, "manual", "未知 source 回 default");
  cleanup(dataDir);
});

// ── 路由层：GET/POST/PUT/DELETE + notes ─────────────

await okAsync("路由：GET /codex/persons 返回 { world, chat, merged }", async () => {
  const { dataDir, convId } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  await repo.create("persons", { name: "w", lifespan: "world" });
  await repo.create("persons", { name: "c", lifespan: "chat" }, convId);

  const app = makeApp();
  registerCodexRoutes(app, repo);

  const r = await request(app, "GET", "/codex/persons", { query: { conversationId: convId } });
  assert.equal(r.ok, true);
  assert.equal(r.data.world.length, 1);
  assert.equal(r.data.chat.length, 1);
  assert.equal(r.data.merged.length, 2);
  cleanup(dataDir);
});

await okAsync("路由：POST 建 / PUT 改 / DELETE 删", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  const app = makeApp();
  registerCodexRoutes(app, repo);

  const c1 = await request(app, "POST", "/codex/factions", {
    body: { name: "禁军", description: "宫廷武力", tags: ["皇室"] }
  });
  assert.equal(c1.ok, true);
  const id = c1.data.id;

  const u1 = await request(app, "PUT", `/codex/factions/${id}`, {
    body: { name: "御林军" }
  });
  assert.equal(u1.ok, true);
  assert.equal(u1.data.name, "御林军");
  assert.equal(u1.data.description, "宫廷武力", "其它字段没被清");

  const d1 = await request(app, "DELETE", `/codex/factions/${id}`);
  assert.equal(d1.ok, true);
  cleanup(dataDir);
});

await okAsync("路由：GET 404（找不到返回 notFound）", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  const app = makeApp();
  registerCodexRoutes(app, repo);

  const r = await request(app, "GET", "/codex/persons/not-exists");
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  cleanup(dataDir);
});

await okAsync("路由：POST /codex/persons/:id/notes 追加一条", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  const p = await repo.create("persons", { name: "李" });
  const app = makeApp();
  registerCodexRoutes(app, repo);

  const r = await request(app, "POST", `/codex/persons/${p.id}/notes`, {
    body: { text: "第一件" }
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.notes.length, 1);
  assert.equal(r.data.notes[0].text, "第一件");
  cleanup(dataDir);
});

await okAsync("路由：五张表各四条 CRUD + persons 额外一条 notes", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createCodexRepo(dataDir).init();
  const app = makeApp();
  registerCodexRoutes(app, repo);
  // 五张表 × 5 条（GET list / GET single / POST / PUT / DELETE）= 25；
  // 再加 1 条 persons notes = 26 条注册
  const codexRoutes = app.routes.filter(r => r.path.startsWith("/codex/"));
  assert.equal(codexRoutes.length, 26);
  cleanup(dataDir);
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
