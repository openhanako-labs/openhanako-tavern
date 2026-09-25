// test/regression-gen-text.mjs — HTML→文本 / 搜索结果解析 / atom 解析
//
// 这一层是纯函数，不联网——所以它必须被单测钉死：
// 联网的部分坏起来会说是网络问题，这一层坏起来会安静地把正文切成垃圾，
// 然后喂给模型，产出看着像那么回事的东西。那是最难查的一种坏。
//
// 判据：
//   htmlToText
//     ① 剥掉 <script>/<style> 的内容（不是标签，是内容）
//     ② 剥标签、解实体（&amp; &nbsp; &lt;）
//     ③ 压缩连续空白
//     ④ 超长截断到上限，且不截出半个实体
//     ⑤ 空输入不崩
//   parseSearchLinks
//     ⑥ 只留条目链，排掉 Special: / index.php? / Help: / 带命名空间前缀的
//     ⑦ 去重、保序、URL 解码
//     ⑧ 形状变了（没有链接）就返回空数组，不抛
//   parseAtom
//     ⑨ 抠出 title / link / summary
//     ⑩ 不是 atom 就返回空数组

import assert from "node:assert";

const { htmlToText, parseSearchLinks, parseAtom } = await import("../lib/gen/text.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 生成器 · 文本层（纯函数）===\n");

// ── htmlToText ──────────────────────────────────────────

const messy = `
<!DOCTYPE html><html><head>
<title>初音未来 - 萌娘百科</title>
<style>.a{color:red} body{margin:0}</style>
<script>var RLCONF={"wgBreakFrames":true};console.log("别把我当正文");</script>
</head><body>
<div class="mw-parser-output">
  <p>初音未来（初音ミク）是<b>Crypton Future Media</b>开发的语音合成软件。</p>
  <p>&nbsp;</p>
  <p>她在 2007 年 8 月 31 日发售 &amp; 迅速走红，&lt;世界第一的公主殿下&gt;。</p>
</div>
</body></html>`;

await okAsync("① 剥掉 script/style 的**内容**（不是只剥标签）", () => {
  const t = htmlToText(messy);
  assert.ok(!t.includes("别把我当正文"), "script 内容漏进正文了");
  assert.ok(!t.includes("color:red"), "style 内容漏进正文了");
  assert.ok(!t.includes("wgBreakFrames"), "RLCONF 漏进正文了");
});

await okAsync("② 剥标签、解实体", () => {
  const t = htmlToText(messy);
  // 注意：不能断言“结果里不许有尖括号”——`&lt;世界第一的公主殿下&gt;`
  // 解出来就是 `<…>`，那是正文本身。要钉的是“没剥干净的标签”。
  assert.ok(!/<\/?[a-zA-Z][^>]*>/.test(t), "还有没剥干净的标签：" + t.slice(0, 120));
  assert.ok(t.includes("Crypton Future Media"), "粗体里的文字该留着");
  assert.ok(t.includes("初音未来（初音ミク）"), "正文没抠出来");
  assert.ok(t.includes("&" ), "&amp; 该变成 &");
  assert.ok(t.includes("<世界第一的公主殿下>"), "&lt;/&gt; 该解成尖括号");
  assert.ok(!/&nbsp;|&amp;|&lt;|&gt;/.test(t), "还有没解开的实体");
});

await okAsync("③ 压缩连续空白（换行与多个空格）", () => {
  const t = htmlToText(messy);
  assert.ok(!/\n/.test(t), "不该留换行");
  assert.ok(!/ {2,}/.test(t), "不该留连续空格");
});

await okAsync("④ 超长截断到上限", () => {
  const long = "<p>" + "甲".repeat(500) + "</p>";
  const t = htmlToText(long, { max: 100 });
  assert.ok(t.length <= 100, `截断后还有 ${t.length} 字`);
  assert.ok(t.length > 50, "别截得太狠");
});

await okAsync("⑤ 空/非字符串输入不崩", () => {
  assert.strictEqual(htmlToText(""), "");
  assert.strictEqual(htmlToText(null), "");
  assert.strictEqual(htmlToText(undefined), "");
  assert.strictEqual(htmlToText(123), "");
});

// ── parseSearchLinks ────────────────────────────────────

const searchPage = `
<ul class="mw-search-results">
  <li><a href="/index.php?title=Special:%E6%90%9C%E7%B4%A2&amp;profile=images" title="搜索文件">搜索文件</a></li>
  <li><a href="/%E5%88%9D%E9%9F%B3%E6%9C%AA%E6%9D%A5" title="初音未来">初音未来</a></li>
  <li><a href="/Help:Wiki%E5%85%A5%E9%97%A8" title="Help:Wiki入门">Help:Wiki入门</a></li>
  <li><a href="/%E8%90%8C%E5%A8%98%E7%99%BE%E7%A7%91:%E7%BC%96%E8%BE%91%E8%A7%84%E8%8C%83" title="萌娘百科:编辑规范">萌娘百科:编辑规范</a></li>
  <li><a href="/%E5%88%9D%E9%9F%B3%E5%B2%9B" title="初音岛">初音岛</a></li>
  <li><a href="/%E5%88%9D%E9%9F%B3%E6%9C%AA%E6%9D%A5" title="初音未来">初音未来</a></li>
  <li><a href="https://other.example.com/x" title="站外">站外</a></li>
</ul>`;

await okAsync("⑥ 只留条目链，排掉 Special/index.php/Help/命名空间", () => {
  const links = parseSearchLinks(searchPage);
  const titles = links.map(l => l.title);
  assert.ok(titles.includes("初音未来"), "条目链丢了：" + JSON.stringify(titles));
  assert.ok(titles.includes("初音岛"), "第二条条目链丢了");
  assert.ok(!titles.includes("搜索文件"), "Special: 页没排掉");
  assert.ok(!titles.includes("Help:Wiki入门"), "Help: 没排掉");
  assert.ok(!titles.includes("萌娘百科:编辑规范"), "命名空间没排掉");
  assert.ok(!titles.some(t => t === "站外"), "站外链接没排掉");
});

await okAsync("⑦ 去重、保序、URL 解码", () => {
  const links = parseSearchLinks(searchPage);
  assert.strictEqual(links.length, 2, `实为 ${links.length} 条：${JSON.stringify(links.map(l => l.title))}`);
  assert.strictEqual(links[0].title, "初音未来", "顺序该按出现先后");
  assert.strictEqual(links[0].url, "https://zh.moegirl.org.cn/%E5%88%9D%E9%9F%B3%E6%9C%AA%E6%9D%A5",
    "相对链要补成绝对（URL 仍编码）");
});

await okAsync("⑧ 没有链接就返回空数组，不抛", () => {
  assert.deepStrictEqual(parseSearchLinks("<html>没有链接</html>"), []);
  assert.deepStrictEqual(parseSearchLinks(""), []);
  assert.deepStrictEqual(parseSearchLinks(null), []);
});

// ── parseAtom ───────────────────────────────────────────

const atom = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1234.5678v1</id>
    <title>Quantum  effects   in  electron   transfer</title>
    <summary>We study electron transfer &amp; coherence.</summary>
    <link href="http://arxiv.org/abs/1234.5678v1" rel="alternate" type="text/html"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/9999.0001v2</id>
    <title>Second  paper</title>
    <summary>Another abstract.</summary>
    <link href="http://arxiv.org/abs/9999.0001v2" rel="alternate" type="text/html"/>
  </entry>
</feed>`;

await okAsync("⑨ 抠出 title / link / summary，并压空白", () => {
  const items = parseAtom(atom);
  assert.strictEqual(items.length, 2, `实为 ${items.length}`);
  assert.strictEqual(items[0].title, "Quantum effects in electron transfer", "标题空白没压");
  assert.strictEqual(items[0].url, "http://arxiv.org/abs/1234.5678v1");
  assert.ok(items[0].text.includes("electron transfer & coherence"), "实体没解或正文没抠到");
});

await okAsync("⑩ 不是 atom 就返回空数组", () => {
  assert.deepStrictEqual(parseAtom("<html>nope</html>"), []);
  assert.deepStrictEqual(parseAtom(""), []);
  assert.deepStrictEqual(parseAtom(null), []);
});

console.log(`\n${fail === 0 ? "✅" : "❌"} 文本层：${pass} 过 / ${fail} 败\n`);
process.exit(fail === 0 ? 0 : 1);
