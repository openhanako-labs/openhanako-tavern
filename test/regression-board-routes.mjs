// test/regression-board-routes.mjs — 黑板的 HTTP 面
//
// 上一份测试（regression-board.mjs）验的是仓储：数据怎么存、可见性怎么裁。
// 这一份验的是**打到 URL 上**会怎样：路由注册了没、状态码对不对、
// 响应是不是 {ok,data} 契约。
//
// 为什么要单独一份：宿主把 App 的 HTTP 面锁在鉴权后面（直接 curl 是 403），
// 真环境里点不到；而静态检查只能证明路由写在那儿。中间这段空白正是
// 「注册漏了 / 状态码写错 / 形状不对」能一路滑到用户面前的地方。
//
// 用 test/lib/route-harness.mjs 的离线台子跑——按 Hono 的匹配语义最小复刻。

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeApp, request } from "./lib/route-harness.mjs";

const { BoardRepo } = await import("../lib/board/repo.js");
const { registerBoardRoutes } = await import("../lib/board/routes.js");
const { CharacterRepo } = await import("../lib/characters/repo.js");
const { ConversationRepo } = await import("../lib/conversations/repo.js");
const { charVisibility } = await import("../lib/board/model.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 黑板 HTTP 面 ===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-board-http-"));
const repo = new BoardRepo(tmp);
await repo.init();

const charRepo = new CharacterRepo(tmp);
await charRepo.init();
const convRepo = new ConversationRepo(tmp);
await convRepo.init();

const card = await charRepo.create({ name: "薇拉", description: "守夜法师", first_mes: "「又是你。」" });
const other = await charRepo.create({ name: "露娜", description: "值班员", first_mes: "「在。」" });
const conv = await convRepo.create(card.id);

const app = makeApp();
registerBoardRoutes(app, repo);

// 场景 1：路由都注册上了
await okAsync("六条黑板路由都注册在 /board 下", async () => {
  const paths = app.routes.map(r => `${r.method} ${r.path}`);
  assert.strictEqual(app.routes.length, 6, `实为 ${app.routes.length} 条：${paths.join(" / ")}`);
  assert.ok(paths.every(p => p.includes("/board/")), paths.join(" / "));
  for (const need of ["GET /board/cells", "GET /board/visible", "POST /board/cells",
                      "PUT /board/cells/:id", "PUT /board/cells/:id/toggle", "DELETE /board/cells/:id"]) {
    assert.ok(paths.includes(need), `缺 ${need}`);
  }
});

// 场景 2：空表也是 {ok,data} 契约
await okAsync("GET /board/cells 空表：ok + 三个数组", async () => {
  const r = await request(app, "GET", "/board/cells", { query: { conversationId: conv.id } });
  assert.ok(r, "路由没匹配上");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.data.world, []);
  assert.deepStrictEqual(r.data.chat, []);
  assert.deepStrictEqual(r.data.merged, []);
});

// 场景 3：建一格真能建起来
let publicId = null;
await okAsync("POST /board/cells 建对话级公开格", async () => {
  const r = await request(app, "POST", "/board/cells", {
    body: { title: "月台尽头", body: "站台的灯忽明忽暗", lifespan: "chat", activation: "constant", conversationId: conv.id }
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.ok, true);
  assert.ok(r.data.id, "没返回 id");
  assert.strictEqual(r.data.visible, "public");
  publicId = r.data.id;

  const list = await request(app, "GET", "/board/cells", { query: { conversationId: conv.id } });
  assert.strictEqual(list.data.chat.length, 1);
  assert.strictEqual(list.data.chat[0].id, publicId);
});

// 场景 4：该拦的拦下，而且错误是人话
await okAsync("对话级格子缺 conversationId → 400 且错误可读", async () => {
  const r = await request(app, "POST", "/board/cells", {
    body: { title: "无主", lifespan: "chat" }
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.ok, false);
  assert.ok(typeof r.error === "string" && r.error.length > 0, "错误信息是空的");
  assert.ok(r.error.includes("conversationId"), `错误没说清缺什么：${r.error}`);
});

// 场景 5：可见性裁决穿过 HTTP
await okAsync("GET /board/visible 按观察者裁剪（私密格不外泄）", async () => {
  await request(app, "POST", "/board/cells", {
    body: {
      title: "她的心事", body: "他碰到我了。别回头。",
      lifespan: "chat", activation: "constant",
      visible: charVisibility(card.id), conversationId: conv.id
    }
  });

  const asUser = await request(app, "GET", "/board/visible", { query: { conversationId: conv.id } });
  const titlesUser = asUser.data.map(c => c.title);
  assert.ok(titlesUser.includes("月台尽头"), "公开格应该看得到");
  assert.ok(!titlesUser.includes("她的心事"), "私密格泄漏给了用户视角");

  const asHer = await request(app, "GET", "/board/visible", {
    query: { conversationId: conv.id, characterId: card.id }
  });
  assert.ok(asHer.data.map(c => c.title).includes("她的心事"), "她自己应该看得到");

  const asOther = await request(app, "GET", "/board/visible", {
    query: { conversationId: conv.id, characterId: other.id }
  });
  assert.ok(!asOther.data.map(c => c.title).includes("她的心事"), "私密格泄漏给了别的角色");
});

// 场景 6：关键词过滤穿过 HTTP
await okAsync("GET /board/visible?text= 关键词命中才上场", async () => {
  await request(app, "POST", "/board/cells", {
    body: {
      title: "列车时刻", body: "末班车 23:40",
      lifespan: "chat", activation: "keyword", keywords: ["列车", "月台"],
      conversationId: conv.id
    }
  });

  const cold = await request(app, "GET", "/board/visible", { query: { conversationId: conv.id, text: "今天天气不错" } });
  assert.ok(!cold.data.map(c => c.title).includes("列车时刻"), "没命中关键词却上场了");

  const hot = await request(app, "GET", "/board/visible", { query: { conversationId: conv.id, text: "广播里的列车要开了" } });
  assert.ok(hot.data.map(c => c.title).includes("列车时刻"), "命中关键词却没上场");
});

// 场景 7：改一格
await okAsync("PUT /board/cells/:id 改标题，别的字段不动", async () => {
  const r = await request(app, "PUT", `/board/cells/${publicId}`, {
    body: { title: "月台尽头（改）", conversationId: conv.id }
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.title, "月台尽头（改）");
  assert.strictEqual(r.data.visible, "public", "顺手把可见性改掉了");
  assert.strictEqual(r.data.body, "站台的灯忽明忽暗", "顺手把内容清掉了");
});

// 场景 8：开关
await okAsync("PUT /board/cells/:id/toggle 取反，且关掉的格子不上场", async () => {
  const r = await request(app, "PUT", `/board/cells/${publicId}/toggle`, {
    body: { conversationId: conv.id }
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.enabled, false);

  const vis = await request(app, "GET", "/board/visible", { query: { conversationId: conv.id } });
  assert.ok(!vis.data.map(c => c.id).includes(publicId), "关掉的格子还在上场");

  const back = await request(app, "PUT", `/board/cells/${publicId}/toggle`, {
    body: { enabled: true, conversationId: conv.id }
  });
  assert.strictEqual(back.data.enabled, true);
});

// 场景 9：找不到就是 404，不是 200
await okAsync("不存在的 id → 404（PUT / toggle / DELETE 三处都是）", async () => {
  const put = await request(app, "PUT", "/board/cells/no-such-id", { body: { title: "x", conversationId: conv.id } });
  assert.strictEqual(put.status, 404, "PUT 应 404");
  assert.strictEqual(put.ok, false);

  const tog = await request(app, "PUT", "/board/cells/no-such-id/toggle", { body: { conversationId: conv.id } });
  assert.strictEqual(tog.status, 404, "toggle 应 404");

  const del = await request(app, "DELETE", "/board/cells/no-such-id", { query: { conversationId: conv.id } });
  assert.strictEqual(del.status, 404, "DELETE 应 404");
});

// 场景 10：删掉真没了
await okAsync("DELETE /board/cells/:id 删掉后列表里不再有", async () => {
  const del = await request(app, "DELETE", `/board/cells/${publicId}`, { query: { conversationId: conv.id } });
  assert.strictEqual(del.status, 200);
  assert.strictEqual(del.ok, true);

  const list = await request(app, "GET", "/board/cells", { query: { conversationId: conv.id } });
  assert.ok(!list.data.merged.map(c => c.id).includes(publicId), "删了还在列表里");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
