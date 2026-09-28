// test/regression-status-block.mjs —— 状态栏该折起来，不该裸在正文里
//
// 病（2026-09-27 截图）：模型按世界书那套变量格式输出一整块键值清单，
// 它落在正文开头，App 原样渲染——整块状态数据压在叙述上，
// 最后一行 `**任务面板:** {}` 看上去像渲染坏了。
//
// 治法是切分，不是删除（展开还在）。这个文件钉的是切分的**边界**：
// 该切的一定切，不该切的一律不许动。

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitStatusBlock } from "../ui/assets/modules/status-block.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log("  ✅ " + name); pass++; }
  catch (e) { console.log("  ❌ " + name + "\n      " + (e?.message || e)); fail++; }
}

// 真实样本：这张卡（装甲核心）第 6 条消息的状态栏，末尾就是那行「任务面板」
const REAL = [
  '**物理位置:** 祖星·梨花大学·虓阚楼·模拟战机房',
  '**时间:** 新历2年-03:15:00',
  '**当前章节:** 序章',
  '',
  '**主角:**',
  '  主角状态栏:',
  '    HP值: 100',
  '    SP值: 100',
  '  驾驶属性:',
  '    APM: 0',
  '    驾驶分档: 民兵',
  '    KRL等级: 1',
  '    神经同步率: 0',
  '  珂若尔护盾:',
  '    现: 10',
  '    满: 10',
  '  背包: {}',
  '  技能: {}',
  '',
  '**红颜通讯:**',
  '  艾尔:',
  '    好感度: 50',
  '    关系阶段: 信任',
  '',
  '**机库:**',
  '  当前驾驶机甲: \'\'',
  '',
  '**任务面板:** {}',
  '',
  '***',
  '',
  '虓阚楼的模拟战机房里，空气中弥漫着冷却液和臭氧的气味。'
].join('\n');

console.log("\n=== 状态栏切分 ===\n");

check("真实样本：整块状态栏被切出来，正文从叙述开始", () => {
  const r = splitStatusBlock(REAL);
  assert.ok(r.status.length > 0, "没切出来");
  assert.ok(r.items >= 10, "项数偏少：" + r.items);
  assert.ok(r.status.includes("任务面板"), "那行「任务面板」该留在状态块里");
  assert.ok(!r.body.includes("任务面板"), "正文里不该还有它");
  assert.ok(!r.body.includes("HP值"), "正文里不该还有状态字段");
  assert.ok(r.body.startsWith("虓阚楼的模拟战机房"), "正文起点不对：" + JSON.stringify(r.body.slice(0, 20)));
  assert.ok(!r.body.startsWith("\n"), "正文不该以换行开头");
});

check("没有分隔线 → 一个字不动", () => {
  const plain = "谢尔顿从口袋里掏出那枚硬币。\n\n他说：这枚硬币有两面。";
  const r = splitStatusBlock(plain);
  assert.strictEqual(r.status, "");
  assert.strictEqual(r.body, plain);
});

check("有分隔线，但前面是叙述 → 不切", () => {
  const text = [
    '夜深了。',
    '',
    '风雪压着城门，街上一个人也没有。',
    '',
    '店老板说：今晚别出门了。',
    '',
    '***',
    '',
    '第二天早上，雪停了。'
  ].join('\n');
  const r = splitStatusBlock(text);
  assert.strictEqual(r.status, "", "叙述被误切了");
  assert.strictEqual(r.body, text);
});

check("分隔线前不足 3 行 → 不切", () => {
  const text = "HP值: 100\nSP值: 100\n\n***\n\n正文。";
  assert.strictEqual(splitStatusBlock(text).status, "");
});

check("--- 与 ___ 同样认作分隔线", () => {
  const body = '谢尔顿站在门口。';
  for (const sep of ['---', '___', '*****']) {
    const text = REAL.split('\n***\n')[0] + '\n\n' + sep + '\n\n' + body;
    const r = splitStatusBlock(text);
    assert.ok(r.status.length > 0, sep + " 没被认作分隔线");
    assert.ok(r.body.startsWith(body), sep + " 的正文起点不对");
  }
});

check("键值恰好一半是边界，少数派不算（宁可漏切）", () => {
  const text = [
    'HP值: 100',
    'SP值: 100',
    '这一句是叙述，长度足够但不是键值。',
    '这一句也是叙述，故意凑数。',
    '',
    '***',
    '',
    '正文。'
  ].join('\n');
  // 4 行非空、2 行键值 → 未过一半 → 不切
  const r = splitStatusBlock(text);
  assert.strictEqual(r.status, "", "边界判反了：2/4 不该切");
});

check("空 / null / 非字符串 不炸", () => {
  for (const v of ['', null, undefined, 123]) {
    const r = splitStatusBlock(v);
    assert.strictEqual(typeof r.body, "string");
    assert.strictEqual(r.status, "");
  }
});

check("切过之后原文没丢：除分隔线外的字符一个不少", () => {
  const r = splitStatusBlock(REAL);
  const strip = (s) => s.replace(/\s+/g, "");
  const kept = strip(r.status + r.body);
  assert.strictEqual(kept, strip(REAL).replace("***", ""), "切分丢字了");
});

// ── 接线：两处渲染都得走同一个入口 ────────────────────
const chat = read("ui/assets/modules/chat.js").replace(/\r\n/g, "\n");

check("chat.js 从独立模块引入，不再内联一份", () => {
  // 不把整句 import 写成字面量：仓库里的断链扫描器会把字符串里的
  // `from "./xxx.js"` 当成真 import，然后在 test/ 里找一个不存在的文件。
  assert.ok(chat.includes("import { splitStatusBlock }"), "没 import splitStatusBlock");
  assert.ok(chat.includes('"./status-block.js"'), "没指向独立模块");
  assert.ok(!/export function splitStatusBlock/.test(chat), "chat.js 里还留着旧的实现");
});

check("静态渲染与流式渲染都走 renderAssistantBody", () => {
  assert.ok(chat.includes("? renderAssistantBody(expand(m.content))"), "静态渲染没接上");
  assert.ok(chat.includes('innerHTML = renderAssistantBody(fullContent)'), "流式渲染没接上");
  assert.ok(!/innerHTML = escapeHtml\(fullContent\)/.test(chat), "流式还留着裸渲染那条");
});

console.log("\n通过 " + pass + " / 失败 " + fail + "\n");
if (fail > 0) process.exit(1);
