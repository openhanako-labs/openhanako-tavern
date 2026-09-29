// test/regression-ops.mjs — 操作与结算（C2）回归
//
// 五条验收（对齐 data-model.md §二 & AIRP 06）：
//   · 操作是世界级；待执行项是对话级
//   · normalize：坏值回默认，不改盘上文件
//   · 结算：delta/set 走 variableRepo.updateVariables（不另开账）
//   · 结算失败不吞错（unknown op / bad pair 都要有回音）
//   · 结算后 pending 里的条目被抹掉（一次正文对应一批）
//
// 红线：变量账「从状态长出来」——settle 只调 updateVariables。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { OpSource, createOp, normalizeOp, createPending, normalizePending, sortOps, sortPending } = await import("../lib/ops/model.js");
const { OpsRepo, createOpsRepo } = await import("../lib/ops/repo.js");
const { parseOpsReport, settleOps, composePendingBlock } = await import("../lib/ops/engine.js");
const { registerOpsRoutes } = await import("../lib/ops/routes.js");
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-ops-"));
  const convsDir = path.join(dataDir, "conversations");
  fs.mkdirSync(convsDir, { recursive: true });
  const convId = "conv-ops-1";
  fs.writeFileSync(
    path.join(convsDir, `${convId}.json`),
    JSON.stringify({ id: convId, characterId: "c", variables: { hp: 100, mp: 50 }, messages: [] }),
    "utf8"
  );
  return { dataDir, convId };
}
function cleanup(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

console.log("\n=== 操作与结算（C2）===\n");

// ── model ────────────────────────────────────────────

ok("model：createOp 默认字段（name='', costVar=null, source=manual, tags=[]）", () => {
  const o = createOp({ name: "攻击" });
  assert.equal(o.name, "攻击");
  assert.equal(o.costVar, null);
  assert.equal(o.summary, "");
  assert.deepEqual(o.tags, []);
  assert.equal(o.source, OpSource.MANUAL);
  assert.ok(o.id);
  assert.ok(o.createdAt);
});

ok("model：normalizeOp 修正 name 去空格 / 未知 source 回默认", () => {
  const o = normalizeOp({ name: "  潜行  ", source: "???", costVar: "   " });
  assert.equal(o.name, "潜行");
  assert.equal(o.costVar, null);
  assert.equal(o.source, OpSource.MANUAL);
});

ok("model：normalizePending 缺字段兜底", () => {
  const p = normalizePending({ opId: "op_1" });
  assert.equal(p.opId, "op_1");
  assert.ok(p.id);
  assert.ok(p.selectedAt);
  assert.equal(p.note, "");
});

ok("sortOps / sortPending：稳定排序", () => {
  const ops = [
    { id: "a", name: "gamma" }, { id: "b", name: "alpha" }, { id: "c", name: "beta" }
  ];
  const sorted = sortOps(ops);
  assert.deepEqual(sorted.map(x => x.name), ["alpha", "beta", "gamma"]);

  const pend = [
    { id: "x", selectedAt: "2026-09-29T01:00:00.000Z" },
    { id: "y", selectedAt: "2026-09-29T00:00:00.000Z" }
  ];
  assert.equal(sortPending(pend)[0].id, "y");
});

// ── repo：ops CRUD ───────────────────────────────────

await okAsync("repo：createOp + listOps 往返一致", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createOpsRepo(dataDir).init();
  await repo.createOp({ name: "攻击", costVar: "体力", summary: "对目标造成伤害" });
  await repo.createOp({ name: "施法", costVar: "mp" });
  const list = await repo.listOps();
  assert.equal(list.length, 2);
  assert.ok(list.find(o => o.name === "攻击"));
  cleanup(dataDir);
});

await okAsync("repo：updateOp 局部更新不会清空其它字段", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createOpsRepo(dataDir).init();
  const o = await repo.createOp({ name: "攻击", costVar: "体力", summary: "造成伤害" });
  await repo.updateOp(o.id, { summary: "造成更大伤害" });
  const again = await repo.getOp(o.id);
  assert.equal(again.name, "攻击", "name 不该被清");
  assert.equal(again.costVar, "体力", "costVar 不该被清");
  assert.equal(again.summary, "造成更大伤害");
  cleanup(dataDir);
});

await okAsync("repo：deleteOp 从盘上抹掉", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createOpsRepo(dataDir).init();
  const o = await repo.createOp({ name: "潜行" });
  const removed = await repo.deleteOp(o.id);
  assert.equal(removed, true);
  const list = await repo.listOps();
  assert.equal(list.length, 0);
  cleanup(dataDir);
});

// ── repo：pending 对话级 ─────────────────────────────

await okAsync("repo：addPending + listPending + removePendingByOp", async () => {
  const { dataDir, convId } = await freshSetup();
  const repo = await createOpsRepo(dataDir).init();
  const op = await repo.createOp({ name: "攻击" });
  await repo.addPending(convId, { opId: op.id, note: "第一下" });
  await repo.addPending(convId, { opId: op.id });

  let list = await repo.listPending(convId);
  assert.equal(list.length, 2);
  assert.equal(list[0].note, "第一下", "sortPending 按 selectedAt 升序");

  const removed = await repo.removePendingByOp(convId, op.id);
  assert.equal(removed, 2);
  list = await repo.listPending(convId);
  assert.equal(list.length, 0);
  cleanup(dataDir);
});

await okAsync("repo：clearPending 一次清光", async () => {
  const { dataDir, convId } = await freshSetup();
  const repo = await createOpsRepo(dataDir).init();
  const op = await repo.createOp({ name: "a" });
  await repo.addPending(convId, { opId: op.id });
  await repo.addPending(convId, { opId: op.id });
  const n = await repo.clearPending(convId);
  assert.equal(n, 2);
  assert.equal((await repo.listPending(convId)).length, 0);
  cleanup(dataDir);
});

// ── engine：parseOpsReport ──────────────────────────

ok("engine：parseOpsReport 解析 delta", () => {
  const r = parseOpsReport("我攻击了她。[结算 攻击 delta:hp=-20] 她倒下了。");
  assert.equal(r.reports.length, 1);
  assert.equal(r.reports[0].name, "攻击");
  assert.deepEqual(r.reports[0].deltas, { hp: -20 });
  assert.equal(r.reports[0].failed, false);
  assert.equal(r.text, "我攻击了她。 她倒下了。");
});

ok("engine：parseOpsReport 解析 set", () => {
  const r = parseOpsReport("[结算 攻击 set:hp=50,mp=0]");
  assert.deepEqual(r.reports[0].sets, { hp: "50", mp: "0" });
  assert.deepEqual(r.reports[0].deltas, {});
});

ok("engine：parseOpsReport 解析失败", () => {
  const r = parseOpsReport("[结算 攻击 失败:体力不足]");
  assert.equal(r.reports[0].failed, true);
  assert.equal(r.reports[0].failedReason, "体力不足");
});

ok("engine：parseOpsReport 支持多个标记 + 混 delta/set", () => {
  const r = parseOpsReport(
    "[结算 攻击 delta:hp=-20 set:mp=0][结算 施法 delta:mp=-10] 结束"
  );
  assert.equal(r.reports.length, 2);
  assert.deepEqual(r.reports[0].deltas, { hp: -20 });
  assert.deepEqual(r.reports[0].sets, { mp: "0" });
  assert.deepEqual(r.reports[1].deltas, { mp: -10 });
  assert.ok(r.text.includes("结束"), `text=${JSON.stringify(r.text)}`);
});

ok("engine：parseOpsReport 没有标记就原样返回", () => {
  const r = parseOpsReport("她推开门。");
  assert.equal(r.reports.length, 0);
  assert.equal(r.text, "她推开门。");
});

// ── engine：settleOps ──────────────────────────────

await okAsync("engine：settleOps delta 走 updateVariables，抹掉 pending", async () => {
  const { dataDir, convId } = await freshSetup();
  const repo = await createOpsRepo(dataDir).init();
  const op = await repo.createOp({ name: "攻击", costVar: "体力" });
  await repo.addPending(convId, { opId: op.id });

  // 假的 convRepo：记录 updateVariables 的调用
  const calls = [];
  const fakeConvRepo = {
    async updateVariables(_, patch) { calls.push({ kind: "vars", patch }); return patch; },
    async removePendingByOp(cid, opId) { return repo.removePendingByOp(cid, opId); }
  };
  const r = await settleOps({
    reports: [{ name: "攻击", deltas: { hp: -20 }, sets: { mp: 0 }, failed: false }],
    ops: [op],
    conversationId: convId,
    conversationRepo: fakeConvRepo,
    varsBefore: { hp: 100, mp: 50 }
  });
  assert.equal(r.applied.length, 1);
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(r.errors, []);
  // 变量写回：hp 从 100 减 20 = 80；mp 直设 0
  assert.equal(calls.length, 1);
  assert.equal(calls[0].patch.hp, "80");
  assert.equal(calls[0].patch.mp, "0");
  // pending 被抹
  assert.equal((await repo.listPending(convId)).length, 0);
  cleanup(dataDir);
});

await okAsync("engine：settleOps 未知操作 → rejected", async () => {
  const r = await settleOps({
    reports: [{ name: "不存在的操作", deltas: { hp: -5 }, sets: {} }],
    ops: [{ id: "op_1", name: "攻击" }]
  });
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].reason, /未知操作/);
});

await okAsync("engine：settleOps 失败结算不改变量，也清 pending", async () => {
  const { dataDir, convId } = await freshSetup();
  const repo = await createOpsRepo(dataDir).init();
  const op = await repo.createOp({ name: "攻击" });
  await repo.addPending(convId, { opId: op.id });

  const calls = [];
  const fakeConvRepo = {
    async updateVariables(_, patch) { calls.push(patch); return patch; },
    async removePendingByOp(cid, opId) { return repo.removePendingByOp(cid, opId); }
  };
  const r = await settleOps({
    reports: [{ name: "攻击", deltas: {}, sets: {}, failed: true, failedReason: "体力不足" }],
    ops: [op],
    conversationId: convId,
    conversationRepo: fakeConvRepo,
    varsBefore: { hp: 100 }
  });
  assert.equal(calls.length, 0, "失败不改变量");
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].failed, true);
  assert.equal(r.applied[0].reason, "体力不足");
  assert.equal((await repo.listPending(convId)).length, 0, "失败也清 pending（一次结算一次）");
  cleanup(dataDir);
});

await okAsync("engine：settleOps 没 delta 也没 set → rejected", async () => {
  const r = await settleOps({
    reports: [{ name: "攻击", deltas: {}, sets: {}, failed: false }],
    ops: [{ id: "op_1", name: "攻击" }]
  });
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].reason, /没有 delta 也没有 set/);
});

await okAsync("engine：settleOps 异常走 errors，不吞不抛", async () => {
  const calls = [];
  const fakeConvRepo = {
    async updateVariables() { calls.push(1); throw new Error("磁盘满"); },
    async removePendingByOp() { return 0; }
  };
  const r = await settleOps({
    reports: [{ name: "攻击", deltas: { hp: -5 }, sets: {} }],
    ops: [{ id: "op_1", name: "攻击" }],
    conversationId: "conv",
    conversationRepo: fakeConvRepo,
    varsBefore: { hp: 100 }
  });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].reason, /磁盘满/);
});

// ── engine：composePendingBlock ────────────────────

ok("engine：composePendingBlock 空 pending 回空", () => {
  const r = composePendingBlock([], []);
  assert.equal(r.text, "");
  assert.equal(r.count, 0);
});

ok("engine：composePendingBlock 拼出编号清单 + 语法提示", () => {
  const ops = [
    { id: "op1", name: "攻击", costVar: "体力", summary: "造成伤害" },
    { id: "op2", name: "施法", costVar: "mp", summary: "释放法术" }
  ];
  const pending = [
    { id: "p1", opId: "op1", note: "" },
    { id: "p2", opId: "op2", note: "对守卫" }
  ];
  const { text, count } = composePendingBlock(ops, pending);
  assert.equal(count, 2);
  assert.match(text, /攻击/);
  assert.match(text, /施法/);
  assert.match(text, /体力/);
  assert.match(text, /mp/);
  assert.match(text, /备注：对守卫/);
  assert.match(text, /\[结算 操作名/);
});

ok("engine：composePendingBlock 不认识的 opId 跳过", () => {
  const { count, text } = composePendingBlock([], [{ id: "p1", opId: "unknown" }]);
  assert.equal(count, 0);
  assert.equal(text, "");
});

// ── routes ──────────────────────────────────────────

await okAsync("routes：GET /ops 回全表", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createOpsRepo(dataDir).init();
  await repo.createOp({ name: "攻击" });
  await repo.createOp({ name: "施法" });
  const app = makeApp();
  registerOpsRoutes(app, repo);
  const r = await request(app, "GET", "/ops");
  assert.ok(r.ok === true);
  assert.equal(r.data.length, 2);
  cleanup(dataDir);
});

await okAsync("routes：POST /ops 建一条", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createOpsRepo(dataDir).init();
  const app = makeApp();
  registerOpsRoutes(app, repo);
  const r = await request(app, "POST", "/ops", { body: { name: "攻击", costVar: "体力" } });
  assert.ok(r.ok === true);
  assert.equal(r.data.name, "攻击");
  assert.equal(r.data.costVar, "体力");
  cleanup(dataDir);
});

await okAsync("routes：PUT /ops/:id 改字段", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createOpsRepo(dataDir).init();
  const o = await repo.createOp({ name: "攻击", costVar: "体力" });
  const app = makeApp();
  registerOpsRoutes(app, repo);
  const r = await request(app, "PUT", `/ops/${o.id}`, { body: { summary: "重武器" } });
  assert.ok(r.ok === true);
  assert.equal(r.data.summary, "重武器");
  assert.equal(r.data.name, "攻击");
  cleanup(dataDir);
});

await okAsync("routes：DELETE /ops/:id 404 找不到", async () => {
  const { dataDir } = await freshSetup();
  const repo = await createOpsRepo(dataDir).init();
  const app = makeApp();
  registerOpsRoutes(app, repo);
  const r = await request(app, "DELETE", "/ops/does-not-exist");
  assert.ok(r.status >= 400, `status=${r.status}`);
  cleanup(dataDir);
});

await okAsync("routes：GET /ops/pending?conversationId=", async () => {
  const { dataDir, convId } = await freshSetup();
  const repo = await createOpsRepo(dataDir).init();
  const op = await repo.createOp({ name: "攻击" });
  await repo.addPending(convId, { opId: op.id });
  const app = makeApp();
  registerOpsRoutes(app, repo);
  const r = await request(app, "GET", `/ops/pending`, { query: { conversationId: convId } });
  assert.ok(r.ok === true);
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].opId, op.id);
  cleanup(dataDir);
});

await okAsync("routes：POST /ops/pending 缺 opId 报错", async () => {
  const { dataDir, convId } = await freshSetup();
  const repo = await createOpsRepo(dataDir).init();
  const app = makeApp();
  registerOpsRoutes(app, repo);
  const r = await request(app, "POST", "/ops/pending", { body: { conversationId: convId } });
  assert.ok(r.status >= 400);
  cleanup(dataDir);
});

await okAsync("routes：DELETE /ops/pending/:id?conversationId= 移除", async () => {
  const { dataDir, convId } = await freshSetup();
  const repo = await createOpsRepo(dataDir).init();
  const op = await repo.createOp({ name: "a" });
  const p = await repo.addPending(convId, { opId: op.id });
  const app = makeApp();
  registerOpsRoutes(app, repo);
  const r = await request(app, "DELETE", `/ops/pending/${p.id}`, { query: { conversationId: convId } });
  assert.ok(r.ok === true);
  assert.equal((await repo.listPending(convId)).length, 0);
  cleanup(dataDir);
});

await okAsync("routes：POST /ops/pending/clear 清空", async () => {
  const { dataDir, convId } = await freshSetup();
  const repo = await createOpsRepo(dataDir).init();
  const op = await repo.createOp({ name: "a" });
  await repo.addPending(convId, { opId: op.id });
  await repo.addPending(convId, { opId: op.id });
  const app = makeApp();
  registerOpsRoutes(app, repo);
  const r = await request(app, "POST", "/ops/pending/clear", { body: { conversationId: convId } });
  assert.ok(r.ok === true);
  assert.equal(r.data.removed, 2);
  cleanup(dataDir);
});

// ── 汇总 ────────────────────────────────────────────

console.log(`\n通过 ${pass} / 失败 ${fail}\n`);
if (fail > 0) process.exit(1);
