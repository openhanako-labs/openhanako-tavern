// test/regression-a.mjs — 切口 A 回归验证
//
// 用真实文件系统跑，不用 mock。每条断言对应一个已修 bug。
// 运行：node test/regression-a.mjs

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

import { ConversationRepo } from "../lib/conversations/repo.js";
import { CharacterRepo } from "../lib/characters/repo.js";
import { VariableRepo } from "../lib/variables/repo.js";
import { SettingRepo } from "../lib/settings/repo.js";
import { MigrationImporter } from "../lib/migration/import.js";
import { MigrationExporter } from "../lib/migration/export.js";
import { loadGroupState, toggleGroup, isGroupEnabled, isToolEnabled, listGroups } from "../lib/tools/group.js";
import { toStreamMessages, toUtilityMessages } from "../lib/llm/service.js";
import { CharacterTransfer } from "../lib/characters/transfer.js";
import { writePngText, readPngText } from "../lib/characters/png.js";
import zlib from "node:zlib";

// ── 测试辅助：造一个最小合法 PNG（1x1 透明） ──
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function isPngBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 8 && buf.slice(0, 8).equals(PNG_SIG);
}
function minimalPng() {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : (c >>> 1);
    table[n] = c;
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, "ascii");
    const body = Buffer.concat([t, data]);
    let crc = -1;
    for (const b of body) crc = (crc >>> 8) ^ table[(crc ^ b) & 0xff];
    const c = Buffer.alloc(4);
    c.writeUInt32BE((crc ^ -1) >>> 0, 0);
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    failed++;
  }
}

function section(t) {
  console.log(`\n${"─".repeat(60)}\n${t}\n${"─".repeat(60)}`);
}

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tavern-regress-"));

// ─────────────────────────────────────────────────────────────
section("BUG-1 · 迁移导入不再损坏对话");

await test("restore 保留 id / messages / variables", async () => {
  const dir = path.join(tmpRoot, "b1a");
  const repo = new ConversationRepo(dir);
  await repo.init();

  const original = {
    id: "conv-fixed-id-001",
    characterId: "char-abc",
    title: "测试对话",
    messages: [
      { id: "m1", role: "user", content: "你好", timestamp: "2026-01-01T00:00:00.000Z" },
      { id: "m2", role: "assistant", content: "你也好", timestamp: "2026-01-01T00:00:01.000Z" }
    ],
    variables: { hp: 10 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z"
  };

  const restored = await repo.restore(original);

  assert.equal(restored.id, "conv-fixed-id-001", "id 必须保留");
  assert.equal(restored.messages.length, 2, "消息不能丢");
  assert.equal(restored.messages[0].content, "你好");
  assert.equal(restored.characterId, "char-abc", "characterId 不能变成对象");
  assert.equal(restored.variables.hp, 10, "variables 必须保留");
  assert.equal(restored.title, "测试对话");
});

await test("导出→导入往返，消息数与内容一致", async () => {
  const srcDir = path.join(tmpRoot, "b1b-src");
  const dstDir = path.join(tmpRoot, "b1b-dst");

  const srcConv = new ConversationRepo(srcDir);
  const srcChar = new CharacterRepo(srcDir);
  await srcConv.init();
  await srcChar.init();

  const card = await srcChar.create({
    name: "测试角色", description: "描述", first_mes: "开场"
  });
  const conv = await srcConv.create(card.id);
  await srcConv.addMessage(conv.id, "user", "第一条");
  await srcConv.addMessage(conv.id, "assistant", "第二条");
  await srcConv.addMessage(conv.id, "user", "第三条");

  const exporter = new MigrationExporter(srcDir);
  const data = await exporter.exportAll();
  assert.equal(data.conversations.length, 1);
  assert.equal(data.conversations[0].messages.length, 3);

  const importer = new MigrationImporter(dstDir);
  const result = await importer.importData(data);

  assert.equal(result.conversations.added, 1);
  assert.equal(result.conversations.errors.length, 0, `导入报错: ${JSON.stringify(result.conversations.errors)}`);

  const dstConv = new ConversationRepo(dstDir);
  const reloaded = await dstConv.get(data.conversations[0].id);
  assert.ok(reloaded, "导入后必须能按原 id 读到");
  assert.equal(reloaded.messages.length, 3, "3 条消息必须都在");
  assert.equal(reloaded.messages[2].content, "第三条");
  assert.equal(reloaded.characterId, data.conversations[0].characterId, "characterId 必须保留");
});

await test("导入保留角色卡原 id（对话不断链）", async () => {
  const srcDir = path.join(tmpRoot, "b1c-src");
  const dstDir = path.join(tmpRoot, "b1c-dst");
  const srcChar = new CharacterRepo(srcDir);
  await srcChar.init();
  const card = await srcChar.create({ name: "A", description: "d", first_mes: "f" });

  const data = await new MigrationExporter(srcDir).exportAll();
  await new MigrationImporter(dstDir).importData(data);

  const dstChar = new CharacterRepo(dstDir);
  const reloaded = await dstChar.get(card.id);
  assert.ok(reloaded, "角色卡必须按原 id 可读");
  assert.equal(reloaded.id, card.id, "角色 id 不能被重新生成");
});

// ─────────────────────────────────────────────────────────────
section("BUG-2/3 · 流式契约与消息形状");

await test("assistant content 转成数组、system 抽到 systemPrompt", async () => {
  const { messages, extraSystem } = toStreamMessages([
    { role: "system", content: "你是角色 A" },
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好呀" },
    { role: "user", content: "继续" }
  ]);

  assert.equal(messages.length, 3, "system 不该留在 messages 里");
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content, "你好", "user.content 可以是 string");
  assert.equal(messages[1].role, "assistant");
  assert.ok(Array.isArray(messages[1].content), "assistant.content 必须是数组");
  assert.equal(messages[1].content[0].type, "text");
  assert.equal(messages[1].content[0].text, "你好呀");
  assert.equal(extraSystem, "你是角色 A");
});

await test("空内容被跳过（避免空 assistant 轮次）", async () => {
  const { messages } = toStreamMessages([
    { role: "user", content: "有内容" },
    { role: "assistant", content: "" },
    { role: "user", content: null }
  ]);
  assert.equal(messages.length, 1);
});

await test("utility 消息形状保留 system role", async () => {
  const msgs = toUtilityMessages(
    [{ role: "user", content: "hi" }],
    "系统提示"
  );
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[0].content, "系统提示");
  assert.equal(msgs[1].role, "user");
});

// ─────────────────────────────────────────────────────────────
section("BUG-4 · 工具组开关持久化 + 真生效");

await test("toggle 落盘，重新 load 后仍生效", async () => {
  const dir = path.join(tmpRoot, "b4");
  await fs.mkdir(dir, { recursive: true });

  await loadGroupState(dir);
  assert.equal(isGroupEnabled("settings"), true, "默认应启用");

  await toggleGroup("settings", false);
  assert.equal(isGroupEnabled("settings"), false, "关掉后应立刻反映");

  const file = path.join(dir, "tool-groups.json");
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(saved.settings, false, "必须落盘");

  // 模拟重启
  await loadGroupState(dir);
  assert.equal(isGroupEnabled("settings"), false, "重启后仍应关闭");
  assert.equal(isToolEnabled("tavern_list_settings"), false, "该组工具应被判为禁用");
  assert.equal(isToolEnabled("tavern_list_characters"), true, "其他组不受影响");
});

await test("文件损坏时回退默认值，不崩", async () => {
  const dir = path.join(tmpRoot, "b4-broken");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "tool-groups.json"), "{ 这不是 JSON", "utf8");

  await loadGroupState(dir);
  const groups = listGroups();
  assert.ok(groups.length > 0, "应回退到默认组");
  assert.equal(isGroupEnabled("characters"), true);
});

// ─────────────────────────────────────────────────────────────
section("BUG-6/7 · 头像与字符集");

await test("PNG 读写往返：签名完整 + 不双重包裹", async () => {
  const png = minimalPng();
  const card = { name: "头像测试", description: "描述", first_mes: "开场" };

  const written = await writePngText(png, card);
  assert.equal(isPngBuffer(written), true, "写出的必须是合法 PNG（签名不能丢）");

  const back = readPngText(written);
  assert.ok(back.chara, "readPngText 应返回 {chara: 卡}");
  assert.equal(back.chara.name, "头像测试", "不能双重包裹导致读不出 name");
  assert.equal(back.chara.description, "描述");

  // 兼容：传入已包好的形式也不应双包
  const written2 = await writePngText(png, { chara: card });
  assert.equal(readPngText(written2).chara.name, "头像测试");
});

await test("saveAvatar / readAvatar 字节一致", async () => {
  const dir = path.join(tmpRoot, "b7-avatar");
  const repo = new CharacterRepo(dir);
  await repo.init();
  const transfer = new CharacterTransfer(repo);

  const png = minimalPng();
  const written = await writePngText(png, { name: "A", description: "d", first_mes: "f" });
  const saved = await repo.create({ name: "A", description: "d", first_mes: "f" });

  const filename = await transfer.saveAvatar(saved.id, written, "png");
  assert.equal(filename, "avatar.png");

  const rb = await transfer.readAvatar(saved.id);
  assert.ok(rb, "必须能读回头像");
  assert.equal(rb.ext, "png");
  assert.ok(rb.buffer.equals(written), "头像字节必须与导入时一致");
});

await test("变量/设定 restore 保留原 id", async () => {
  const dir = path.join(tmpRoot, "b7");
  const varRepo = new VariableRepo(dir);
  const setRepo = new SettingRepo(dir);
  await varRepo.init();
  await setRepo.init();

  await varRepo.restoreDefinition({ id: "var-1", name: "hp", defaultValue: 10 });
  await setRepo.restore({ id: "set-1", name: "世界书条目", content: "内容" });

  const defs = await varRepo.listDefinitions();
  assert.equal(defs.length, 1);
  assert.equal(defs[0].id, "var-1", "变量 id 必须保留");

  const settings = await setRepo.list();
  assert.equal(settings.length, 1);
  assert.equal(settings[0].id, "set-1", "设定 id 必须保留");
});

// ─────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(60)}`);
console.log(`通过 ${passed} / 失败 ${failed}`);
console.log("=".repeat(60));

await fs.rm(tmpRoot, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
