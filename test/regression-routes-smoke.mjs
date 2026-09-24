// test/regression-routes-smoke.mjs — 全部 9 个 routes 文件的「真跑」冒烟
//
// 为什么需要：整条 HTTP 面此前在任何测试里都没被跑过。静态检查看得见
// **路径**（check-route-order）和**名字**（check-route-health），看不见
// 「打过去会发生什么」。而宿主把 App 的 HTTP 面锁在鉴权后（直接打 403），
// 真环境也点不着。这段空白里藏着的是「注册漏了 / 方法名不对 /
// 参数接错 / 形状不对」——它们在用户第一次点那个按钮的那天才会暴露。
//
// 两层判据：
//
//   ① **路由表精确对照**。每个模块注册的路由清单写死在下面。
//      多一条少一条都会红——「某个 register 悄悄少注册了一条」
//      是那种上线后没人能想到去查的事。加了路由就顺手更新这张表。
//
//   ② **结构化错误过滤器**。任何响应里出现 "is not a function" /
//      "Cannot read properties" / "not a constructor"——一律硬失败。
//      这类错是「代码写了但从没工作过」的味道，不是业务校验失败：
//      业务失败是人话（"规则必须有 pattern"），结构失败是引擎腔。
//
// 这里不验语义深度（那是各模块自己的 regression 干的活），
// 验的是「每条路都真的通、没有死端点」。

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeApp, request } from "./lib/route-harness.mjs";

const { CharacterRepo } = await import("../lib/characters/repo.js");
const { CharacterTransfer } = await import("../lib/characters/transfer.js");
const { ConversationRepo } = await import("../lib/conversations/repo.js");
const { SettingRepo } = await import("../lib/settings/repo.js");
const { VariableRepo } = await import("../lib/variables/repo.js");
const { PresetRepo } = await import("../lib/presets/repo.js");
const { BoardRepo } = await import("../lib/board/repo.js");
const { RegexRepo } = await import("../lib/regex/repo.js");

const { registerCharacterRoutes } = await import("../lib/characters/routes.js");
const { registerConversationRoutes } = await import("../lib/conversations/routes.js");
const { registerSettingRoutes } = await import("../lib/settings/routes.js");
const { registerVariableRoutes } = await import("../lib/variables/routes.js");
const { registerPresetRoutes } = await import("../lib/presets/routes.js");
const { registerToolRoutes } = await import("../lib/tools/routes.js");
const { registerMigrationRoutes } = await import("../lib/migration/routes.js");
const { registerBoardRoutes } = await import("../lib/board/routes.js");
const { registerRegexRoutes } = await import("../lib/regex/routes.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

const STRUCTURAL = /is not a function|Cannot read propert|not a constructor|of undefined|of null/;

/**
 * 响应该存在、状态正常、符合 {ok:true,data} 契约、且没有结构错。
 *
 * 契约那一条不是形式：前端按 respond.js 的约定解析，
 * 一个 ok 不是 true 的 200 响应，前端只会看成「数据是空的」——
 * 与「真的没数据」完全无法区分。
 */
function healthy(r, where, expected = 200) {
  assert.ok(r, `${where}：路由没匹配上`);
  if (r.error && STRUCTURAL.test(r.error)) {
    assert.fail(`${where}：结构错 —— ${r.error}`);
  }
  assert.strictEqual(r.status, expected, `${where}：实为 ${r.status}（${r.error || "无错误信息"}）`);
  if (expected === 200) {
    assert.strictEqual(r.ok, true, `${where}：200 但 ok 不是 true（契约破了：${JSON.stringify(r.payload).slice(0, 120)}）`);
  }
  return r;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-smoke-"));

const charRepo = new CharacterRepo(tmp); await charRepo.init();
const transfer = new CharacterTransfer(charRepo);
const convRepo = new ConversationRepo(tmp); await convRepo.init();
const setRepo = new SettingRepo(tmp); await setRepo.init();
const varRepo = new VariableRepo(tmp); await varRepo.init();
const presetRepo = new PresetRepo(tmp); await presetRepo.init();
const boardRepo = new BoardRepo(tmp); await boardRepo.init();
const regexRepo = new RegexRepo(tmp); await regexRepo.init();

const apps = {
  characters: makeApp(),
  conversations: makeApp(),
  settings: makeApp(),
  variables: makeApp(),
  presets: makeApp(),
  board: makeApp(),
  regex: makeApp(),
  tools: makeApp(),
  migration: makeApp()
};

registerCharacterRoutes(apps.characters, charRepo, transfer, setRepo);
registerConversationRoutes(apps.conversations, convRepo, null, charRepo, setRepo, regexRepo, presetRepo, boardRepo);
registerSettingRoutes(apps.settings, setRepo, convRepo);
registerVariableRoutes(apps.variables, varRepo, convRepo, charRepo);
registerPresetRoutes(apps.presets, presetRepo);
registerToolRoutes(apps.tools, {});
registerMigrationRoutes(apps.migration, tmp);
// 板上与正则各自的深测在 regression-board-routes / regression-regex-routes，
// 这里注册它们只是为了让下面那张表是**完整的九张脸**。
registerBoardRoutes(apps.board, boardRepo);
registerRegexRoutes(apps.regex, regexRepo);

// ── ① 路由表精确对照 ──
const EXPECTED = {
  characters: [
    "GET /characters", "GET /characters/tags", "GET /characters/:id",
    "POST /characters", "PUT /characters/:id", "DELETE /characters/:id",
    "POST /characters/batch-delete", "GET /characters/:id/avatar",
    "POST /characters/import/prepare", "POST /characters/import/parse",
    "POST /characters/import/commit", "POST /characters/import/discard",
    "POST /characters/:id/import-book", "GET /characters/:id/export/:format"
  ],
  conversations: [
    "GET /conversations", "GET /conversations/:id", "POST /conversations",
    "DELETE /conversations/:id",
    "PUT /conversations/:id/messages/:messageId",
    "DELETE /conversations/:id/messages/:messageId",
    "PUT /conversations/:id/messages/:messageId/variant",
    "PUT /conversations/:id/persona",
    "POST /conversations/:id/messages", "POST /conversations/:id/messages/stream",
    "POST /conversations/:id/regenerate", "POST /conversations/:id/regenerate/stream",
    "GET /characters-for-conv",
    "POST /conversations/:id/activation-preview", "POST /conversations/:id/prompt-preview"
  ],
  settings: [
    "GET /settings", "GET /settings/:id", "POST /settings", "PUT /settings/:id",
    "DELETE /settings/:id", "PUT /settings/:id/toggle", "POST /settings/import",
    "POST /settings/active", "POST /settings/test", "POST /settings/inject",
    "POST /settings/import-st", "POST /settings/import-character-book"
  ],
  variables: [
    "GET /variables", "GET /variables/:id", "POST /variables", "PUT /variables/:id",
    "DELETE /variables/:id", "POST /variables/import",
    "GET /conversations/:id/variables", "PUT /conversations/:id/variables",
    "PUT /conversations/:id/variables/:name", "POST /conversations/:id/variables/patch",
    "POST /variables/test-replace"
  ],
  presets: [
    "GET /presets", "POST /presets/import", "GET /presets/:id", "POST /presets",
    "PUT /presets/:id", "DELETE /presets/:id", "POST /presets/:id/duplicate",
    "POST /presets/:id/preview"
  ],
  board: [
    "GET /board/cells", "GET /board/visible", "POST /board/cells",
    "PUT /board/cells/:id", "PUT /board/cells/:id/toggle", "DELETE /board/cells/:id"
  ],
  regex: [
    "GET /regex-rules", "GET /regex-rules/:id", "POST /regex-rules/test",
    "POST /regex-rules", "PUT /regex-rules/:id", "PATCH /regex-rules/:id",
    "DELETE /regex-rules/:id", "POST /regex-rules/import"
  ],
  tools: [
    "GET /tools/groups", "GET /tools/groups/:id", "PUT /tools/groups/:id/toggle",
    "GET /tools/enabled", "GET /tools/:name/enabled", "GET /tools/info", "POST /tools/test"
  ],
  migration: [
    "POST /migration/export", "POST /migration/preview", "POST /migration/import",
    "GET /migration/exports/:filename", "GET /migration/exports",
    "DELETE /migration/exports/:filename", "GET /migration/health"
  ]
};

console.log("\n=== 路由面 · 真跑冒烟 ===\n");
console.log("── ① 路由表对照 ──");

for (const [name, expected] of Object.entries(EXPECTED)) {
  await okAsync(`${name}：${expected.length} 条路由与预期一致`, () => {
    const actual = apps[name].routes.map(r => `${r.method} ${r.path}`);
    const missing = expected.filter(p => !actual.includes(p));
    const extra = actual.filter(p => !expected.includes(p));
    assert.deepStrictEqual(
      { missing, extra },
      { missing: [], extra: [] },
      `少: ${missing.join(", ") || "无"} / 多: ${extra.join(", ") || "无"}`
    );
  });
}

// ── ② 各模块主链路 ──
console.log("\n── ② 主链路 ──");

// 角色卡
let cardId = null;
await okAsync("characters：建 / 读 / 改 / 列 / 删", async () => {
  const created = healthy(await request(apps.characters, "POST", "/characters", {
    body: { name: "冒烟角色", description: "测试用", first_mes: "「你好。」" }
  }), "POST /characters");
  assert.ok(created.data.id, "没返回 id");
  cardId = created.data.id;

  healthy(await request(apps.characters, "GET", `/characters/${cardId}`), "GET /characters/:id");
  healthy(await request(apps.characters, "GET", "/characters"), "GET /characters");
  healthy(await request(apps.characters, "GET", "/characters/tags"), "GET /characters/tags");

  const upd = healthy(await request(apps.characters, "PUT", `/characters/${cardId}`, {
    body: { name: "冒烟角色（改）" }
  }), "PUT /characters/:id");
  assert.strictEqual(upd.data.name, "冒烟角色（改）");

  healthy(await request(apps.characters, "GET", `/characters/${cardId}/export/json`), "GET export");
});

// 对话
let convId = null;
await okAsync("conversations：建 / 读 / 列 / 消息增删改 / 删", async () => {
  const created = healthy(await request(apps.conversations, "POST", "/conversations", {
    body: { characterId: cardId, userName: "月曦夜", persona: "旅人" }
  }), "POST /conversations");
  convId = created.data.id;
  assert.ok(convId);

  healthy(await request(apps.conversations, "GET", `/conversations/${convId}`), "GET /conversations/:id");
  healthy(await request(apps.conversations, "GET", "/conversations"), "GET /conversations");
  healthy(await request(apps.conversations, "GET", "/characters-for-conv"), "GET /characters-for-conv");

  await convRepo.addMessage(convId, "user", "第一句。");
  const conv = await convRepo.get(convId);
  const msgId = conv.messages[0].id;

  const edited = healthy(await request(apps.conversations, "PUT",
    `/conversations/${convId}/messages/${msgId}`, { body: { content: "第一句（改）。" } }),
    "PUT messages/:messageId");
  assert.ok(edited.data, "改消息没返回内容");

  healthy(await request(apps.conversations, "DELETE",
    `/conversations/${convId}/messages/${msgId}`), "DELETE messages/:messageId");

  healthy(await request(apps.conversations, "PUT", `/conversations/${convId}/persona`, {
    body: { userName: "月曦夜", persona: "旅人（改）" }
  }), "PUT persona");
});

// 设定库
let settingId = null;
await okAsync("settings：建 / 读 / 改 / 开关 / 删", async () => {
  const created = healthy(await request(apps.settings, "POST", "/settings", {
    body: { comment: "冒烟设定", content: "这是一条设定。", keywords: ["冒烟"], tier: "core" }
  }), "POST /settings");
  settingId = created.data.id;
  assert.ok(settingId);

  healthy(await request(apps.settings, "GET", `/settings/${settingId}`), "GET /settings/:id");
  healthy(await request(apps.settings, "GET", "/settings"), "GET /settings");

  const upd = healthy(await request(apps.settings, "PUT", `/settings/${settingId}`, {
    body: { comment: "冒烟设定（改）" }
  }), "PUT /settings/:id");
  assert.strictEqual(upd.data.comment, "冒烟设定（改）");

  healthy(await request(apps.settings, "PUT", `/settings/${settingId}/toggle`, {
    body: { enabled: false }
  }), "PUT /settings/:id/toggle");

  // 激活：拿一串包含关键词的文本
  healthy(await request(apps.settings, "POST", "/settings/active", {
    body: { text: "这里提到了冒烟。" }
  }), "POST /settings/active");

  healthy(await request(apps.settings, "DELETE", `/settings/${settingId}`), "DELETE /settings/:id");
});

// 变量
await okAsync("variables：建 / 读 / 改 / 测试替换 / 删", async () => {
  const created = healthy(await request(apps.variables, "POST", "/variables", {
    body: { name: "smoke_var", type: "string", defaultValue: "值", scope: "conversation" }
  }), "POST /variables");
  const vid = created.data.id;
  assert.ok(vid);

  healthy(await request(apps.variables, "GET", `/variables/${vid}`), "GET /variables/:id");
  healthy(await request(apps.variables, "GET", "/variables"), "GET /variables");

  healthy(await request(apps.variables, "PUT", `/variables/${vid}`, {
    body: { description: "改过" }
  }), "PUT /variables/:id");

  const t = healthy(await request(apps.variables, "POST", "/variables/test-replace", {
    body: { text: "你好 {{smoke_var}}", variables: { smoke_var: "世界" } }
  }), "POST /variables/test-replace");
  assert.ok(typeof (t.data?.result ?? t.data) === "string" || typeof t.data === "object", "测试替换没返回结果");

  healthy(await request(apps.variables, "DELETE", `/variables/${vid}`), "DELETE /variables/:id");

  // 对话级变量（跨文件注册的那三条：路径挂在 /conversations 下）
  healthy(await request(apps.variables, "GET", `/conversations/${convId}/variables`), "GET conv variables");
  healthy(await request(apps.variables, "PUT", `/conversations/${convId}/variables`, {
    body: { variables: { a: 1 } }
  }), "PUT conv variables");
});

// 预设
await okAsync("presets：建 / 读 / 改 / 复制 / 删", async () => {
  const created = healthy(await request(apps.presets, "POST", "/presets", {
    body: { name: "冒烟预设", description: "测试", blocks: [] }
  }), "POST /presets");
  const pid = created.data.id;
  assert.ok(pid);

  healthy(await request(apps.presets, "GET", `/presets/${pid}`), "GET /presets/:id");
  healthy(await request(apps.presets, "GET", "/presets"), "GET /presets");

  healthy(await request(apps.presets, "PUT", `/presets/${pid}`, {
    body: { description: "改过" }
  }), "PUT /presets/:id");

  healthy(await request(apps.presets, "POST", `/presets/${pid}/duplicate`, { body: {} }), "POST duplicate");
  healthy(await request(apps.presets, "DELETE", `/presets/${pid}`), "DELETE /presets/:id");
});

// 迁移（只读那两条）
await okAsync("migration：health 与导出列表能打通", async () => {
  healthy(await request(apps.migration, "GET", "/migration/health"), "GET /migration/health");
  healthy(await request(apps.migration, "GET", "/migration/exports"), "GET /migration/exports");
});

// 工具（只读；toggle 会写真实数据目录，不碰）
await okAsync("tools：只读那几条能打通", async () => {
  healthy(await request(apps.tools, "GET", "/tools/groups"), "GET /tools/groups");
  healthy(await request(apps.tools, "GET", "/tools/enabled"), "GET /tools/enabled");
  healthy(await request(apps.tools, "GET", "/tools/not-a-real-tool/enabled"), "GET /tools/:name/enabled");
  healthy(await request(apps.tools, "GET", "/tools/info"), "GET /tools/info");
});

// ── ③ 死端点扫描：每个注册的路由都至少能被打到一次 ──
console.log("\n── ③ 死端点扫描 ──");

await okAsync("每条路由都能匹配到（无注册但不可达的路由）", () => {
  const dead = [];
  for (const [name, app] of Object.entries(apps)) {
    for (const r of app.routes) {
      // 把 :param 换成占位符，只问「匹配得上吗」
      const concrete = r.path.replace(/:[A-Za-z_$][\w$]*/g, "x");
      if (!app.match(r.method, concrete)) dead.push(`${name}: ${r.method} ${r.path}`);
    }
  }
  assert.deepStrictEqual(dead, [], `以下路由注册了但匹配不到：\n     ${dead.join("\n     ")}`);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
