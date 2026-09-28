// test/regression-png-card-compat.mjs — 图片卡兼容性回归
//
// 盯住两条曾经一起坏、却长出同一句报错的路径：
//
//   1. SillyTavern 的图片卡把卡 JSON 又 base64 了一层（btoa）。以前 readPngText
//      只试 JSON.parse，失败就把整串 base64 当"值"返回——于是 chara 成了一个
//      字符串，被当作卡往下走，一路走到 repo.create 才报 "name is required"。
//      导入任何 ST 图片卡都会踩这一脚，而错误指向的却是字段。
//
//   2. 一张普通图片里根本没有 chara 块，以前返回 {} 被当空卡，报的还是
//      "name is required"——把"这张图里没有卡"说成了"你的卡缺字段"。
//
// 两条必须分别钉死：第一条要读出完整卡，第二条要说真正的原因。

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";

import { readPngText, writePngText } from "../lib/characters/png.js";
import { CharacterRepo } from "../lib/characters/repo.js";
import { CharacterTransfer } from "../lib/characters/transfer.js";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e.message}`);
    failed++;
  }
}

// ── 造 PNG（最小可解析件） ──────────────────────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const crcTable = (() => {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const body = Buffer.concat([t, data]);
  let crc = -1;
  for (const b of body) crc = (crc >>> 8) ^ crcTable[(crc ^ b) & 0xff];
  const c = Buffer.alloc(4);
  c.writeUInt32BE((crc ^ -1) >>> 0, 0);
  return Buffer.concat([len, t, data, c]);
}

function imageChunks() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return [
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0])))
  ];
}

/** 不带任何文本块的普通图片。 */
function plainPng() {
  return Buffer.concat([PNG_SIG, ...imageChunks(), pngChunk("IEND", Buffer.alloc(0))]);
}

/** 带 tEXt 块；rawValue 按字面写入，不替调用方做 JSON 序列化。 */
function pngWithText(keyword, rawValue) {
  const text = Buffer.concat([
    Buffer.from(keyword, "utf8"),
    Buffer.from([0]),
    Buffer.from(rawValue, "utf8")
  ]);
  return Buffer.concat([PNG_SIG, ...imageChunks(), pngChunk("tEXt", text), pngChunk("IEND", Buffer.alloc(0))]);
}

/** 带 zTXt 块（压缩过的 tEXt）。 */
function pngWithZtxt(keyword, rawValue) {
  const text = Buffer.concat([
    Buffer.from(keyword, "utf8"),
    Buffer.from([0, 0]), // null 分隔符 + compression method 0
    zlib.deflateSync(Buffer.from(rawValue, "utf8"))
  ]);
  return Buffer.concat([PNG_SIG, ...imageChunks(), pngChunk("zTXt", text), pngChunk("IEND", Buffer.alloc(0))]);
}

/** 带 iTXt 块（国际版 tEXt：多语言标签 + 可选压缩）。 */
function pngWithItxt(keyword, rawValue, { compressed = false } = {}) {
  const valueBytes = Buffer.from(rawValue, "utf8");
  const payload = compressed ? zlib.deflateSync(valueBytes) : valueBytes;
  const text = Buffer.concat([
    Buffer.from(keyword, "utf8"),
    Buffer.from([0]), // keyword 结束
    Buffer.from([compressed ? 1 : 0, 0]), // compression flag + method
    Buffer.from([0]), // language tag（空）
    Buffer.from([0]), // translated keyword（空）
    payload
  ]);
  return Buffer.concat([PNG_SIG, ...imageChunks(), pngChunk("iTXt", text), pngChunk("IEND", Buffer.alloc(0))]);
}

// ── 现场 ────────────────────────────────────────────────

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tavern-png-card-"));
const repo = new CharacterRepo(tmpDir);
await repo.init();
const transfer = new CharacterTransfer(repo);

const ST_CARD = {
  spec: "chara_card_v2",
  spec_version: "2",
  data: {
    name: "银月城的守夜人",
    description: "{{char}}是银月城的守夜人。",
    personality: "沉默寡言。",
    scenario: "城墙上。",
    first_mes: "「这么晚了，{{user}}。」",
    tags: ["奇幻"]
  }
};

console.log("\n图片卡兼容性");

await test("ST 图片卡（chara 是 base64 过的 JSON）能读出完整卡", async () => {
  const b64 = Buffer.from(JSON.stringify(ST_CARD), "utf8").toString("base64");
  const card = await transfer.parseCard(pngWithText("chara", b64), true);

  // 反证：这条路若退回"只试 JSON.parse"，读到的会是整串 base64，
  // 下面第一条断言立刻红。
  assert.notEqual(typeof card, "string", "chara 不能被原样当卡返回");
  assert.equal(card.spec, "chara_card_v2");
  assert.equal(card.data.name, "银月城的守夜人");
  assert.equal(card.data.first_mes, "「这么晚了，{{user}}。」");
});

await test("zTXt 里的 base64 卡同样读得出", async () => {
  const b64 = Buffer.from(JSON.stringify(ST_CARD), "utf8").toString("base64");
  const card = await transfer.parseCard(pngWithZtxt("chara", b64), true);
  assert.equal(card.data.name, "银月城的守夜人");
});

await test("iTXt 里的 base64 卡读得出（未压缩）", async () => {
  const b64 = Buffer.from(JSON.stringify(ST_CARD), "utf8").toString("base64");
  const card = await transfer.parseCard(pngWithItxt("chara", b64), true);
  assert.equal(card.data.name, "银月城的守夜人");
});

await test("iTXt 压缩体（compression flag = 1）也解得开", async () => {
  const b64 = Buffer.from(JSON.stringify(ST_CARD), "utf8").toString("base64");
  const card = await transfer.parseCard(pngWithItxt("chara", b64, { compressed: true }), true);
  assert.equal(card.data.name, "银月城的守夜人");
});

await test("普通图片：报「没有角色卡数据」，不再说 name is required", async () => {
  await assert.rejects(
    () => transfer.parseCard(plainPng(), true),
    (e) => /没有角色卡数据/.test(e.message) && !/name is required/.test(e.message)
  );
});

await test("空对象卡（chara 是 {}）也被拦在解析这一层", async () => {
  await assert.rejects(() => transfer.parseCard(pngWithText("chara", "{}"), true), /没有角色卡数据/);
});

await test("本 App 自己导出的裸 JSON 图片卡仍读得回（不回归）", async () => {
  const written = await writePngText(plainPng(), { name: "A", description: "d", first_mes: "f" });
  const back = await transfer.parseCard(written, true);
  assert.equal(back.name, "A");
  assert.equal(back.first_mes, "f");
});

await test("普通文本 chunk 不会被误当 base64 解码", async () => {
  const back = readPngText(pngWithText("Comment", "hello world"));
  assert.equal(back.Comment, "hello world");
});

console.log(`\n通过 ${passed} / 失败 ${failed}`);
process.exit(failed > 0 ? 1 : 0);
