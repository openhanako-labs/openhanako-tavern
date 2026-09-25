// test/regression-media-comfy.mjs — 出图换引擎：本机 ComfyUI 那条路
//
// 这条路跟宿主那条**形状完全不同**：宿主的 sdk.media 是同步返回文件，
// 而 ComfyUI 是"提交 → 轮询 → 取产物"，还要绕一层 app/environments.manage 的 runTool。
// 形状错一个键，真机上就是一个 node_errors 或者永远等不到。
// 所以这里钉的重点是**调用形状**与**不把半成品当成品**。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { makeApp, request } = await import("./lib/route-harness.mjs");
const { registerMediaRoutes } = await import("../lib/media/routes.js");
const { CharacterRepo } = await import("../lib/characters/repo.js");
const { CharacterTransfer } = await import("../lib/characters/transfer.js");
const {
  pickComfyTool, dig, readPayload, extractPromptId, extractPaths, readStatus, renderViaComfy, ensureEnvironment
} = await import("../lib/media/comfy.js");
const { mergeImageConfig, imageReadiness, publicImageConfig, BACKENDS } = await import("../lib/media/config.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 出图 · 换引擎（本机 ComfyUI）===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-comfy-"));
const charRepo = new CharacterRepo(tmp);
await charRepo.init();
const transfer = new CharacterTransfer(charRepo);
const card = await charRepo.create({
  name: "薇拉·霜语", description: "守夜法师，银灰长发", first_mes: "「又是你。」"
});

// ── 纯函数：从各种形状里认东西 ──────────────────────────

await okAsync("① 找 ComfyUI 工具：按工具名找，退一步按扩展 id 找", () => {
  assert.deepStrictEqual(
    pickComfyTool({ tools: [{ ref: "app:other", name: "x" }, { ref: "app:comfyui-hana", name: "comfyui" }] }),
    { ref: "app:comfyui-hana", name: "comfyui" }
  );
  assert.deepStrictEqual(
    pickComfyTool({ tools: [{ ref: "app:comfyui-hana", name: "别的名字" }] }),
    { ref: "app:comfyui-hana", name: "别的名字" }
  );
  assert.strictEqual(pickComfyTool({ tools: [] }), null);
  assert.strictEqual(pickComfyTool(null), null);
});

await okAsync("② 工具返回值可能是包着的：JSON 字符串 / MCP 的 content[].text", () => {
  assert.deepStrictEqual(readPayload('{"a":1}'), { a: 1 });
  assert.strictEqual(readPayload("不是 JSON"), "不是 JSON");
  assert.deepStrictEqual(
    readPayload({ content: [{ type: "text", text: '{"promptId":"p1"}' }] }),
    { promptId: "p1" }
  );
  // 深层嵌套也要挖得到
  assert.strictEqual(dig({ x: { y: [{ details: { comfyui: { promptId: "p2" } } }] } }, "promptId"), "p2");
  assert.strictEqual(dig({}, "nope"), undefined);
});

await okAsync("③ promptId：两种键名都认，认不出返回 null", () => {
  assert.strictEqual(extractPromptId({ details: { comfyui: { promptId: "abc" } } }), "abc");
  assert.strictEqual(extractPromptId({ prompt_id: "def" }), "def");
  assert.strictEqual(extractPromptId({ nope: 1 }), null);
  assert.strictEqual(extractPromptId({ promptId: "   " }), null);
});

await okAsync("④ 产物路径：只收本地绝对路径，不收预览 URL", () => {
  const r = {
    files: [
      { path: "W:\\Games\\Comfyui\\output\\a.png", url: "http://127.0.0.1:8188/view?filename=a.png" },
      "W:\\Games\\Comfyui\\output\\b.webp",
      "http://127.0.0.1:8188/view?filename=c.png"
    ]
  };
  assert.deepStrictEqual(extractPaths(r), ["W:\\Games\\Comfyui\\output\\a.png", "W:\\Games\\Comfyui\\output\\b.webp"]);
  assert.deepStrictEqual(extractPaths({}), []);
});

await okAsync("⑤ 状态词：认不出就是未完成（宁可多等一轮，不把半成品当成品）", () => {
  assert.strictEqual(readStatus({ status: "success" }), "done");
  assert.strictEqual(readStatus({ state: "已完成" }), "done");
  assert.strictEqual(readStatus({ status: "error", message: "oom" }), "failed");
  assert.strictEqual(readStatus({ status: "interrupted" }), "failed");
  assert.strictEqual(readStatus({ status: "running" }), "pending");
  assert.strictEqual(readStatus({ 谁知道呢: 1 }), "pending");
});

// ── 提交 → 轮询 → 取产物 ────────────────────────────────

const OUT = "W:\\Games\\Comfyui\\output\\portrait_00001.png";

/** 造一个假宿主：runTool 会按脚本依次回话，并记下每次收到的参数。 */
function fakeSdk(script, { catalogTools } = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    environments: {
      async list() { return [{ environmentId: "env-1", revision: 3, state: "running" }]; },
      async create() { return { environmentId: "env-new", revision: 1, state: "running" }; },
      async catalog() { return { tools: catalogTools ?? [{ ref: "app:comfyui-hana", name: "comfyui" }] }; },
      async runTool(input) {
        calls.push(input);
        const r = script[Math.min(i, script.length - 1)];
        i++;
        return { result: r };
      }
    }
  };
}

await okAsync("⑥ 提交 → 轮询 → 取产物：三个动作的参数形状都对", async () => {
  const sdk = fakeSdk([
    { details: { comfyui: { promptId: "p-1" } } },   // submit
    { status: "running" },                            // query 1
    { status: "success" },                            // query 2
    { files: [{ path: OUT }] }                        // result
  ]);
  const env = await ensureEnvironment(sdk);
  const tool = pickComfyTool(await sdk.environments.catalog({}));
  const out = await renderViaComfy({
    sdk, env, tool, template: "我的立绘.json", promptTarget: "6.text", prompt: "守夜法师",
    pollMs: 1, sleep: async () => {}
  });

  assert.strictEqual(out.path, OUT);
  assert.strictEqual(out.promptId, "p-1");

  const [submit, q1, q2, res] = sdk.calls;
  assert.strictEqual(submit.args.action, "submit");
  assert.deepStrictEqual(submit.args.workflow, { template: "我的立绘.json" });
  assert.deepStrictEqual(submit.args.inputs, { "6.text": "守夜法师" }, "inputs 的键必须是 <节点>.<输入名>");
  assert.strictEqual(submit.ref, "app:comfyui-hana");
  assert.strictEqual(submit.toolName, "comfyui");
  assert.strictEqual(submit.environmentId, "env-1");
  assert.strictEqual(submit.revision, 3);
  assert.strictEqual(q1.args.action, "query");
  assert.strictEqual(q1.args.promptId, "p-1");
  assert.strictEqual(q2.args.action, "query");
  assert.strictEqual(res.args.action, "result");
});

await okAsync("⑦ 提交就带产物（同步工作流）→ 不白等", async () => {
  const sdk = fakeSdk([{ details: { comfyui: { promptId: "p-2" } }, files: [{ path: OUT }] }]);
  const out = await renderViaComfy({
    sdk, env: { environmentId: "env-1", revision: 1 },
    tool: { ref: "app:comfyui-hana", name: "comfyui" },
    template: "t.json", promptTarget: "6.text", prompt: "x", sleep: async () => {}
  });
  assert.strictEqual(out.path, OUT);
  assert.strictEqual(out.waitedMs, 0);
  assert.strictEqual(sdk.calls.length, 1, "提交就拿到产物，不该再去轮询");
});

await okAsync("⑧ 失败要说清原因；等不到要说等多久", async () => {
  const bad = fakeSdk([{ details: { comfyui: { promptId: "p-3" } } }, { status: "error", message: "node_errors: 6.text 不存在" }]);
  await assert.rejects(
    () => renderViaComfy({
      sdk: bad, env: { environmentId: "e", revision: 1 },
      tool: { ref: "app:comfyui-hana", name: "comfyui" },
      template: "t", promptTarget: "6.text", prompt: "x", pollMs: 1, sleep: async () => {}
    }),
    (e) => /失败/.test(e.message) && /node_errors/.test(e.message)
  );

  const slow = fakeSdk([{ details: { comfyui: { promptId: "p-4" } } }, { status: "running" }]);
  await assert.rejects(
    () => renderViaComfy({
      sdk: slow, env: { environmentId: "e", revision: 1 },
      tool: { ref: "app:comfyui-hana", name: "comfyui" },
      template: "t", promptTarget: "6.text", prompt: "x",
      timeoutMs: 5, pollMs: 1, sleep: async () => {}
    }),
    /还没出图|队列/
  );

  // 没 id 就没法取产物，直接说清
  const noId = fakeSdk([{ 谁知道呢: 1 }]);
  await assert.rejects(
    () => renderViaComfy({
      sdk: noId, env: { environmentId: "e", revision: 1 },
      tool: { ref: "app:comfyui-hana", name: "comfyui" },
      template: "t", promptTarget: "6.text", prompt: "x", sleep: async () => {}
    }),
    /没说这次任务的 id/
  );
});

await okAsync("⑨ 缺件时先说缺什么，不是一路撞到 node_errors", async () => {
  const sdk = fakeSdk([]);
  const base = { sdk, env: { environmentId: "e", revision: 1 }, tool: { ref: "r", name: "n" }, prompt: "x", sleep: async () => {} };
  await assert.rejects(() => renderViaComfy({ ...base, template: "", promptTarget: "6.text" }), /还没选工作流/);
  await assert.rejects(() => renderViaComfy({ ...base, template: "t", promptTarget: "" }), /提示词写进哪个节点/);
  await assert.rejects(() => renderViaComfy({ ...base, template: "t", promptTarget: "6.text", prompt: "  " }), /没有提示词/);
  await assert.rejects(() => renderViaComfy({ sdk: {}, env: base.env, tool: base.tool, template: "t", promptTarget: "6.text", prompt: "x" }),
    /app\/environments\.manage/);
});

await okAsync("⑩ ensureEnvironment：优先复用已有环境，不反复新建", async () => {
  const sdk = fakeSdk([]);
  const env = await ensureEnvironment(sdk);
  assert.strictEqual(env.environmentId, "env-1", "该复用已经在跑的那个");

  const noList = { environments: { async list() { throw new Error("列不出来"); }, async create() { return { environmentId: "env-x", revision: 2 }; } } };
  const env2 = await ensureEnvironment(noList);
  assert.strictEqual(env2.environmentId, "env-x", "列不出来才新建");
});

// ── 开关与配置 ──────────────────────────────────────────

await okAsync("⑪ 配置：缺字段没改、空串清空；本机这条路没配全就说缺哪一项", () => {
  let c = mergeImageConfig({}, { backend: "comfyui", workflow: "我.json", promptTarget: "6.text" });
  assert.strictEqual(c.backend, "comfyui");
  assert.strictEqual(imageReadiness(c).ready, true);

  c = mergeImageConfig(c, { promptTarget: "" });
  assert.strictEqual(c.promptTarget, "");
  assert.match(imageReadiness(c).reason, /提示词节点/);

  c = mergeImageConfig(c, { promptTarget: "乱填的" });
  assert.match(imageReadiness(c).reason, /节点号\.输入名/, imageReadiness(c).reason);

  const host = mergeImageConfig({}, { backend: "host" });
  assert.strictEqual(imageReadiness(host).ready, true, "宿主那条路不该被工作流卡住");
  assert.ok(BACKENDS.some((b) => b.id === "host") && BACKENDS.some((b) => b.id === "comfyui"));

  // 不认识的后端名当没改
  assert.strictEqual(mergeImageConfig(host, { backend: "nope" }).backend, "host");
  assert.strictEqual(publicImageConfig(c).ready, false);
});

await okAsync("⑫ /media/engines：两条路各自的可用性分开报，缺什么说什么", async () => {
  const app = makeApp();
  const sdk = fakeSdk([], { catalogTools: [{ ref: "app:comfyui-hana", name: "comfyui" }] });
  sdk.media = { async generateImage() { return { ok: true, files: [] }; } };
  registerMediaRoutes(app, { sdk, characterRepo: charRepo, transfer, dataDir: tmp });

  const r = await request(app, "GET", "/media/engines");
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.host.available, true);
  assert.strictEqual(r.data.comfyui.available, true);
  assert.strictEqual(r.data.comfyui.tool, "comfyui");
  assert.strictEqual(r.data.backend, "host");

  // 没装 ComfyUI 的机器：宿主那条路照样可用，本机那条要给出原因
  const app2 = makeApp();
  const bare = { media: { async generateImage() {} }, environments: { async list() { return []; }, async create() { return { environmentId: "e", revision: 1 }; }, async catalog() { return { tools: [] }; } } };
  registerMediaRoutes(app2, { sdk: bare, characterRepo: charRepo, transfer, dataDir: path.join(tmp, "engines2") });
  const r2 = await request(app2, "GET", "/media/engines");
  assert.strictEqual(r2.data.host.available, true);
  assert.strictEqual(r2.data.comfyui.available, false);
  assert.match(r2.data.comfyui.reason, /ComfyUI/, r2.data.comfyui.reason);
});

await okAsync("⑬ 换到 comfyui 后，portrait 真的走 runTool 那条路并把产物写成头像", async () => {
  const outDir = path.join(tmp, "comfy-run");
  const outFile = path.join(outDir, "portrait_00001.png");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, Buffer.alloc(48, 9));

  const app = makeApp();
  const sdk = fakeSdk([
    { details: { comfyui: { promptId: "p-9" } } },   // submit
    { status: "success" },                            // query
    { files: [{ path: outFile }] }                    // result
  ]);
  registerMediaRoutes(app, { sdk, characterRepo: charRepo, transfer, dataDir: outDir });

  await request(app, "PUT", "/media/config", { body: { backend: "comfyui", workflow: "薇拉.json", promptTarget: "6.text" } });
  const r = await request(app, "POST", "/media/portrait", { body: { characterId: card.id } });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.via, "comfyui");
  assert.strictEqual(r.data.source, outFile);
  assert.strictEqual(r.data.file, "avatar.png");
  assert.ok(sdk.calls.some((c) => c.args.action === "submit" && c.args.inputs["6.text"].includes("薇拉")),
    "提示词没进到工作流里");

  const read = await transfer.readAvatar(card.id);
  assert.ok(read && read.buffer.length === 48, "头像没落盘或字节不对");
});

await okAsync("⑭ 选了 comfyui 但没配全 → 明说缺什么，且**不去打扰宿主**", async () => {
  const app = makeApp();
  let touched = false;
  const sdk = fakeSdk([]);
  sdk.environments.runTool = async () => { touched = true; return { result: {} }; };
  registerMediaRoutes(app, { sdk, characterRepo: charRepo, transfer, dataDir: path.join(tmp, "incomplete") });

  await request(app, "PUT", "/media/config", { body: { backend: "comfyui", workflow: "", promptTarget: "" } });
  const r = await request(app, "POST", "/media/portrait", { body: { characterId: card.id } });
  assert.strictEqual(r.status, 400, `状态 ${r.status}`);
  assert.match(r.error || "", /工作流/, r.error);
  assert.strictEqual(touched, false, "没配全就不该去提交任务");
});

console.log(`\n${fail === 0 ? "✅" : "❌"} 换引擎：${pass} 过 / ${fail} 败\n`);
process.exit(fail === 0 ? 0 : 1);
