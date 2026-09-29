// test/regression-codex-c3.mjs — C3 角色百科三件套回归
//
// 覆盖：
//   · relations 表 CRUD（lib/codex/relations.json + conv.codexRelations）
//   · powers 表 CRUD（lib/codex/powers.json + conv.codexPowers）
//   · characters/:id/profile 读写（挂 extensions.profile）
//
// 红线：
//   · relation from/to 允许空 / 允许不存在（关系图可能连待建实体）
//   · power value / max 允许 null（未知不编 0）
//   · profile 缺字段回默认，不改卡其它字段
//   · profile 路由必须在 /characters/:id 之前注册（否则 :id="profile" 会误吸）

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  createRelation, normalizeRelation, RelationIdPrefix,
  createPower, normalizePower
} = await import("../lib/codex/model.js");
const { CodexRepo } = await import("../lib/codex/repo.js");
const { registerCodexRoutes } = await import("../lib/codex/routes.js");
const { normalizeProfile, attachProfile } = await import("../lib/characters/model.js");
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

async function freshSetup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-c3-"));
  const convsDir = path.join(dataDir, "conversations");
  fs.mkdirSync(convsDir, { recursive: true });
  const convId = "conv-c3-1";
  fs.writeFileSync(
    path.join(convsDir, `${convId}.json`),
    JSON.stringify({ id: convId, characterId: "c", variables: {}, messages: [] }),
    "utf8"
  );
  return { dataDir, convId };
}
function cleanup(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

console.log("\n=== 角色百科（C3）===\n");

// ── model: relations ───────────────────────────────

ok("model：createRelation 默认字段", () => {
  const r = createRelation({ from: "p_a", to: "p_b", kind: "师徒" });
  assert.equal(r.from, "p_a");
  assert.equal(r.to, "p_b");
  assert.equal(r.kind, "师徒");
  assert.equal(r.direction, "undirected");
  assert.equal(r.strength, null);
  assert.equal(r.source, "manual");
  assert.ok(r.id);
});

ok("model：normalizeRelation 未知 direction 回默认 undirected", () => {
  const r = normalizeRelation({ from: "p_a", to: "p_b", direction: "bogus" });
  assert.equal(r.direction, "undirected");
});

ok("model：normalizeRelation strength 越界夹到 [-100, 100]", () => {
  assert.equal(normalizeRelation({ from: "a", to: "b", strength: 500 }).strength, 100);
  assert.equal(normalizeRelation({ from: "a", to: "b", strength: -500 }).strength, -100);
  assert.equal(normalizeRelation({ from: "a", to: "b", strength: null }).strength, null);
});

ok("RelationIdPrefix 三枚：p_ / pl_ / f_", () => {
  assert.equal(RelationIdPrefix.PERSON, "p_");
  assert.equal(RelationIdPrefix.PLACE, "pl_");
  assert.equal(RelationIdPrefix.FACTION, "f_");
});

// ── model: powers ────────────────────────────────

ok("model：createPower 默认字段", () => {
  const p = createPower({ personId: "p_1", system: "魔法", axis: "攻击", value: 8 });
  assert.equal(p.personId, "p_1");
  assert.equal(p.system, "魔法");
  assert.equal(p.axis, "攻击");
  assert.equal(p.value, 8);
  assert.equal(p.max, null);
  assert.equal(p.source, "manual");
});

ok("model：normalizePower value 非数字回 null（不夹到 0）", () => {
  assert.equal(normalizePower({ value: "abc" }).value, null);
  assert.equal(normalizePower({ value: "  " }).value, null);
  assert.equal(normalizePower({ value: 12.5 }).value, 12.5);
});

ok("model：normalizePower personId 空 → null", () => {
  assert.equal(normalizePower({ personId: "" }).personId, null);
  assert.equal(normalizePower({ personId: "p_1" }).personId, "p_1");
});

// ── repo：relations CRUD ─────────────────────────

await okAsync("repo：relations create + list 往返", async () => {
  const { dataDir } = await freshSetup();
  const repo = await new CodexRepo(dataDir).init();
  await repo.create("relations", { from: "p_a", to: "p_b", kind: "师徒" });
  await repo.create("relations", { from: "p_b", to: "p_c", kind: "宿敌" });
  const list = await repo.list("relations");
  assert.equal(list.length, 2);
  assert.ok(list.find(r => r.kind === "师徒"));
  cleanup(dataDir);
});

await okAsync("repo：relations 改寿命从 world 搬到 chat", async () => {
  const { dataDir, convId } = await freshSetup();
  const repo = await new CodexRepo(dataDir).init();
  const r = await repo.create("relations", { from: "p_a", to: "p_b", kind: "朋友" });
  // 改成 chat 级
  const updated = await repo.update("relations", r.id, { lifespan: "chat" }, convId);
  assert.equal(updated.lifespan, "chat");
  // world 里已经没了
  const worldList = await repo.listWorld("relations");
  assert.ok(!worldList.find(x => x.id === r.id));
  // chat 里有
  const chatList = await repo.listChat("relations", convId);
  assert.ok(chatList.find(x => x.id === r.id));
  cleanup(dataDir);
});

await okAsync("repo：relations update 局部字段不清空其它", async () => {
  const { dataDir } = await freshSetup();
  const repo = await new CodexRepo(dataDir).init();
  const r = await repo.create("relations", {
    from: "p_a", to: "p_b", kind: "朋友", strength: 30, note: "初识"
  });
  await repo.update("relations", r.id, { strength: 50 });
  const again = await repo.get("relations", r.id);
  assert.equal(again.from, "p_a", "from 不该被清");
  assert.equal(again.kind, "朋友", "kind 不该被清");
  assert.equal(again.note, "初识", "note 不该被清");
  assert.equal(again.strength, 50);
  cleanup(dataDir);
});

// ── repo：powers CRUD ────────────────────────────

await okAsync("repo：powers create + list 往返", async () => {
  const { dataDir } = await freshSetup();
  const repo = await new CodexRepo(dataDir).init();
  await repo.create("powers", { personId: "p_1", system: "魔法", axis: "攻击", value: 8 });
  await repo.create("powers", { personId: "p_1", system: "魔法", axis: "防御", value: 5 });
  await repo.create("powers", { personId: "p_1", system: "武技", axis: "攻击", value: 6 });
  const list = await repo.list("powers");
  assert.equal(list.length, 3);
  cleanup(dataDir);
});

await okAsync("repo：powers delete", async () => {
  const { dataDir } = await freshSetup();
  const repo = await new CodexRepo(dataDir).init();
  const p = await repo.create("powers", { personId: "p_1", system: "魔法", axis: "攻击", value: 8 });
  const removed = await repo.delete("powers", p.id);
  assert.equal(removed, true);
  const list = await repo.list("powers");
  assert.equal(list.length, 0);
  cleanup(dataDir);
});

// ── characters profile ───────────────────────────

ok("model：normalizeProfile 空对象补默认", () => {
  const p = normalizeProfile({});
  assert.equal(p.profession, "");
  assert.equal(p.factionId, null);
  assert.deepEqual(p.gear, []);
  assert.deepEqual(p.abilityAxes, []);
});

ok("model：normalizeProfile 过滤坏 gear / axis", () => {
  const p = normalizeProfile({
    gear: [null, { name: "" }, { name: "匕首" }, { name: 42 }],
    abilityAxes: [null, { name: "" }, { name: "攻击", value: 8 }, { name: "防御", value: "abc" }]
  });
  assert.equal(p.gear.length, 1);
  assert.equal(p.gear[0].name, "匕首");
  assert.equal(p.abilityAxes.length, 2);
  assert.equal(p.abilityAxes[1].value, null, "非数字 value 回 null");
});

ok("model：attachProfile 只写 extensions.profile，不动其它字段", () => {
  const card = {
    id: "c1",
    name: "Alice",
    description: "hello",
    extensions: { other: 1 },
    tags: ["x"]
  };
  const updated = attachProfile(card, { profession: "Mage" });
  assert.equal(updated.id, "c1");
  assert.equal(updated.name, "Alice");
  assert.equal(updated.extensions.other, 1, "已有 extensions 字段不该丢");
  assert.equal(updated.extensions.profile.profession, "Mage");
  assert.deepEqual(updated.tags, ["x"]);
});

// ── routes：profile 必须在 /:id 之前注册 ──────────

await okAsync("routes：characters/:id/profile 打得到（不被 /:id 误吸）", async () => {
  // 用一个假的 characters repo
  const fakeRepo = {
    async get(id) {
      return { id, name: "X", extensions: {}, tags: [] };
    },
    async update(id, body) {
      return { id, ...body, _updated: true };
    }
  };
  const app = makeApp();
  // 只注册 characters routes 的 profile 两条（跳过 avatar/import 等重依赖）
  const { registerCharacterRoutes } = await import("../lib/characters/routes.js");
  registerCharacterRoutes(app, fakeRepo, { readAvatar: async () => null }, null);
  const r = await request(app, "GET", "/characters/c1/profile");
  assert.ok(r.ok === true, `status=${r.status} error=${r.error}`);
  assert.equal(r.data.profession, "");
  assert.deepEqual(r.data.gear, []);
});

await okAsync("routes：PUT /characters/:id/profile 能写回 extensions", async () => {
  const fakeRepo = {
    stored: null,
    async get(id) { return { id, name: "X", extensions: {}, tags: [] }; },
    async update(id, body) {
      this.stored = body;
      return { id, extensions: body.extensions, _updated: true };
    }
  };
  const app = makeApp();
  const { registerCharacterRoutes } = await import("../lib/characters/routes.js");
  registerCharacterRoutes(app, fakeRepo, { readAvatar: async () => null }, null);
  const r = await request(app, "PUT", "/characters/c1/profile", {
    body: { profession: "Hunter", abilityAxes: [{ name: "攻击", value: 8 }] }
  });
  assert.ok(r.ok === true, `status=${r.status} error=${r.error}`);
  assert.equal(fakeRepo.stored.extensions.profile.profession, "Hunter");
  assert.equal(fakeRepo.stored.extensions.profile.abilityAxes.length, 1);
});

// ── routes：codex relations / powers ────────────

await okAsync("routes：codex/relations 列表", async () => {
  const { dataDir } = await freshSetup();
  const repo = await new CodexRepo(dataDir).init();
  await repo.create("relations", { from: "p_a", to: "p_b", kind: "师徒" });
  const app = makeApp();
  registerCodexRoutes(app, repo);
  const r = await request(app, "GET", "/codex/relations");
  assert.ok(r.ok === true);
  assert.equal(r.data.merged.length, 1);
  cleanup(dataDir);
});

await okAsync("routes：codex/relations 新建", async () => {
  const { dataDir } = await freshSetup();
  const repo = await new CodexRepo(dataDir).init();
  const app = makeApp();
  registerCodexRoutes(app, repo);
  const r = await request(app, "POST", "/codex/relations", {
    body: { from: "p_a", to: "pl_x", kind: "出身", direction: "directed", strength: 60 }
  });
  assert.ok(r.ok === true);
  assert.equal(r.data.from, "p_a");
  assert.equal(r.data.to, "pl_x");
  assert.equal(r.data.strength, 60);
  cleanup(dataDir);
});

await okAsync("routes：codex/powers CRUD", async () => {
  const { dataDir } = await freshSetup();
  const repo = await new CodexRepo(dataDir).init();
  const app = makeApp();
  registerCodexRoutes(app, repo);
  const create = await request(app, "POST", "/codex/powers", {
    body: { personId: "p_1", system: "魔法", axis: "攻击", value: 8, max: 10 }
  });
  assert.ok(create.ok === true);
  const id = create.data.id;
  const list = await request(app, "GET", "/codex/powers");
  assert.equal(list.data.merged.length, 1);
  const upd = await request(app, "PUT", `/codex/powers/${id}`, { body: { value: 9 } });
  assert.ok(upd.ok === true);
  assert.equal(upd.data.value, 9);
  assert.equal(upd.data.max, 10, "max 不该被清");
  const del = await request(app, "DELETE", `/codex/powers/${id}`);
  assert.ok(del.ok === true);
  cleanup(dataDir);
});

// ── 汇总 ──────────────────────────────────────────

console.log(`\n通过 ${pass} / 失败 ${fail}\n`);
if (fail > 0) process.exit(1);
