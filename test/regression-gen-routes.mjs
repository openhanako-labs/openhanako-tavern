// test/regression-gen-routes.mjs — 生成器的 HTTP 面
//
// 用 route-harness 的离线台子跑。这里锁三件事：
//   ① 三条路由都注册了（静态检查只能证明"写在那儿"）
//   ② 提交 → 轮询 的状态机真的会走到 done，结果形状对
//   ③ 失败要说清是**哪一步**卡住——"生成失败了"这句话对用户没有价值，
//      "检索没取到任何材料（萌娘百科: 出网未就绪）"才有

import assert from "node:assert";

import { makeApp, request } from "./lib/route-harness.mjs";

const { registerGenRoutes } = await import("../lib/gen/routes.js");
const { resetJobs } = await import("../lib/gen/job.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 生成器 · HTTP 面 ===\n");

const ARTICLE = `<html><head><title>x</title></head><body><div class="mw-parser-output">
<p>初音未来是 Crypton Future Media 开发的歌声合成软件，2007 年发售。</p></div></body></html>`;

const SEARCH = `<ul><li><a href="/%E5%88%9D%E9%9F%B3%E6%9C%AA%E6%9D%A5" title="初音未来">初音未来</a></li></ul>`;

const FACTS_JSON = JSON.stringify([
  { fact: "初音未来是 Crypton Future Media 开发的歌声合成软件。",
    source: { url: "https://zh.moegirl.org.cn/%E5%88%9D%E9%9F%B3%E6%9C%AA%E6%9D%A5", title: "初音未来", tier: "community" } }
]);

const COMPOSE_JSON = JSON.stringify({
  card: {
    name: "初音未来",
    description: "初音未来是 Crypton Future Media 开发的歌声合成软件。她的生日是 8 月 31 日。",
    personality: "活泼",
    scenario: "录音室",
    first_mes: "「今天也一起唱吧。」",
    mes_example: "",
    creator_notes: "由 eleckoi 生成",
    tags: ["歌声合成"]
  },
  book: {
    entries: [{ keys: ["初音未来"], content: "初音未来是 Crypton Future Media 开发的歌声合成软件。", position: "before_char" }]
  }
});

/** 按 systemPrompt 判断这是第几次调用。 */
function stubLlm() {
  return {
    calls: [],
    async generate(messages, opts) {
      const sys = String(opts?.systemPrompt || "");
      this.calls.push(sys.slice(0, 24));
      if (sys.includes("你只做抽取")) return { content: FACTS_JSON };
      return { content: COMPOSE_JSON };
    }
  };
}

const resp = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => body,
  json: async () => JSON.parse(body)
});

function makeNet({ works = true } = {}) {
  return {
    fetch: async (url) => {
      if (!works) throw Object.assign(new Error("boom"), { cause: { code: "ERR_ACCESS_DENIED" } });
      if (url.includes("index.php?search=")) return resp(SEARCH);
      if (url.includes("moegirl.org.cn/")) return resp(ARTICLE);
      if (url.includes("export.arxiv.org")) return resp("<feed xmlns='x'></feed>");
      return resp("nope", 404);
    }
  };
}

async function waitDone(app, id, { tries = 60 } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = await request(app, "GET", `/gen/jobs/${id}`);
    if (!r) return null;
    if (r.data?.state !== "running") return r.data;
    await new Promise((res) => setTimeout(res, 20));
  }
  return null;
}

// ── ① 路由注册 ──

await okAsync("① 三条路由都注册了", async () => {
  resetJobs();
  const app = makeApp();
  registerGenRoutes(app, { llm: stubLlm(), net: makeNet() });
  const paths = app.routes.map(r => `${r.method} ${r.path}`);
  for (const need of ["GET /gen/sources", "POST /gen/jobs", "GET /gen/jobs/:id"]) {
    assert.ok(paths.includes(need), `缺 ${need}；实为 ${paths.join(" / ")}`);
  }
});

// ── ② 体检 ──

await okAsync("② GET /gen/sources：通了要报通、不通要报原因", async () => {
  resetJobs();
  const app = makeApp();
  registerGenRoutes(app, { llm: stubLlm(), net: makeNet({ works: false }) });
  const r = await request(app, "GET", "/gen/sources");
  assert.strictEqual(r.status, 200, `状态 ${r.status}`);
  assert.strictEqual(r.data.sources.length, 2);
  assert.ok(r.data.sources.every(s => s.ok === false), "桩里全不通，不该报通");
  assert.ok(r.data.sources.every(s => /ERR_ACCESS_DENIED/.test(s.note || "")), "不通的原因没写清");
});

// ── ③ 提交 → 轮询 → done ──

await okAsync("③ 提交 → 轮询到 done，结果里有卡/世界书/事实/被删内容计数", async () => {
  resetJobs();
  const app = makeApp();
  registerGenRoutes(app, { llm: stubLlm(), net: makeNet() });

  const sub = await request(app, "POST", "/gen/jobs", { body: { query: "未来歌姬" } });
  assert.strictEqual(sub.status, 200, `状态 ${sub.status}：${sub.error || ""}`);
  assert.ok(sub.data.id, "没返回任务 id");

  const done = await waitDone(app, sub.data.id);
  assert.ok(done, "轮询超时，任务没结束");
  assert.strictEqual(done.state, "done", `state=${done.state} error=${done.error}`);
  assert.strictEqual(done.result.card.name, "初音未来");
  assert.strictEqual(done.result.book.entries.length, 1);
  assert.ok(done.result.facts.length >= 1, "事实清单空");
  assert.ok(Array.isArray(done.result.materials) && done.result.materials.length >= 1, "材料清单空");
  // 组装里编的"她的生日是 8 月 31 日"该被核对删掉并计数
  assert.ok(done.result.dropped.sentences >= 1, "越界句子没被删/没计数");
  assert.ok(!done.result.card.description.includes("8 月 31 日"), "越界句子还在卡里");
  assert.ok(done.notes.some(n => n.source === "moegirl" && n.ok === true), "来源成败没记");
});

// ── ④ 检索全失败 ──

await okAsync("④ 检索全失败 → failed，且说清是检索这一步、谁坏的", async () => {
  resetJobs();
  const app = makeApp();
  registerGenRoutes(app, { llm: stubLlm(), net: makeNet({ works: false }) });
  const sub = await request(app, "POST", "/gen/jobs", { body: { query: "未来歌姬" } });
  const done = await waitDone(app, sub.data.id);
  assert.strictEqual(done.state, "failed");
  assert.strictEqual(done.phase, "failed");
  assert.ok(/检索没取到任何材料/.test(done.error || ""), `错误话不对：${done.error}`);
  assert.ok(/ERR_ACCESS_DENIED/.test(done.error || ""), "没说清是谁坏的：" + done.error);
});

// ── ⑤ 抽取为空 ──

await okAsync("⑤ 抽取结果为空 → failed，说清是抽取这一步", async () => {
  resetJobs();
  const app = makeApp();
  const llm = {
    async generate(messages, opts) {
      if (String(opts?.systemPrompt || "").includes("你只做抽取")) return { content: "[]" };
      return { content: COMPOSE_JSON };
    }
  };
  registerGenRoutes(app, { llm, net: makeNet() });
  const sub = await request(app, "POST", "/gen/jobs", { body: { query: "x" } });
  const done = await waitDone(app, sub.data.id);
  assert.strictEqual(done.state, "failed");
  assert.ok(/抽取结果里没有任何带出处的事实/.test(done.error || ""), done.error);
});

// ── ⑥ 未知 id ──

await okAsync("⑥ 未知 id → 404", async () => {
  resetJobs();
  const app = makeApp();
  registerGenRoutes(app, { llm: stubLlm(), net: makeNet() });
  const r = await request(app, "GET", "/gen/jobs/gen-nope");
  assert.strictEqual(r.status, 404, `状态 ${r.status}`);
  assert.ok(/任务不存在/.test(r.error || ""), r.error);
});

await okAsync("⑦ 没有 query → 400，不是默默建一个空任务", async () => {
  resetJobs();
  const app = makeApp();
  registerGenRoutes(app, { llm: stubLlm(), net: makeNet() });
  const r = await request(app, "POST", "/gen/jobs", { body: {} });
  assert.strictEqual(r.status, 400, `状态 ${r.status}`);
  assert.ok(/query/.test(r.error || ""), r.error);
});

console.log(`\n${fail === 0 ? "✅" : "❌"} 生成器 HTTP 面：${pass} 过 / ${fail} 败\n`);
process.exit(fail === 0 ? 0 : 1);
