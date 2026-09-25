// test/regression-gen-sources.mjs — 来源适配器（萌娘 / arXiv）
//
// 两条硬纪律在这里被钉住：
//   ① 出网**只走 net.fetch**（宿主那道门）。没有 net 就明确报「出网未就绪」，
//      绝不回退到 globalThis.fetch —— 那样在生产里会被 Node 权限模型拒，
//      报出来的却是一个看着像 DNS 坏了的错。
//   ② 一个源坏了不能拖垮另一个：错误要带来源名，交给上层决定怎么报。
//
// 判据：
//   萌娘
//     ① search 打的 URL 与 UA 对
//     ② fetchPage 抠出正文、去掉站点提示模板
//     ③ gather 只抓前 N 条，且单条抓取失败时其余照旧返回
//   出网门
//     ④ 没有 net → 抛「出网未就绪」（不是去用 globalThis.fetch）
//     ⑤ net.fetch 抛错 → 错误里带来源名
//   arXiv
//     ⑥ search 打的 URL 对，返回 atom 解析后的条目

import assert from "node:assert";

const moegirl = await import("../lib/gen/sources/moegirl.js");
const arxiv = await import("../lib/gen/sources/arxiv.js");
const { checkAvailability } = await import("../lib/gen/sources/index.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 生成器 · 来源适配器 ===\n");

/** 假 response，够适配器用。 */
const resp = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => body,
  json: async () => JSON.parse(body)
});

/** 记录调用并按 URL 派发假响应的 net。 */
function makeNet(routes) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      for (const [needle, make] of routes) {
        if (url.includes(needle)) return typeof make === "function" ? make(url) : make;
      }
      return resp("<html>nothing</html>", 404);
    }
  };
}

const SEARCH_HTML = `<ul class="mw-search-results">
  <li><a href="/index.php?title=Special:%E6%90%9C%E7%B4%A2" title="搜索文件">搜索文件</a></li>
  <li><a href="/%E5%88%9D%E9%9F%B3%E6%9C%AA%E6%9D%A5" title="初音未来">初音未来</a></li>
  <li><a href="/%E5%8E%9F%E7%A5%9E" title="原神">原神</a></li>
</ul>`;

const ARTICLE_HTML = `<html><head><title>初音未来 - 萌娘百科</title><script>var x=1;</script></head><body>
<div id="mw-content-text">
  <div class="notice">提示：本条目的主题不是初音岛。</div>
  <div class="notice">萌娘百科欢迎您参与完善本条目☆Kira~</div>
  <div class="notice">欢迎正在阅读这个条目的您协助编辑本条目。编辑前请阅读Wiki入门或条目编辑规范，并查找相关资料。萌娘百科祝您在本站度过愉快的时光。</div>
  <p>初音未来（初音ミク）是 Crypton Future Media 开发的歌声合成软件。</p>
  <p>2007 年 8 月 31 日发售。</p>
</div></body></html>`;

// ── 萌娘 ────────────────────────────────────────────────

await okAsync("① 萌娘 search：URL 形状与 UA 都对", async () => {
  const net = makeNet([["index.php?search=", resp(SEARCH_HTML)]]);
  const links = await moegirl.search("初音未来", { net });
  assert.strictEqual(net.calls.length, 1, "该只打一次");
  const url = net.calls[0].url;
  assert.ok(url.startsWith("https://zh.moegirl.org.cn/index.php?search="), url);
  assert.ok(/%E5%88%9D%E9%9F%B3%E6%9C%AA%E6%9D%A5/.test(url), "关键词没 URL 编码：" + url);
  assert.ok(url.includes("fulltext=1"), "该带 fulltext=1（全文搜索）：" + url);
  const ua = net.calls[0].init?.headers?.["user-agent"] || net.calls[0].init?.headers?.["User-Agent"];
  assert.ok(ua && ua.length > 10, "必须带 UA，否则站点可能拒：" + ua);
  assert.deepStrictEqual(links.map(l => l.title), ["初音未来", "原神"]);
});

await okAsync("② 萌娘 fetchPage：抠出正文，清掉站点提示模板", async () => {
  const net = makeNet([["%E5%88%9D%E9%9F%B3%E6%9C%AA%E6%9D%A5", resp(ARTICLE_HTML)]]);
  const page = await moegirl.fetchPage("https://zh.moegirl.org.cn/%E5%88%9D%E9%9F%B3%E6%9C%AA%E6%9D%A5", { net });
  assert.ok(page.text.includes("Crypton Future Media"), "正文没抠到：" + page.text.slice(0, 80));
  assert.ok(!page.text.includes("萌娘百科欢迎您参与完善本条目"), "站点提示模板没清掉");
  assert.ok(!page.text.includes("本条目的主题不是"), "消歧提示没清掉");
  assert.ok(!page.text.includes("祝您在本站度过"), "客套话没清掉");
  assert.ok(page.text.length < 400, `清完该短下来，实为 ${page.text.length} 字`);
});

await okAsync("③ gather：只抓前 N 条；单条失败不拖垮其余", async () => {
  const net = makeNet([
    ["index.php?search=", resp(SEARCH_HTML)],
    ["%E5%88%9D%E9%9F%B3%E6%9C%AA%E6%9D%A5", resp(ARTICLE_HTML)],
    ["%E5%8E%9F%E7%A5%9E", () => { throw new Error("boom"); }]
  ]);
  const docs = await moegirl.gather("初音未来", { net, limit: 2 });
  assert.strictEqual(docs.length, 1, `该只剩成功那条，实为 ${docs.length}`);
  assert.ok(docs[0].text.includes("Crypton"), "成功那条的正文该在");
  assert.ok(Array.isArray(docs[0].sources) === false, "docs 形状别乱加字段");
});

// ── 出网门 ──────────────────────────────────────────────

await okAsync("④ 没有 net（或 net 没 fetch）→ 明确报「出网未就绪」", async () => {
  await assert.rejects(() => moegirl.search("x", {}), /出网未就绪/, "空 options 没报出网问题");
  await assert.rejects(() => arxiv.search("x", { net: {} }), /出网未就绪/, "net 没有 fetch 也没报");
});

await okAsync("⑤ net.fetch 抛错 → 错误里带来源名，便于上层说清是谁坏的", async () => {
  const net = { fetch: async () => { throw new Error("getaddrinfo ERR_ACCESS_DENIED"); } };
  await assert.rejects(() => moegirl.search("x", { net }), (e) => {
    assert.ok(/萌娘/.test(e.message), "没带来源名：" + e.message);
    assert.ok(/ERR_ACCESS_DENIED/.test(e.message), "原始错误被吞了：" + e.message);
    return true;
  });
});

// ── arXiv ──────────────────────────────────────────────

const ATOM = `<?xml version='1.0'?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Photoisomerization-coupled electron transfer</title>
    <summary>Photochromic molecular structures constitute a unique platform.</summary>
    <link href="https://arxiv.org/abs/2006.13896v2" rel="alternate" type="text/html"/>
  </entry>
</feed>`;

await okAsync("⑥ arXiv search：URL 形状对，返回解析后的条目", async () => {
  const net = makeNet([["export.arxiv.org", resp(ATOM)]]);
  const docs = await arxiv.search("electron transfer", { net });
  const url = net.calls[0].url;
  assert.ok(url.startsWith("https://export.arxiv.org/api/query?"), url);
  assert.ok(url.includes("search_query=all:"), "该用 all: 检索：" + url);
  assert.ok(url.includes("electron%20transfer") || url.includes("electron+transfer"),
    "关键词没进查询：" + url);
  assert.strictEqual(docs.length, 1);
  assert.strictEqual(docs[0].url, "https://arxiv.org/abs/2006.13896v2");
  assert.ok(docs[0].text.includes("Photochromic"), "摘要没抠到");
});

// ── 体检 ────────────────────────────────────────────────

await okAsync("⑦ checkAvailability：一个通一个不通，两个都要有结论", async () => {
  const net = makeNet([
    ["zh.moegirl.org.cn/", resp("<html>" + "甲".repeat(600) + "</html>")],
    ["export.arxiv.org", () => { throw new Error("ETIMEDOUT"); }]
  ]);
  const rows = await checkAvailability(net);
  assert.strictEqual(rows.length, 2, `该两个源都有结论，实为 ${rows.length}`);
  const moe = rows.find(r => r.id === "moegirl");
  const ax = rows.find(r => r.id === "arxiv");
  assert.strictEqual(moe.ok, true, "萌娘该是通的：" + JSON.stringify(moe));
  assert.strictEqual(ax.ok, false, "arXiv 该是不通的（桩里抛了错）");
  assert.ok(/ETIMEDOUT/.test(ax.note), "不通的原因该写进 note：" + ax.note);
  assert.ok(Number.isFinite(moe.ms), "耗时该是个数");
});

console.log(`\n${fail === 0 ? "✅" : "❌"} 来源适配器：${pass} 过 / ${fail} 败\n`);
process.exit(fail === 0 ? 0 : 1);
