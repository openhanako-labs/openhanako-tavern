// test/regression-tts.mjs — 语音合成：管子做在 App 里，水由用户填
//
// 这一套判据的重点不是"能不能出声"（那要真 key，测不了也不该测），
// 而是三件事：
//   ① 两根水龙头的**请求形状**对不对（形状错一次，用户看到的是 401 而不是原因）
//   ② 密钥**只进不出**（读接口回原文的那天，这套测试必须红）
//   ③ 出网两扇门都试过，且两扇都关时把两句话都说出来

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { makeApp, request } = await import("./lib/route-harness.mjs");
const { registerTtsRoutes } = await import("../lib/tts/routes.js");
const { synthesize, makeFetch } = await import("../lib/tts/service.js");
const { buildRequest, xmlEscape, clampText, PROVIDERS, DEFAULT_PROVIDER } = await import("../lib/tts/providers.js");
const { readConfig, mergeConfig, publicConfig, readiness } = await import("../lib/tts/config.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 语音合成 · 管子与形状 ===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-tts-"));

/** 记下收到的请求，回一段假音频。 */
function fakeFetch({ ok = true, status = 200, bytes = [1, 2, 3, 4], contentType = "audio/mpeg", text = "" } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? contentType : null) },
      async arrayBuffer() { return new Uint8Array(bytes).buffer; },
      async text() { return text; }
    };
  };
  fn.calls = calls;
  return fn;
}

const AZ = { provider: "azure", voice: "", rate: "", azure: { region: "eastasia", key: "k-123" }, openai: { baseUrl: "", model: "tts-1", key: "" } };
const OA = { provider: "openai", voice: "alloy", rate: "", azure: { region: "", key: "" }, openai: { baseUrl: "https://api.example.com/v1/", model: "tts-1", key: "sk-9" } };

// ── 提供方 ──────────────────────────────────────────────

await okAsync("① 默认是微软；两根水龙头都在", () => {
  assert.strictEqual(DEFAULT_PROVIDER, "azure");
  const ids = PROVIDERS.map((p) => p.id);
  assert.deepStrictEqual(ids, ["azure", "openai"]);
  assert.ok(PROVIDERS[0].defaultVoice.startsWith("zh-CN-"), "微软该给一个中文默认声音");
});

// ── 请求形状 ────────────────────────────────────────────

await okAsync("② 微软：URL 带 region、key 走专用头、body 是 SSML 且文本被转义", () => {
  const req = buildRequest(AZ, `她说：<a & b> "引号"`);
  assert.strictEqual(req.url, "https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1");
  assert.strictEqual(req.headers["Ocp-Apim-Subscription-Key"], "k-123");
  assert.match(req.headers["Content-Type"], /ssml\+xml/);
  assert.ok(req.body.startsWith("<speak"), "微软这条路 body 必须是 SSML");
  assert.ok(req.body.includes("zh-CN-XiaoxiaoNeural"), "默认声音没带上");
  assert.ok(req.body.includes("&lt;a &amp; b&gt; &quot;引号&quot;"), "XML 没转义，一个裸 & 就是 400：" + req.body);
  assert.ok(!req.body.includes("<a & b>"), "原文里没转义的尖括号不该出现在 body 里");
});

await okAsync("③ 微软：语速进了 SSML 的 prosody；不填就不加那层", () => {
  const noRate = buildRequest(AZ, "一");
  assert.ok(!noRate.body.includes("prosody"), "没填语速不该造出一层 prosody");
  const withRate = buildRequest({ ...AZ, rate: "-10%" }, "一");
  assert.ok(withRate.body.includes('<prosody rate="-10%">'), "语速没进去：" + withRate.body);
});

await okAsync("④ OpenAI 兼容：去尾斜杠、拼 /audio/speech、Bearer、JSON body", () => {
  const req = buildRequest(OA, "喂");
  assert.strictEqual(req.url, "https://api.example.com/v1/audio/speech");
  assert.strictEqual(req.headers.Authorization, "Bearer sk-9");
  const body = JSON.parse(req.body);
  assert.deepStrictEqual(body, { model: "tts-1", input: "喂", voice: "alloy", response_format: "mp3" });

  // 本机服务多半不带 key
  const noKey = buildRequest({ ...OA, openai: { ...OA.openai, key: "" } }, "喂");
  assert.ok(!("Authorization" in noKey.headers), "没填 key 就不该带 Authorization");
});

await okAsync("⑤ 缺一件就说一件，不让人拿着必错的请求去撞墙", () => {
  assert.throws(() => buildRequest({ ...AZ, azure: { region: "", key: "k" } }, "x"), /region/);
  assert.throws(() => buildRequest({ ...AZ, azure: { region: "e", key: "" } }, "x"), /key/);
  assert.throws(() => buildRequest({ ...AZ, azure: { region: "ea st", key: "k" } }, "x"), /region 看起来不对/);
  assert.throws(() => buildRequest({ ...OA, openai: { ...OA.openai, baseUrl: "" } }, "x"), /baseUrl/);
  assert.throws(() => buildRequest({ ...OA, openai: { ...OA.openai, baseUrl: "api.example.com" } }, "x"), /http/);
});

await okAsync("⑥ readiness 与 xmlEscape / clampText 的边", () => {
  assert.strictEqual(readiness(AZ).ready, true);
  assert.match(readiness({ provider: "azure", azure: { region: "", key: "" } }).reason, /region 与 key/);
  assert.strictEqual(xmlEscape(`<&>"'`), "&lt;&amp;&gt;&quot;&apos;");
  const long = "字".repeat(2500);
  assert.strictEqual(clampText(long).text.length, 2000);
  assert.strictEqual(clampText(long).truncated, 500);
  assert.strictEqual(clampText("  短的  ").text, "短的");
});

// ── 出网两扇门 ──────────────────────────────────────────

await okAsync("⑦ 正门开 → 只走正门，不碰侧门", async () => {
  const host = fakeFetch();
  const rr = await synthesize({ config: AZ, text: "你好", sdk: { network: { fetch: host } } });
  assert.strictEqual(host.calls.length, 1, "该只敲一次门");
  assert.strictEqual(rr.bytes ?? rr.buffer.length, 4);
  assert.strictEqual(rr.provider, "azure");
});

await okAsync("⑧ 正门关 → 退侧门；两扇都关时把两句话都写出来", async () => {
  // 正门抛权限类错，侧门用 fetchImpl 顶上
  const hostDenied = { network: { fetch: async () => { throw new Error("host: 域名不在白名单"); } } };
  const runtime = fakeFetch();
  const rr = await synthesize({ config: AZ, text: "你好", sdk: hostDenied, fetchImpl: runtime });
  assert.strictEqual(runtime.calls.length, 1);
  assert.strictEqual(rr.chars, 2);

  // 两扇都关：用 makeFetch，侧门打一个必定连不上的 loopback 端口
  const both = makeFetch({ network: { fetch: async () => { throw new Error("host: 域名不在白名单"); } } });
  await assert.rejects(
    () => both("http://127.0.0.1:1/x", { method: "POST" }),
    (e) => /两扇门都没开/.test(e.message) && /白名单/.test(e.message) && /本机运行时/.test(e.message),
    "两句话都要带出来"
  );
});

await okAsync("⑨ 供应商报错 → 带状态码与它给的原因，不是一句‘请求失败’", async () => {
  const bad = fakeFetch({ ok: false, status: 401, text: "{\"error\":\"invalid subscription key\"}" });
  await assert.rejects(
    () => synthesize({ config: AZ, text: "x", fetchImpl: bad }),
    (e) => /401/.test(e.message) && /invalid subscription key/.test(e.message)
  );

  const empty = fakeFetch({ bytes: [] });
  await assert.rejects(() => synthesize({ config: AZ, text: "x", fetchImpl: empty }), /0 字节/);

  await assert.rejects(
    () => synthesize({ config: { provider: "azure", azure: { region: "e", key: "k" } }, text: "   ", fetchImpl: fakeFetch() }),
    /没有要读的文字/
  );
});

// ── 配置与路由 ──────────────────────────────────────────

await okAsync("⑩ 密钥只进不出：写进去，读回来只有 hasKey", async () => {
  const app = makeApp();
  registerTtsRoutes(app, { sdk: null, dataDir: tmp });

  const put = await request(app, "PUT", "/tts/config", {
    body: { enabled: true, azure: { region: "eastasia", key: "secret-key-abc" } }
  });
  assert.strictEqual(put.status, 200, `状态 ${put.status}：${put.error || ""}`);
  assert.strictEqual(put.data.azure.hasKey, true);
  assert.ok(!JSON.stringify(put.data).includes("secret-key-abc"), "响应里出现了密钥原文：" + JSON.stringify(put.data));

  const get = await request(app, "GET", "/tts/config");
  assert.strictEqual(get.data.azure.region, "eastasia");
  assert.strictEqual(get.data.azure.hasKey, true);
  assert.ok(!("key" in get.data.azure), "读接口不该有 key 字段");
  assert.ok(!JSON.stringify(get).includes("secret-key-abc"), "读接口回出了密钥原文");
});

await okAsync("⑪ 空串 = 清空（否则‘清掉密钥’这件事没法表达）", async () => {
  const cfg = await readConfig(tmp);
  assert.strictEqual(cfg.azure.key, "secret-key-abc");

  const cleared = mergeConfig(cfg, { azure: { key: "" } });
  assert.strictEqual(cleared.azure.key, "");
  assert.strictEqual(cleared.azure.region, "eastasia", "没改的字段不该被顺手清掉");

  const kept = mergeConfig(cfg, { voice: "zh-CN-YunxiNeural" });
  assert.strictEqual(kept.azure.key, "secret-key-abc", "缺字段 = 没改");
  assert.strictEqual(publicConfig(cleared).azure.hasKey, false);
});

await okAsync("⑫ 没配好就合成 → 说清缺什么", async () => {
  const app = makeApp();
  registerTtsRoutes(app, { sdk: { network: { fetch: fakeFetch() } }, dataDir: path.join(tmp, "bare") });
  const r = await request(app, "POST", "/tts/speak", { body: { text: "读我" } });
  assert.strictEqual(r.status, 400, `状态 ${r.status}`);
  assert.match(r.error || "", /还没配好/, r.error);
  assert.match(r.error || "", /region|key|baseUrl/, "该指到具体缺哪一项：" + r.error);
});

await okAsync("⑬ speak → 文件真落盘，经音频路由取得到（字节一致）", async () => {
  const audio = [9, 8, 7, 6, 5];
  const app = makeApp();
  const sdk = { network: { fetch: fakeFetch({ bytes: audio }) } };
  registerTtsRoutes(app, { sdk, dataDir: tmp });

  await request(app, "PUT", "/tts/config", { body: { provider: "azure", azure: { region: "eastasia", key: "k" } } });
  const r = await request(app, "POST", "/tts/speak", { body: { text: "读我" } });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.ok, true);
  assert.strictEqual(r.data.bytes, audio.length);
  assert.strictEqual(r.data.provider, "azure");
  assert.match(r.data.url, /^tts\/audio\/[a-z0-9-]+\.mp3$/i);

  const name = r.data.name;
  const onDisk = fs.readFileSync(path.join(tmp, "generated", "tts", name));
  assert.deepStrictEqual([...onDisk], audio, "落盘的字节跟返回的不一样");

  const got = await request(app, "GET", `/tts/audio/${name}`);
  assert.strictEqual(got.status, 200, `状态 ${got.status}：${got.error || ""}`);
});

await okAsync("⑭ 音频路由只认我们自己写出来的名字", async () => {
  const app = makeApp();
  registerTtsRoutes(app, { sdk: null, dataDir: tmp });
  for (const bad of ["..%2F..%2Ftts.json", "abcdef.txt", "short.mp3", "a/b.mp3"]) {
    const r = await request(app, "GET", `/tts/audio/${bad}`);
    // 两种拒绝都算拒：路由本身不匹配（带斜杠那种），或者匹配了但过不了白名单正则。
    const refused = r === null || r.status >= 400;
    assert.ok(refused, `${bad} 不该被放行（${r === null ? "没匹配到路由" : "状态 " + r.status}）`);
  }

  // 正对照：真存在的那一个必须通（否则上面四条可以靠“全404”假装通过）
  const app2 = makeApp();
  registerTtsRoutes(app2, { sdk: { network: { fetch: fakeFetch() } }, dataDir: tmp });
  await request(app2, "PUT", "/tts/config", { body: { provider: "azure", azure: { region: "eastasia", key: "k" } } });
  const made = await request(app2, "POST", "/tts/speak", { body: { text: "短" } });
  const good = await request(app2, "GET", `/tts/audio/${made.data.name}`);
  assert.strictEqual(good.status, 200, "真文件读不到，说明这条路由根本没通：" + (good.error || good.status));
});

await okAsync("⑮ 超长文本 → 截断并说明，不假装读完了", async () => {
  const app = makeApp();
  const sdk = { network: { fetch: fakeFetch() } };
  registerTtsRoutes(app, { sdk, dataDir: tmp });
  await request(app, "PUT", "/tts/config", { body: { provider: "azure", azure: { region: "eastasia", key: "k" } } });

  const r = await request(app, "POST", "/tts/speak", { body: { text: "字".repeat(2500) } });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.chars, 2000);
  assert.strictEqual(r.data.truncated, 500);
  assert.match(r.data.note || "", /只读了前 2000 字/);
});

await okAsync("⑯ /tts/providers 给设置面板足够画选项的东西", async () => {
  const app = makeApp();
  registerTtsRoutes(app, { sdk: null, dataDir: tmp });
  const r = await request(app, "GET", "/tts/providers");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.default, "azure");
  assert.strictEqual(r.data.textMax, 2000);
  const az = r.data.providers.find((p) => p.id === "azure");
  assert.strictEqual(az.needsRegion, true);
  assert.ok(az.voices.length > 3, "该给几个可选声音");
});

await okAsync("⑰ 声音优先序：调用方指定 > 配置里的全局 > 供应商默认", () => {
  const az = { ...AZ, voice: "zh-CN-YunxiNeural" };
  assert.strictEqual(buildRequest(az, "x").voice, "zh-CN-YunxiNeural", "没指定时用全局");
  assert.strictEqual(buildRequest(az, "x", { voice: "zh-CN-XiaoyiNeural" }).voice, "zh-CN-XiaoyiNeural",
    "指定了就该盖过全局——这是群聊一人一嗓的地基");
  assert.strictEqual(buildRequest(AZ, "x").voice, "zh-CN-XiaoxiaoNeural", "都没填就用默认");
  assert.ok(buildRequest(az, "x", { voice: "zh-CN-XiaoyiNeural" }).body.includes('name="zh-CN-XiaoyiNeural"'),
    "SSML 里的声音名没跟着换");
});

await okAsync("⑱ 按角色分配：逐键合并，空串去掉那个角色，别的角色不受影响", () => {
  let cfg = mergeConfig({ provider: "azure", azure: { region: "eastasia", key: "k" } }, {
    voices: { c1: "zh-CN-YunxiNeural", c2: "zh-CN-XiaoyiNeural" }
  });
  assert.deepStrictEqual(cfg.voices, { c1: "zh-CN-YunxiNeural", c2: "zh-CN-XiaoyiNeural" });

  cfg = mergeConfig(cfg, { voices: { c1: "zh-CN-YunjianNeural" } });
  assert.strictEqual(cfg.voices.c1, "zh-CN-YunjianNeural");
  assert.strictEqual(cfg.voices.c2, "zh-CN-XiaoyiNeural", "只改一个人不该动别人");

  cfg = mergeConfig(cfg, { voices: { c1: "" } });
  assert.ok(!("c1" in cfg.voices), "空串该把那个角色的声音去掉");
  assert.strictEqual(cfg.voices.c2, "zh-CN-XiaoyiNeural");

  // 只改全局声音，voices 不该被顺手清掉
  const after = mergeConfig(cfg, { voice: "zh-CN-YunyangNeural" });
  assert.strictEqual(after.voices.c2, "zh-CN-XiaoyiNeural");
});

await okAsync("⑲ synthesize 把声音传下去，并说清这个声音是哪来的", async () => {
  const f1 = fakeFetch();
  const r1 = await synthesize({ config: AZ, text: "你好", voice: "zh-CN-YunxiNeural", fetchImpl: f1 });
  assert.strictEqual(r1.voice, "zh-CN-YunxiNeural");
  assert.strictEqual(r1.voiceSource, "caller");
  assert.ok(f1.calls[0].init.body.includes("zh-CN-YunxiNeural"), "请求里没带上这个声音");

  const r2 = await synthesize({ config: { ...AZ, voice: "zh-CN-XiaoyiNeural" }, text: "你好", fetchImpl: fakeFetch() });
  assert.strictEqual(r2.voiceSource, "global");

  const r3 = await synthesize({ config: AZ, text: "你好", fetchImpl: fakeFetch() });
  assert.strictEqual(r3.voiceSource, "default");
});

await okAsync("⑳ /tts/speak 带 characterId → 用那个角色的声音；不带就用全局", async () => {
  const app = makeApp();
  const sdk = { network: { fetch: fakeFetch() } };
  registerTtsRoutes(app, { sdk, dataDir: path.join(tmp, "voices") });

  await request(app, "PUT", "/tts/config", {
    body: {
      provider: "azure",
      voice: "zh-CN-XiaoxiaoNeural",
      azure: { region: "eastasia", key: "k" },
      voices: { "char-a": "zh-CN-YunxiNeural" }
    }
  });

  const a = await request(app, "POST", "/tts/speak", { body: { text: "甲说", characterId: "char-a" } });
  assert.strictEqual(a.status, 200, `状态 ${a.status}：${a.error || ""}`);
  assert.strictEqual(a.data.voice, "zh-CN-YunxiNeural", "没按角色分配的声音读");
  assert.strictEqual(a.data.voiceSource, "caller");
  assert.strictEqual(a.data.characterId, "char-a");

  const b = await request(app, "POST", "/tts/speak", { body: { text: "乙说", characterId: "char-b" } });
  assert.strictEqual(b.data.voice, "zh-CN-XiaoxiaoNeural", "没分配的用全局");
  assert.strictEqual(b.data.voiceSource, "global");

  const c = await request(app, "POST", "/tts/speak", { body: { text: "旁白" } });
  assert.strictEqual(c.data.voiceSource, "global");
  assert.strictEqual(c.data.characterId, null);

  // 配置读回里要能看到分配表（而它是公开形状，本来就不含密钥）
  const cfgBack = await request(app, "GET", "/tts/config");
  assert.strictEqual(cfgBack.data.voices["char-a"], "zh-CN-YunxiNeural");
});

console.log(`\n${fail === 0 ? "✅" : "❌"} 语音合成：${pass} 过 / ${fail} 败\n`);
process.exit(fail === 0 ? 0 : 1);
