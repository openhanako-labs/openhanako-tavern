// test/regression-persona-inherit.mjs
//
// 人设跟着角色卡走。
//
// 原酒馆的规矩：用户人设是对着**角色/世界**的，不是对着某一场的。
// 所以同一张卡开新场时，人设要能自动带过来——否则每开一场都要重填一遍，
// 而"重填一遍"正是让人放弃写人设的地方。
//
// 实现上不新增字段：从这张卡**最近一场**抄。行为一致，schema 不动。
//
// 判据（五条）：
//   ① 第一场：这张卡从没有过对话 → 人设是空的（没有可继承的）
//   ② 设过人设后，同卡开新场 → 带过来（userName 一起，它俩是一对）
//   ③ 显式传 persona:"" → **不**继承（明确要清空就是清空）
//   ④ 显式传了新的人设 → 用传的，不被旧人设盖掉
//   ⑤ 另一张卡开新场 → 不带（只跟同一张卡，不跨卡串人设）
//
// 用 test/lib/route-harness.mjs 的离线台子跑。

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeApp, request } from "./lib/route-harness.mjs";

const { CharacterRepo } = await import("../lib/characters/repo.js");
const { ConversationRepo } = await import("../lib/conversations/repo.js");
const { registerConversationRoutes } = await import("../lib/conversations/routes.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 人设跟着角色卡走 ===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-persona-"));
const charRepo = new CharacterRepo(tmp);
await charRepo.init();
const convRepo = new ConversationRepo(tmp);
await convRepo.init();

const vera = await charRepo.create({ name: "薇拉", description: "守夜法师", first_mes: "「又是你。」" });
const luna = await charRepo.create({ name: "露娜", description: "值班员", first_mes: "「在。」" });

const app = makeApp();
registerConversationRoutes(app, convRepo, { available: true, generate: async () => ({ content: "x" }) },
  charRepo, null, null, null, null);

const newConv = (body) => request(app, "POST", "/conversations", { body });
const setPersona = (id, body) => request(app, "PUT", `/conversations/${id}/persona`, { body });

const MY_OC = "我是月曦夜，城外的巡夜人，话少，习惯先看再开口。";

// ── ① 第一场：没有可继承的 ────────────────────────────
let first = null;
await okAsync("① 这张卡的第一场 → 人设是空的（没有可继承的）", async () => {
  const r = await newConv({ characterId: vera.id });
  first = r.data?.id;
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.persona, "", `该是空串，实为 ${JSON.stringify(r.data.persona)}`);
  assert.strictEqual(r.data.userName, "", `userName 该是空串，实为 ${JSON.stringify(r.data.userName)}`);
});

// ── ② 同卡开新场 → 带过来 ─────────────────────────────
await okAsync("② 设过人设后，同卡开新场 → 自动带过来（persona 与 userName 一起）", async () => {
  assert.ok(first, "① 没跑出对话 id");
  const s = await setPersona(first, { userName: "月曦夜", persona: MY_OC });
  assert.strictEqual(s.status, 200, `设人设失败：${s.status} ${s.error || ""}`);

  const r = await newConv({ characterId: vera.id });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.persona, MY_OC, `人设没带过来：${JSON.stringify(r.data.persona)}`);
  assert.strictEqual(r.data.userName, "月曦夜", `userName 没一起带过来：${JSON.stringify(r.data.userName)}`);
});

// ── ③ 显式空串 = 明确清空，不继承 ─────────────────────
await okAsync("③ 显式传 persona:\"\" → 不继承（明确要清空就是清空）", async () => {
  const r = await newConv({ characterId: vera.id, userName: "", persona: "" });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.persona, "", `显式空串被旧人设盖掉了：${JSON.stringify(r.data.persona)}`);
});

// ── ④ 显式传新值 → 用传的 ─────────────────────────────
await okAsync("④ 显式传了新的人设 → 用传的，不被旧人设盖掉", async () => {
  const r = await newConv({ characterId: vera.id, userName: "夜", persona: "另一个身份" });
  assert.strictEqual(r.data.persona, "另一个身份", `实为 ${JSON.stringify(r.data.persona)}`);
  assert.strictEqual(r.data.userName, "夜", `实为 ${JSON.stringify(r.data.userName)}`);
});

// ── ⑤ 另一张卡 → 不串 ─────────────────────────────────
await okAsync("⑤ 另一张卡开新场 → 不带薇拉那套（不跨卡串人设）", async () => {
  const r = await newConv({ characterId: luna.id });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.persona, "", `跨卡串了人设：${JSON.stringify(r.data.persona)}`);
  assert.strictEqual(r.data.userName, "", `跨卡串了 userName：${JSON.stringify(r.data.userName)}`);
});

console.log(`\n${fail === 0 ? "✅" : "❌"} 人设继承：${pass} 过 / ${fail} 败\n`);
process.exit(fail === 0 ? 0 : 1);
