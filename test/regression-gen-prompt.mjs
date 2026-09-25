// test/regression-gen-prompt.mjs — 提示词构造 + 严格 JSON 解析
//
// 两个模型调用之间那堵墙就在这里：
//   调用一 看到**原文**，输出事实清单（每条挂出处）
//   调用二 只看到**清单**，看不到原文
// 这是防幻觉的结构，不是省 token 的手段。所以要有判据钉住它：
// 原文里独有的句子**不许**出现在调用二的提示词里（判据⑧）。
//
// 判据：
//   ① 干净的 JSON 对象 → 解出来
//   ② ```json 围栏 → 解出来
//   ③ 前后带废话（模型爱写"好的，这是结果："）→ 解出来
//   ④ 真坏 → 报错且话里有位置信息，不重试
//   ⑤ expect 形状不符 → 明确说"该是数组，实际是对象"
//   ⑥ 空输入 → 报"是空的"，不是 JSON.parse 的内部话
//   ⑦ 抽取提示词：带需求、带每条材料的出处、写明"挂不上出处就丢弃"
//   ⑧ 组装提示词：**只**带清单，原文里独有的句子不许出现

import assert from "node:assert";

const { parseJsonStrict, extractPrompt, composePrompt, EXTRACT_RULES } =
  await import("../lib/gen/prompt.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 生成器 · 提示词与解析 ===\n");

// ── parseJsonStrict ────────────────────────────────────

await okAsync("① 干净的 JSON 对象", () => {
  assert.deepStrictEqual(parseJsonStrict('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(parseJsonStrict('[{"f":"x"}]', { expect: "array" }), [{ f: "x" }]);
});

await okAsync("② ```json 围栏", () => {
  const t = '```json\n{"name":"薇拉","tags":["守夜"]}\n```';
  assert.deepStrictEqual(parseJsonStrict(t), { name: "薇拉", tags: ["守夜"] });
});

await okAsync("③ 前后带废话也能解出来", () => {
  const t = '好的，这是你要的结果：\n{"a":[1,2]}\n以上。';
  assert.deepStrictEqual(parseJsonStrict(t), { a: [1, 2] });
});

await okAsync("④ 真坏就报错，且话里能定位", () => {
  assert.throws(() => parseJsonStrict('{"a": 1,,}'), (e) => {
    assert.ok(/不是合法 JSON/.test(e.message), "错误话不对：" + e.message);
    assert.ok(e.message.length > 20, "错误话太短，定位不了：" + e.message);
    return true;
  });
});

await okAsync("⑤ expect 形状不符要说清", () => {
  assert.throws(() => parseJsonStrict('{"a":1}', { expect: "array" }), /该是数组.*对象/);
  assert.throws(() => parseJsonStrict('[1]', { expect: "object" }), /该是对象.*数组/);
});

await okAsync("⑥ 空输入报“是空的”", () => {
  assert.throws(() => parseJsonStrict(""), /是空的/);
  assert.throws(() => parseJsonStrict("   "), /是空的/);
  assert.throws(() => parseJsonStrict(null), /是空的/);
});

// ── 提示词 ─────────────────────────────────────────────

const DOCS = [
  {
    url: "https://zh.moegirl.org.cn/%E5%88%9D%E9%9F%B3%E6%9C%AA%E6%9D%A5",
    title: "初音未来",
    text: "初音未来是 Crypton Future Media 开发的歌声合成软件。她的生日是 8 月 31 日。"
  },
  {
    url: "https://arxiv.org/abs/2006.13896v2",
    title: "Photoisomerization-coupled electron transfer",
    text: "Photochromic molecular structures constitute a unique platform."
  }
];

await okAsync("⑦ 抽取提示词：带需求、带每条的出处、写明丢弃规则", async () => {
  const { systemPrompt, messages } = extractPrompt({ query: "我要一个未来歌姬", docs: DOCS });
  const flat = [systemPrompt, ...messages.map(m => m.content)].join("\n");
  assert.ok(flat.includes("我要一个未来歌姬"), "需求没进去");
  assert.ok(flat.includes(DOCS[0].url), "第一条的出处没进去");
  assert.ok(flat.includes(DOCS[1].url), "第二条的出处没进去");
  assert.ok(flat.includes("Crypton Future Media"), "正文没进去");
  assert.ok(/出处|来源/.test(EXTRACT_RULES) && /丢弃|丢掉/.test(EXTRACT_RULES),
    "规则里没写清“挂不上出处就丢弃”");
  assert.ok(/只/.test(EXTRACT_RULES) && /不(许)?(新增|添加|编)/.test(EXTRACT_RULES),
    "规则里没写清“只许抽取、不许新增”");
});

await okAsync("⑧ 组装提示词只带清单——原文里独有的句子不许出现", async () => {
  const facts = [
    { fact: "初音未来是 Crypton Future Media 开发的歌声合成软件。",
      source: { url: DOCS[0].url, title: "初音未来", tier: "community" } }
  ];
  const { systemPrompt, messages } = composePrompt({ query: "我要一个未来歌姬", facts });
  const flat = [systemPrompt, ...messages.map(m => m.content)].join("\n");
  assert.ok(flat.includes("Crypton Future Media"), "清单内容该在");
  assert.ok(!flat.includes("她的生日是 8 月 31 日"), "原文里独有的句子漏进组装提示词了");
  assert.ok(!flat.includes(DOCS[1].text), "另一篇原文漏进来了");
  assert.ok(flat.includes("character_book"), "字段白名单（含 character_book）没写进去");
});

console.log(`\n${fail === 0 ? "✅" : "❌"} 提示词与解析：${pass} 过 / ${fail} 败\n`);
process.exit(fail === 0 ? 0 : 1);
