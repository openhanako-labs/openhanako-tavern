// test/regression-regex-routes.mjs — 正则规则 HTTP 面
//
// 正则引擎此前是引擎里最大的一处「有能力没入口」：全套 CRUD、ST 导入导出、
// 作用域三层、三个作用面，前端零界面。这一份验的是它的**面**：
// 路由注册了没、状态码对不对、{ok,data} 契约对不对。
//
// 重点钉住两件容易再犯的事：
//
//   1. **`return notFound(...)` 不是 `throw`**。notFound() 返回的是一个
//      Error 对象，return 出去会被 route() 当成「成功的返回值」包成
//      {ok:true,data:{}}——查一条不存在的规则得到 200。前端只看得到
//      「数据是空的」，无从区分「没这条」与「有这条但字段全空」。
//      这个 bug 在接到界面之前没有人会碰到，所以必须在这里钉死。
//
//   2. **坏正则在保存时就该被拒**。仓储的纪律是「保存时编译」——
//      一条写错的正则能让角色说出完全不属于自己的话，而且没人会立刻发现。
//      让它进运行时才是灾难。

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeApp, request } from "./lib/route-harness.mjs";

const { RegexRepo } = await import("../lib/regex/repo.js");
const { registerRegexRoutes } = await import("../lib/regex/routes.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 正则规则 HTTP 面 ===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-regex-http-"));
const repo = new RegexRepo(tmp);
await repo.init();

const app = makeApp();
registerRegexRoutes(app, repo);

// 场景 1：路由齐全
await okAsync("正则路由齐全（CRUD + 导入 + 试跑）", async () => {
  const paths = app.routes.map(r => `${r.method} ${r.path}`);
  for (const need of [
    "GET /regex-rules", "GET /regex-rules/:id", "POST /regex-rules",
    "PUT /regex-rules/:id", "PATCH /regex-rules/:id", "DELETE /regex-rules/:id",
    "POST /regex-rules/import", "POST /regex-rules/test"
  ]) {
    assert.ok(paths.includes(need), `缺 ${need}（实有：${paths.join(" / ")}）`);
  }
});

// 场景 2：不存在的规则必须是 404，不是 200
await okAsync("GET 不存在的规则 → 404（不是 200 + 空 data）", async () => {
  const r = await request(app, "GET", "/regex-rules/no-such-rule");
  assert.ok(r, "路由没匹配上");
  assert.strictEqual(r.status, 404, `实为 ${r.status}——return notFound() 的老毛病又回来了`);
  assert.strictEqual(r.ok, false);
  assert.ok(String(r.error).includes("no-such-rule"), `错误信息该带上 id，实为：${r.error}`);
});

// 场景 3：建一条
let ruleId = null;
await okAsync("POST 建一条规则，且落盘可读", async () => {
  const r = await request(app, "POST", "/regex-rules", {
    body: { name: "去掉旁白", pattern: "（[^）]*）", replacement: "", flags: "g", surfaces: ["prompt"] }
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.ok, true);
  assert.ok(r.data.id, "没返回 id");
  assert.strictEqual(r.data.disabled, false, "本 App 内新建默认该是启用的");
  ruleId = r.data.id;

  const list = await request(app, "GET", "/regex-rules");
  assert.strictEqual(list.data.length, 1);
});

// 场景 4：坏正则当场拒掉
await okAsync("坏正则在保存时就被拒（400 + 说得出哪坏了）", async () => {
  const r = await request(app, "POST", "/regex-rules", {
    body: { name: "坏正则", pattern: "([", replacement: "" }
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.ok, false);
  assert.ok(/正则/.test(r.error), `错误该说清是正则的问题，实为：${r.error}`);

  const list = await request(app, "GET", "/regex-rules");
  assert.strictEqual(list.data.length, 1, "坏规则不该被写进去");
});

// 场景 5：开关（PATCH 收的是 enabled，正的语义）
await okAsync("PATCH { enabled:false } → 规则变关，再开回来", async () => {
  const off = await request(app, "PATCH", `/regex-rules/${ruleId}`, { body: { enabled: false } });
  assert.strictEqual(off.status, 200);
  assert.strictEqual(off.data.disabled, true);

  const on = await request(app, "PATCH", `/regex-rules/${ruleId}`, { body: { enabled: true } });
  assert.strictEqual(on.data.disabled, false);
});

// 场景 6：PATCH 缺 enabled 该报错
await okAsync("PATCH 不带 enabled → 400（不静默成功）", async () => {
  const r = await request(app, "PATCH", `/regex-rules/${ruleId}`, { body: {} });
  assert.strictEqual(r.status, 400);
  assert.ok(String(r.error).includes("enabled"), `错误该说要什么：${r.error}`);
});

// 场景 7：试跑草稿（未保存也能跑）
await okAsync("POST /test 拿未保存的草稿跑一遍", async () => {
  const r = await request(app, "POST", "/regex-rules/test", {
    body: {
      text: "她笑了（这是旁白）。",
      rule: { name: "草稿", pattern: "（[^）]*）", replacement: "", flags: "g", surfaces: ["prompt"] }
    }
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.after, "她笑了。", `实为：${r.data.after}`);
  assert.strictEqual(r.data.changed, true);
  assert.strictEqual(r.data.applied.length, 1);
});

// 场景 8：试跑不带文本 → 400
await okAsync("POST /test 不带文本 → 400", async () => {
  const r = await request(app, "POST", "/regex-rules/test", { body: { rule: { name: "x", pattern: "a" } } });
  assert.strictEqual(r.status, 400);
  assert.ok(String(r.error).includes("text"), `错误该说要什么：${r.error}`);
});

// 场景 9：作用面不匹配 → 有话说，不是沉默的"没变化"
await okAsync("作用面不匹配 → 没变化 + hint 说出可能的原因", async () => {
  const r = await request(app, "POST", "/regex-rules/test", {
    body: {
      text: "她笑了（这是旁白）。",
      surface: "display",
      rule: { name: "只管 prompt", pattern: "（[^）]*）", replacement: "", flags: "g", surfaces: ["prompt"] }
    }
  });
  assert.strictEqual(r.data.changed, false, "作用面不匹配却生效了");
  assert.ok(r.data.hint, "没变化时该给出排查方向，不能只让人对着空白发呆");
});

// 场景 10：改一条
await okAsync("PUT 改一条，字段真的落下去", async () => {
  const r = await request(app, "PUT", `/regex-rules/${ruleId}`, {
    body: { name: "去掉旁白（改）", pattern: "（[^）]*）", replacement: " ", flags: "g", surfaces: ["prompt"] }
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.name, "去掉旁白（改）");
  assert.strictEqual(r.data.replacement, " ");
  assert.strictEqual(r.data.id, ruleId, "id 不该变");
});

// 场景 11：批量导入（ST 形态）
await okAsync("POST /import 批量导入，逐条报结果", async () => {
  const r = await request(app, "POST", "/regex-rules/import", {
    body: [
      { name: "ST 一条", findRegex: "/\\[\\[.*?\\]\\]/g", replaceString: "" },
      { name: "坏的一条", findRegex: "/([/g", replaceString: "" }
    ]
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.length, 2);
  assert.strictEqual(r.data[0].ok, true, "好的那条该导入成功");
  assert.strictEqual(r.data[1].ok, false, "坏的那条该被单独拒掉，而不是整批失败");
});

// 场景 12：删掉之后 404
await okAsync("DELETE 之后 GET 同一条 → 404", async () => {
  const del = await request(app, "DELETE", `/regex-rules/${ruleId}`);
  assert.strictEqual(del.status, 200);

  const after = await request(app, "GET", `/regex-rules/${ruleId}`);
  assert.strictEqual(after.status, 404, "删了还能查到");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
