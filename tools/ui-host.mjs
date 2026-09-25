// tools/ui-host.mjs — 把 App 的界面在**真浏览器**里跑起来的本地宿主
//
// 为什么需要：
//   宿主的 App surface 被锁在鉴权后面——静态资源要 `_surface/<session>/`
//   路径段 + `X-Hana-App-Surface-Session` 头，而那串 session 是宿主开
//   窗口时在内存里现发的，没有 HTTP 入口能换。于是「点一遍界面」这件事
//   一直做不了，我只能把清单交给人去点——那是转嫁，不是验收。
//
// 这个宿主把那条路补上：
//   · 用**真的** lib/* 路由（注册方式与 regression-routes-smoke 一致）
//   · 按宿主真实的 URL 形状收请求（见 app.asar 里那段脱敏正则）：
//       /api/apps/<id>/ui/_surface/<session>/<file>
//       /api/apps/<id>/routes/_runtime/<rt>/_surface/<session>/<path>
//     session 是路径段，所以页面的相对子资源（css / js / import 图）
//     **自动继承**，前端一行都不用改。
//   · 数据目录是**真实数据的临时副本**：能看见自己的角色与对话，
//     而点击（删、改、保存）碰不到原数据。
//   · 每个请求都打一行日志——「这一次点击到底打了哪个端点」是查
//     界面逻辑问题时最要紧的那条线索。
//
// 用法：node tools/ui-host.mjs
//      然后开 http://127.0.0.1:<port>/api/apps/eleckoi-tavern/ui/_surface/demo/characters.html?appSurfaceSession=demo
//   环境变量：ELECKOI_UI_PORT（默认 8791）、ELECKOI_DATA（真实数据目录）

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const abs = (r) => path.join(ROOT, ...r.split("/"));
const APP_ID = "eleckoi-tavern";
const PORT = Number(process.env.ELECKOI_UI_PORT || 8791);

const { makeApp, makeCtx } = await import("../test/lib/route-harness.mjs");
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
const { registerBoardRoutes } = await import("../lib/board/routes.js");
const { registerRegexRoutes } = await import("../lib/regex/routes.js");
const { registerMigrationRoutes } = await import("../lib/migration/routes.js");
const { registerGenRoutes } = await import("../lib/gen/routes.js");
const { loadGroupState } = await import("../lib/tools/group.js");

// ── 数据：真实数据的临时副本 ──────────────────────────
const SRC = process.env.ELECKOI_DATA || "W:/Games/Hanako/.hanako/app-data/eleckoi-tavern";
const DATA = path.join(os.tmpdir(), "eleckoi-ui-host-data");
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
let seeded = 0;
if (fs.existsSync(SRC)) {
  // **必须递归**：角色卡与对话都在子目录里，只拷顶层文件的话
  // GET /characters 会回一个空数组——看上去像 App 坏了，实际是我拷漏了。
  fs.cpSync(SRC, DATA, { recursive: true });
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory() ? walk(path.join(d, e.name)) : 1), 0);
  seeded = walk(DATA);
}

const charRepo = new CharacterRepo(DATA); await charRepo.init();
const transfer = new CharacterTransfer(charRepo);
const convRepo = new ConversationRepo(DATA); await convRepo.init();
const setRepo = new SettingRepo(DATA); await setRepo.init();
const varRepo = new VariableRepo(DATA); await varRepo.init();
const presetRepo = new PresetRepo(DATA); await presetRepo.init();
const boardRepo = new BoardRepo(DATA); await boardRepo.init();
const regexRepo = new RegexRepo(DATA); await regexRepo.init();
await loadGroupState(DATA);

// 假 llm：界面流程要能跑到底，但不需要真花 token。
// 生成路由少一个方法就是 TypeError，那样「点了没反应」会被误当成界面 bug。
/** 桩自己数轮次：正文尾巴上那笔 {{setvar}} 的值要递增，界面上才看得出变化。 */
let stubRound = 0;

const fakeLlm = {
  available: true,
  lastTarget: { model: "ui-host-stub" },
  resolveContextWindow: async () => 32000,
  // 按系统提示分流：要候选项就给一份清单，否则给一句正文。
  //（桩要能跑完两条路，不然「点了没反应」会被误当成界面 bug）
  //
  // 正文尾巴上带一笔 {{setvar}}：界面上才能看见「本轮变量变化」那行 chips。
  // 值递增：写同一个值确实不该出 chip（账从状态来），也就看不到变化了。
  generate: async (messages, options) => {
    const sys = String(options?.systemPrompt || "");
    if (/候选项/.test(sys)) {
      return {
        content: [
          "- 推开哨塔的门往里走",
          "- 站在门口听一会儿风",
          "- 问她左眼那道疤的来历",
          "- 掉头下山，不等天亮"
        ].join("\n"),
        usage: { prompt_tokens: 90, completion_tokens: 40 },
        target: { model: "ui-host-stub" }
      };
    }
    stubRound += 1;
    return {
      content: `「我在。」她没回头。{{setvar::好感::${5 + stubRound}}}`,
      usage: { prompt_tokens: 120, completion_tokens: 18 },
      target: { model: "ui-host-stub" }
    };
  },
  // 流式 = 把 generate 的结果切块吐出去。
  //
  // 别在这里另写一份回复文本。桩里「回复」有两份实现就一定会漂——
  // 今天已经漂过一次：流式那份还留着旧回复，于是「界面上没有变量 chips」
  // 看起来像界面 bug，实际上是桩自己没把 setvar 吐出来。
  async *streamEvents(messages, options) {
    const r = await fakeLlm.generate(messages, options);
    for (const ch of String(r.content)) {
      yield { type: "text-delta", delta: ch };
    }
    yield { type: "done", usage: r.usage, stopReason: "end_turn" };
  }
};

const apps = {
  characters: makeApp(), conversations: makeApp(), settings: makeApp(),
  variables: makeApp(), presets: makeApp(), board: makeApp(),
  regex: makeApp(), tools: makeApp(), migration: makeApp(), gen: makeApp()
};
registerCharacterRoutes(apps.characters, charRepo, transfer, setRepo);
registerConversationRoutes(apps.conversations, convRepo, fakeLlm, charRepo, setRepo, regexRepo, presetRepo, boardRepo);
registerSettingRoutes(apps.settings, setRepo, convRepo);
registerVariableRoutes(apps.variables, varRepo, convRepo, charRepo);
registerPresetRoutes(apps.presets, presetRepo);
registerToolRoutes(apps.tools, {});
registerBoardRoutes(apps.board, boardRepo);
registerRegexRoutes(apps.regex, regexRepo);
registerMigrationRoutes(apps.migration, DATA);

/*
 * 生成器。
 *
 * net 在这里给的是一个 **dev 专用的直连 shim**：真宿主里出网只能走
 * sdk.network.fetch（原始 fetch 被 AppHost 的权限模型拒），而这里是我们
 * 自己的进程，直连就是通的。给 shim 的意义是——来源体检、真检索都能在
 * 开发宿主里跑起来，而不用每次回到宿主去看一眼。
 * llm 给 null：开发宿主没有模型凭据，提交任务会得到一句诚实的
 *「模型服务未就绪」，正好把那条错误路径也露出来。
 */
registerGenRoutes(apps.gen, {
  llm: null,
  net: { fetch: (url, init) => fetch(url, init) }
});

// ── 静态文件 ──────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp"
};

function serveStatic(rel) {
  const clean = path.posix.normalize("/" + rel).replace(/^\/+/, "");
  if (clean.includes("..")) return { status: 403, body: "path traversal" };
  const file = abs("ui/" + clean);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { status: 404, body: "not found: " + clean };
  return { status: 200, body: fs.readFileSync(file), type: MIME[path.extname(file).toLowerCase()] || "application/octet-stream" };
}

// ── 路由分发 ──────────────────────────────────────────
//
// 故意**不用** route-harness 的 request()：它为了不让后台 handler 与
// 测试后续动作抢同一个对话，会把 SSE 那条流读干。测试里那是对的，
// 但这里是真转发，流被它读掉之后我再遍历 body 就得到
// `ReadableStream is locked`——服务直接崩。
// 所以自己拿 match + makeCtx，raw(Response) 原样交给下面去 pipe。
async function dispatch(method, routePath, query, body) {
  for (const [name, app] of Object.entries(apps)) {
    const hit = app.match(method, routePath);
    if (!hit) continue;
    const { ctx, out } = makeCtx({ query, params: hit.params, body });
    const returned = await hit.route.handler(ctx);
    if (returned instanceof Response) return { raw: returned, module: name };
    return { status: out.status, payload: out.payload, module: name };
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (raw.length === 0) return resolve(undefined);
      const ct = String(req.headers["content-type"] || "");
      // 不信 content-type，直接试 JSON：
      // SDK 的 hana.api.fetch 未必把 content-type 带上来，而只认
      // application/json 的话，路由会收到一个**字符串**，
      // 解不出字段——看上去像「前端没填」，实际是我这边没解析。
      const txt = raw.toString("utf8");
      try { return resolve(JSON.parse(txt)); } catch { /* 不是 JSON，当文本 */ }
      return resolve(txt);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const query = Object.fromEntries(url.searchParams.entries());
  const method = req.method.toUpperCase();
  const p = decodeURIComponent(url.pathname);

  const tag = (status, what) => console.log(`  ${String(status).padStart(3)}  ${method.padEnd(6)} ${url.pathname}${url.search ? "?" + url.searchParams.toString() : ""}  ${what || ""}`);

  // 0) 脚本化探针
  if (p === "/_probe.html") {
    tag(200, "probe 页");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(PROBE_HTML);
  }
  if (p.startsWith("/_flow/")) {
    const out = serveFlow(decodeURIComponent(p.slice("/_flow/".length)));
    tag(out.status, `flow ${p.slice(7)}`);
    res.writeHead(out.status, { "content-type": out.type || "text/plain; charset=utf-8", "cache-control": "no-store" });
    return res.end(out.body);
  }
  if (p === "/__probe") {
    const body = await readBody(req);
    console.log("\n  ── 探针结果 ──");
    console.log(JSON.stringify(body, null, 1).split("\n").map(l => "  " + l).join("\n"));
    console.log("  ── 探针结果结束 ──\n");
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // 1) 静态界面：/api/apps/<id>/ui/[ _surface/<s>/ ]<file>
  const uiPrefix = `/api/apps/${APP_ID}/ui/`;
  if (p.startsWith(uiPrefix)) {
    let rel = p.slice(uiPrefix.length);
    rel = rel.replace(/^_surface\/[^/]+\//, "");
    const out = serveStatic(rel);
    tag(out.status, out.status === 200 ? `static ${rel}` : out.body);
    res.writeHead(out.status, { "content-type": out.type || "text/plain; charset=utf-8", "cache-control": "no-store" });
    return res.end(out.body);
  }

  // 2) 路由：/api/apps/<id>/routes/[ _runtime/<rt>/ ]_surface/<s>/<path>
  const rtPrefix = `/api/apps/${APP_ID}/routes/`;
  let routePath = null;
  if (p.startsWith(rtPrefix)) {
    let rest = p.slice(rtPrefix.length);
    rest = rest.replace(/^_runtime\/[^/]+\//, "");
    rest = rest.replace(/^_surface\/[^/]+\//, "");
    routePath = "/" + rest;
  }
  // 2b) 方便起见：/__api/<path> 直接打路由（排查用）
  if (routePath === null && p.startsWith("/__api/")) routePath = "/" + p.slice("/__api/".length);

  if (routePath !== null) {
    const body = await readBody(req);
    let r = null;
    try {
      r = await dispatch(method, routePath, query, body);
    } catch (e) {
      tag(500, "handler 抛了：" + e.message);
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, error: "handler threw: " + e.message, stack: String(e.stack).split("\n").slice(0, 4) }));
    }
    if (!r) {
      tag(404, "没有路由匹配（前端可能在打一个不存在的地方）");
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, error: `no route: ${method} ${routePath}` }));
    }

    if (r.raw) {
      const resp = r.raw;
      tag(resp.status, `raw ${r.module}${routePath}（流式，原样转发）`);
      const headers = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });
      res.writeHead(resp.status, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", ...headers });
      if (resp.body) {
        try {
          for await (const chunk of resp.body) res.write(Buffer.from(chunk));
        } catch (e) {
          console.error("  流转发中断：" + e.message);
        }
      }
      return res.end();
    }

    const okFlag = r.payload && typeof r.payload === "object" && r.payload.ok === true;
    tag(r.status, `${r.module}${routePath}${okFlag ? "" : "  ok!=true " + (r.payload?.error || "")}`);
    res.writeHead(r.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    return res.end(JSON.stringify(r.payload));
  }

  tag(404, "不是 App 的路径");
  res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error: "not an app path: " + p }));
});

// ── 脚本化探针 ───────────────────────────────────────
//
// 为什么需要：browser 工具的 evaluate 这条通道会不定时掉
//（`No browser instance for session`），而 navigate 一直稳定。
// 那就把要跑的东西放进页面自己的脚本里：
//   /_probe.html?flow=<name>  → iframe 加载 App，跑 tools/flows/<name>.js，
//   把结果 POST 回 /__probe。我从日志里读。
//
// 比内联 evaluate 多两个好处：流程是**磁盘上的文件**（能改、能重跑、
// 能进 git），而且 iframe 同源，直接就能拿到 App 的真模块实例。
const PROBE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>probe</title>
<style>html,body{margin:0;height:100%}iframe{width:100%;height:100vh;border:0}</style></head>
<body><iframe id="app"></iframe>
<script>
const flow = new URLSearchParams(location.search).get('flow') || 'send';
const frame = document.getElementById('app');
const send = (payload) => fetch('/__probe', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
});
frame.addEventListener('load', async () => {
  try {
    const code = await (await fetch('/_flow/' + flow + '.js')).text();
    const result = await frame.contentWindow.eval('(async () => {\\n' + code + '\\n})()');
    await send({ flow, ok: true, result });
  } catch (e) {
    await send({ flow, ok: false, error: String((e && e.stack) || e) });
  }
});
frame.src = '/api/apps/${APP_ID}/ui/_surface/demo/characters.html?appSurfaceSession=demo';
</script></body></html>`;

function serveFlow(name) {
  const clean = String(name).replace(/[^\w.-]/g, "").replace(/\.js$/, "");
  const file = abs(`tools/flows/${clean}.js`);
  if (!fs.existsSync(file)) return { status: 404, body: `no flow: ${clean}` };
  return { status: 200, body: fs.readFileSync(file), type: "text/javascript; charset=utf-8" };
}

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}/api/apps/${APP_ID}/ui/_surface/demo/characters.html?appSurfaceSession=demo`;
  console.log(`\n界面宿主已起：${url}`);
  console.log(`  数据目录（临时副本）  ${DATA}  （从 ${SRC} 拷了 ${seeded} 个文件）`);
  console.log(`  路由              /api/apps/${APP_ID}/routes/_runtime/<rt>/_surface/<s>/<path>`);
  console.log(`  快捷直连          /__api/<path>\n`);
});
