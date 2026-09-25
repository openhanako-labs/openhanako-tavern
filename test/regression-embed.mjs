// test/regression-embed.mjs — 用宿主的 embedding 模型算向量（离线测）
//
// 这一块的命在哪
// --------------
// ① **凭据不能漏出去**。这里注入的是假 key，但它长得很像一个真 key；
//    测试会去返回值、错误消息里搜它。搜到就是红。
// ② **信封要拆**。provider:credentials 的返回是联合类型：
//    成功 {apiKey, baseUrl, …} / 失败 {error}。
//    这个仓库在这件事上栽过三次，所以这里把它钉死：
//    带 error 的返回**必须当成失败**，不许当成"没 key 但继续"。
// ③ **形状要逐条对**。条数/维数对不上，比抛异常更难发现——
//    静默错位的向量会一路走到底，最后在检索质量上以"效果不好"的样子出现。

import assert from "node:assert";

const { embed, status, embedTexts, pickEmbeddingModel, normalizeTarget } =
  await import("../lib/embed/service.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 宿主的 embedding 模型 ===\n");

const SECRET = "sk-fake-THIS-MUST-NOT-LEAK-0000";

/** 假 bus：记录被问了什么，按 verb 回。 */
function makeBus({
  models = [{ id: "BAAI/bge-m3", providerId: "siliconflow" }],
  catalog = [
    { id: "BAAI/bge-m3", providerId: "siliconflow" },
    { id: "BAAI/bge-reranker-v2-m3", providerId: "siliconflow" },
    { id: "Qwen/Qwen3-8B", providerId: "siliconflow" }
  ],
  credentials = null
} = {}) {
  const calls = [];
  return {
    calls,
    async request(verb, input = {}) {
      calls.push({ verb, input });
      if (verb === "provider:models-by-type") return { models };
      if (verb === "model:list") return { models: catalog };
      if (verb === "provider:credentials") {
        if (credentials !== null) return credentials;
        return { apiKey: SECRET, baseUrl: "https://api.example.com/v1", api: "openai-completions" };
      }
      throw new Error(`没料到的 verb: ${verb}`);
    }
  };
}

/** 假 fetch：记录请求，按需要回。 */
function makeFetch({ ok = true, status = 200, payload = null, raw = null } = {}) {
  const seen = [];
  const fn = async (url, init) => {
    seen.push({ url, init, headers: init?.headers, body: JSON.parse(init?.body || "{}") });
    if (raw !== null) return { ok, status, text: async () => raw };
    const body = payload ?? {
      data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }],
      usage: { total_tokens: 12 }
    };
    return { ok, status, text: async () => JSON.stringify(body) };
  };
  return { fn, seen };
}

/** 深扫一个对象里有没有出现某段字符串。 */
function containsSecret(v, needle, depth = 0) {
  if (depth > 8 || v == null) return false;
  if (typeof v === "string") return v.includes(needle);
  if (Array.isArray(v)) return v.some((x) => containsSecret(x, needle, depth + 1));
  if (typeof v === "object") return Object.values(v).some((x) => containsSecret(x, needle, depth + 1));
  return false;
}

// ── 正常路径 ──
await okAsync("找到模型 → 取凭据 → 算向量：维数/条数/来源都对", async () => {
  const bus = makeBus();
  const { fn } = makeFetch();
  const r = await embed(bus, ["甲", "乙"], { fetchImpl: fn });
  assert.strictEqual(r.dimension, 3);
  assert.strictEqual(r.vectors.length, 2);
  assert.strictEqual(r.model, "BAAI/bge-m3");
  assert.strictEqual(r.providerId, "siliconflow");
  assert.deepStrictEqual(r.vectors[0], [0.1, 0.2, 0.3]);
});

await okAsync("问宿主的动词与参数正确（provider:models-by-type 带 type=embedding）", async () => {
  const bus = makeBus();
  const { fn } = makeFetch({ payload: { data: [{ embedding: [0.1, 0.2, 0.3] }] } });
  await embed(bus, ["甲"], { fetchImpl: fn });
  const verbs = bus.calls.map((c) => c.verb);
  assert.deepStrictEqual(verbs, ["provider:models-by-type", "provider:credentials"]);
  assert.strictEqual(bus.calls[0].input.type, "embedding");
  assert.strictEqual(bus.calls[1].input.providerId, "siliconflow");
});

await okAsync("打的是 {baseUrl}/embeddings —— 已有的 /v1 不重复", async () => {
  const bus = makeBus();
  const { fn, seen } = makeFetch();
  await embed(bus, ["甲", "乙"], { fetchImpl: fn });
  assert.strictEqual(seen[0].url, "https://api.example.com/v1/embeddings");
});

await okAsync("带上了宿主发的凭据（Authorization: Bearer …）", async () => {
  const bus = makeBus();
  const { fn, seen } = makeFetch();
  await embed(bus, ["甲", "乙"], { fetchImpl: fn });
  assert.strictEqual(seen[0].headers.authorization, `Bearer ${SECRET}`);
});

await okAsync("请求体形状：model 用宿主的名字；多条用数组、单条用字符串", async () => {
  const bus = makeBus();
  const f1 = makeFetch();
  await embed(bus, ["甲", "乙"], { fetchImpl: f1.fn });
  assert.strictEqual(f1.seen[0].body.model, "BAAI/bge-m3");
  assert.deepStrictEqual(f1.seen[0].body.input, ["甲", "乙"]);

  const f2 = makeFetch({ payload: { data: [{ embedding: [1, 2, 3] }] } });
  await embed(makeBus(), ["甲"], { fetchImpl: f2.fn });
  assert.strictEqual(f2.seen[0].body.input, "甲");
});

await okAsync("宿主给的自定义 auth headers 会并进去", async () => {
  const bus = makeBus({
    credentials: { apiKey: SECRET, baseUrl: "https://x.example.com/v1", headers: { "x-org": "abc" } }
  });
  const { fn, seen } = makeFetch();
  await embed(bus, ["甲", "乙"], { fetchImpl: fn });
  assert.strictEqual(seen[0].headers["x-org"], "abc");
});

// ── 凭据不出门 ──
await okAsync("返回里搜不到凭据（返回值不是通道）", async () => {
  const bus = makeBus();
  const { fn } = makeFetch();
  const r = await embed(bus, ["甲", "乙"], { fetchImpl: fn });
  assert.ok(!containsSecret(r, SECRET), "返回值里出现了 key！");
});

await okAsync("端点拒绝时，报错里也不回显凭据", async () => {
  const bus = makeBus();
  const { fn } = makeFetch({ ok: false, status: 403, raw: '{"error":"forbidden"}' });
  let msg = null;
  try { await embed(bus, ["甲", "乙"], { fetchImpl: fn }); }
  catch (e) { msg = e.message; }
  assert.ok(msg, "本该抛错");
  assert.match(msg, /403/);
  assert.ok(!msg.includes(SECRET), "错误消息里出现了 key！");
});

// ── 信封必须拆（三次栽过的那个坑） ──
await okAsync("凭据返回是 {error} → 当成失败，不许继续", async () => {
  const bus = makeBus({ credentials: { error: "app/provider.credentials.read 未授权" } });
  const { fn } = makeFetch();
  let msg = null;
  try { await embed(bus, ["甲"], { fetchImpl: fn }); }
  catch (e) { msg = e.message; }
  assert.ok(msg && msg.includes("取凭据被拒"), `错的失败信息：${msg}`);
  assert.ok(msg.includes("未授权"), "把宿主给的理由丢了");
});

await okAsync("返回成功但没 apiKey → 也要说清，不许硬发", async () => {
  const bus = makeBus({ credentials: { baseUrl: "https://x/v1" } });
  const { fn, seen } = makeFetch();
  let msg = null;
  try { await embed(bus, ["甲"], { fetchImpl: fn }); }
  catch (e) { msg = e.message; }
  assert.ok(msg && msg.includes("没有 apiKey"), `错的失败信息：${msg}`);
  assert.strictEqual(seen.length, 0, "凭据不全却发了请求");
});

// ── 三种失败要分得开 ──
await okAsync("没有 embedding 模型（按类型空 + 扫目录也没）→ 说“没有模型”", async () => {
  const bus = makeBus({ models: [], catalog: [{ id: "gpt-5", providerId: "openai" }] });
  const { fn } = makeFetch();
  let msg = null;
  try { await embed(bus, ["甲"], { fetchImpl: fn }); }
  catch (e) { msg = e.message; }
  assert.ok(msg && msg.includes("宿主里没有 embedding 模型"), `错的失败信息：${msg}`);
});

// ── 回退：按类型查空（宿主把没写 type 的一律算 chat）时扫目录 ──
await okAsync("按类型查空 → 回退扫目录，认出 bge 而排掉 rerank", async () => {
  const bus = makeBus({ models: [] });   // 按类型给 0 条
  const { fn } = makeFetch();
  const r = await embed(bus, ["甲", "乙"], { fetchImpl: fn });
  assert.strictEqual(r.model, "BAAI/bge-m3");
  assert.strictEqual(r.foundBy, "scan");
  assert.ok(bus.calls.some((c) => c.verb === "model:list"), "没去扫目录");
});

await okAsync("扫目录也会排掉 rerank / 多模态 embedding", async () => {
  const { isEmbeddingCandidate } = await import("../lib/embed/service.js");
  assert.strictEqual(isEmbeddingCandidate({ id: "BAAI/bge-m3" }), true);
  assert.strictEqual(isEmbeddingCandidate({ id: "text-embedding-3-small" }), true);
  assert.strictEqual(isEmbeddingCandidate({ id: "BAAI/bge-reranker-v2-m3" }), false);
  assert.strictEqual(isEmbeddingCandidate({ id: "Qwen/Qwen2-VL-embed" }), false);
  assert.strictEqual(isEmbeddingCandidate({ id: "gpt-5" }), false);
  assert.strictEqual(isEmbeddingCandidate({}), false);
});

await okAsync("回退扫目录时条目没有 provider → 说清卡在 provider，不去瞎猜", async () => {
  const bus = makeBus({ models: [], catalog: [{ id: "BAAI/bge-m3" }] });
  const { fn } = makeFetch();
  let msg = null;
  try { await embed(bus, ["甲"], { fetchImpl: fn }); }
  catch (e) { msg = e.message; }
  assert.ok(msg && msg.includes("providerId"), `错的失败信息：${msg}`);
});

await okAsync("默认路径仍按类型走（不白白扫目录）", async () => {
  const bus = makeBus();
  const { fn } = makeFetch();
  const r = await embed(bus, ["甲", "乙"], { fetchImpl: fn });
  assert.strictEqual(r.foundBy, "by-type");
  assert.ok(!bus.calls.some((c) => c.verb === "model:list"), "按类型已拿到，不该再扫目录");
});

await okAsync("列模型就被拒（没授权）→ 报错要点出可能是缺授权", async () => {
  const bus = { async request() { throw new Error("permission denied"); } };
  const { fn } = makeFetch();
  let msg = null;
  try { await embed(bus, ["甲"], { fetchImpl: fn }); }
  catch (e) { msg = e.message; }
  assert.ok(msg && msg.includes("app/models.read"), `错的失败信息：${msg}`);
});

await okAsync("凭据里没有 baseUrl → 说清不知道往哪发", async () => {
  const direct = await import("../lib/embed/service.js");
  let msg = null;
  try { await direct.embedTexts(["甲"], { baseUrl: null, apiKey: SECRET, modelId: "m" }); }
  catch (e) { msg = e.message; }
  assert.ok(msg && msg.includes("baseUrl"), `错的失败信息：${msg}`);
});

// ── 形状必须逐条对 ──
await okAsync("条数对不上 → 抛错（不许静默错位）", async () => {
  const { fn } = makeFetch({ payload: { data: [{ embedding: [1, 2, 3] }] } });
  let msg = null;
  try { await embedTexts(["a", "b"], { baseUrl: "https://x/v1", apiKey: SECRET, modelId: "m", fetchImpl: fn }); }
  catch (e) { msg = e.message; }
  assert.ok(msg && msg.includes("条数对不上"), `错的失败信息：${msg}`);
});

await okAsync("维数不一致 → 抛错", async () => {
  const { fn } = makeFetch({ payload: { data: [{ embedding: [1, 2, 3] }, { embedding: [1, 2] }] } });
  let msg = null;
  try { await embedTexts(["a", "b"], { baseUrl: "https://x/v1", apiKey: SECRET, modelId: "m", fetchImpl: fn }); }
  catch (e) { msg = e.message; }
  assert.ok(msg && msg.includes("维数不一致"), `错的失败信息：${msg}`);
});

await okAsync("没有 embedding 数组 / 不是 JSON → 各自说清", async () => {
  const bad = makeFetch({ payload: { object: "list" } });
  let m1 = null;
  try { await embedTexts(["a"], { baseUrl: "https://x/v1", apiKey: SECRET, modelId: "m", fetchImpl: bad.fn }); }
  catch (e) { m1 = e.message; }
  assert.ok(m1 && m1.includes("data 数组"), `错的失败信息：${m1}`);

  const junk = makeFetch({ raw: "<html>500</html>" });
  let m2 = null;
  try { await embedTexts(["a"], { baseUrl: "https://x/v1", apiKey: SECRET, modelId: "m", fetchImpl: junk.fn }); }
  catch (e) { m2 = e.message; }
  assert.ok(m2 && m2.includes("不是 JSON"), `错的失败信息：${m2}`);
});

await okAsync("连不上端点 → 报错带上 URL 与原因", async () => {
  const fn = async () => { throw new Error("ECONNREFUSED"); };
  let msg = null;
  try { await embedTexts(["a"], { baseUrl: "https://dead.example.com/v1", apiKey: SECRET, modelId: "m", fetchImpl: fn }); }
  catch (e) { msg = e.message; }
  assert.ok(msg && msg.includes("dead.example.com") && msg.includes("ECONNREFUSED"), `错的失败信息：${msg}`);
});

// ── 挑模型 ──
await okAsync("指定模型名时优先命中它（忽略大小写与斜杠）", async () => {
  const models = [{ id: "other-xl" }, { id: "BAAI/bge-m3" }];
  const picked = pickEmbeddingModel(models, "baai-bge-m3");
  assert.strictEqual(picked.id, "BAAI/bge-m3");
});

await okAsync("没指定就取第一个；空列表回 null", async () => {
  assert.strictEqual(pickEmbeddingModel([{ id: "a" }, { id: "b" }]).id, "a");
  assert.strictEqual(pickEmbeddingModel([]), null);
  assert.strictEqual(pickEmbeddingModel(null), null);
});

await okAsync("字段名不保证：provider/providerId/model/name 都认", async () => {
  assert.deepStrictEqual(normalizeTarget({ model: "m", provider: "p" }), { providerId: "p", modelId: "m" });
  assert.deepStrictEqual(normalizeTarget({ id: "m2" }, "fallback"), { providerId: "fallback", modelId: "m2" });
  assert.strictEqual(normalizeTarget({}), null);
});

// ── 诊断面 ──
await okAsync("status：能用时报 ok，并说清走的是哪个模型", async () => {
  const s = await status(makeBus());
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.model, "BAAI/bge-m3");
  assert.strictEqual(s.candidates, 1);
});

await okAsync("status：按类型查空时把“这是正常的”说清楚（扫目录是回退）", async () => {
  const s = await status(makeBus({ models: [] }));
  assert.strictEqual(s.foundBy, "scan");
  assert.match(s.note, /一律算 chat/);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.model, "BAAI/bge-m3");
});

await okAsync("status：不能用时说清卡在哪一步（不抛错）", async () => {
  const s1 = await status(makeBus({ models: [], catalog: [{ id: "gpt-5" }] }));
  assert.strictEqual(s1.ok, false);
  assert.strictEqual(s1.step, "models");

  const s2 = await status(makeBus({ credentials: { error: "未授权" } }));
  assert.strictEqual(s2.ok, false);
  assert.match(s2.note, /未授权/);
});

// ── 复核提出的几条（每条对应一个真实失败模式） ──
await okAsync("宿主给的 headers 覆盖不了我们拼的 Authorization（顺序 + 过滤两道）", async () => {
  const bus = makeBus({
    credentials: {
      apiKey: SECRET,
      baseUrl: "https://api.example.com/v1",
      headers: { authorization: "Bearer EVIL", "x-org": "abc" }
    }
  });
  const { fn, seen } = makeFetch();
  await embed(bus, ["甲", "乙"], { fetchImpl: fn });
  assert.strictEqual(seen[0].headers.authorization, `Bearer ${SECRET}`, "被宿主的 headers 顶掉了");
  assert.strictEqual(seen[0].headers["x-org"], "abc", "无关的自定义头该留着");
});

await okAsync("baseUrl 里夹的令牌不会进错误消息（只报 origin）", async () => {
  const TOKEN = "SECRETTOKEN-IN-QUERY-0123456789";
  const bus = makeBus({
    credentials: { apiKey: SECRET, baseUrl: `https://gw.example.com/v1?token=${TOKEN}` }
  });
  const fn = async () => { throw new Error("ECONNREFUSED"); };
  let msg = null;
  try { await embed(bus, ["甲"], { fetchImpl: fn }); } catch (e) { msg = e.message; }
  assert.ok(msg && msg.includes("gw.example.com"), `该报出主机：${msg}`);
  assert.ok(!msg.includes(TOKEN), `把查询串里的令牌回显了：${msg}`);
});

await okAsync("prefer=\"bge\" 不会选中 bge-reranker（先过滤再匹配）", async () => {
  const picked = pickEmbeddingModel(
    [{ id: "BAAI/bge-reranker-v2-m3" }, { id: "BAAI/bge-m3" }],
    "bge"
  );
  assert.strictEqual(picked.id, "BAAI/bge-m3");
});

await okAsync("凭据返回数组 → 说清是数组，不说“没有 apiKey”", async () => {
  const bus = makeBus({ credentials: [SECRET] });
  const { fn } = makeFetch();
  let msg = null;
  try { await embed(bus, ["甲"], { fetchImpl: fn }); } catch (e) { msg = e.message; }
  assert.ok(msg && msg.includes("数组"), `错的失败信息：${msg}`);
});

await okAsync("按类型查被拒（{error}）→ 不当成“没有模型”，把理由留着", async () => {
  const bus = {
    calls: [],
    async request(verb) {
      this.calls.push(verb);
      if (verb === "provider:models-by-type") return { error: "permission denied" };
      if (verb === "model:list") return { models: [] };
      throw new Error("没料到");
    }
  };
  const s = await status(bus);
  assert.strictEqual(s.ok, false);
  assert.match(s.typeError || "", /permission denied/, `该把宿主拒绝的理由留着：${JSON.stringify(s)}`);
});

await okAsync("id 启发式：embedding 单复数都认（“embedding”本来就含子串 embed）", async () => {
  const { isEmbeddingCandidate } = await import("../lib/embed/service.js");
  assert.strictEqual(isEmbeddingCandidate({ id: "mistral-embedding-model" }), true);
  assert.strictEqual(isEmbeddingCandidate({ id: "text-embeddings-3" }), true);
  assert.strictEqual(isEmbeddingCandidate({ id: "nomic-embed-text" }), true);
});

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 过 / ${fail} 不过\n`);
// ── 宿主那条面（models.embed）：长出来就用，没长就直连 ──
//
// 这两条测的不只是今天的代码，也是**契约**：哪天宿主真加了 embed，
// 上面那条断言就是它的验收标准。
await okAsync("宿主有 models.embed 就走它：不取凭据、不碰网络（via=host）", async () => {
  const bus = makeBus({ credentials: { apiKey: SECRET, baseUrl: "https://api.siliconflow.cn/v1" } });
  const seen = [];
  const modelsFace = {
    embed: async (req) => {
      seen.push(req);
      return { vectors: [[0.1, 0.2, 0.3]], dimension: 3 };
    }
  };
  const r = await embed(bus, ["一句话"], {
    modelsFace: modelsFace,
    fetchImpl: () => { throw new Error("走宿主那条路时不该碰网络"); }
  });
  assert.strictEqual(r.via, "host");
  assert.deepStrictEqual(r.vectors, [[0.1, 0.2, 0.3]]);
  assert.strictEqual(r.dimension, 3);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].model, "BAAI/bge-m3");
  assert.deepStrictEqual(seen[0].input, ["一句话"]);
  assert.ok(!JSON.stringify(bus.calls).includes("credentials"), "走宿主那条路不该去取凭据（能力收窄的意义就在这）");
});

await okAsync("宿主没这条面（只有 list/stream/utility/cancel）→ 退回直连（via=direct）", async () => {
  const bus = makeBus({ credentials: { apiKey: SECRET, baseUrl: "https://api.siliconflow.cn/v1" } });
  const r = await embed(bus, ["一句话"], {
    modelsFace: { list: async () => [], stream: async () => {}, utility: async () => {}, cancel: () => {} },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: [1, 2] }] }),
      text: async () => JSON.stringify({ data: [{ embedding: [1, 2] }] })
    })
  });
  assert.strictEqual(r.via, "direct");
});

await okAsync("出网走宿主的门：给了 network.fetch 就用它，绝不碰原始 fetch", async () => {
  const bus = makeBus({ credentials: { apiKey: SECRET, baseUrl: "https://api.siliconflow.cn/v1" } });
  const seen = [];
  const net = {
    fetch: async (url, init) => {
      seen.push({ url: String(url), method: init?.method });
      return { ok: true, text: async () => JSON.stringify({ data: [{ embedding: [1, 2] }] }), json: async () => ({ data: [{ embedding: [1, 2] }] }) };
    }
  };
  await embed(bus, ["一句话"], {
    net,
    fetchImpl: () => { throw new Error("该走宿主的门，不该碰原始 fetch"); }
  });
  assert.strictEqual(seen.length, 1, "应该只发一次");
  assert.strictEqual(seen[0].method, "POST");
  assert.ok(seen[0].url.includes("/embeddings"), `该打到 /embeddings，实际 ${seen[0].url}`);
});

process.exit(fail ? 1 : 0);
