// test/regression-migration-import.mjs — 备份导入的 HTTP 面
//
// 为什么单独立一份：这条路以前是**整条断的**，而且断在四个不同的地方——
//   1. dom.migrationFileInput 指的是 #file-input（角色卡那个），
//      于是「导入备份」弹的是卡片文件框，选中的备份还会被卡片导入器接手；
//   2. handleMigrationFile 写好了、但从来没被绑到任何元素上；
//   3. 后端只读 c.req.json()，前端发的是 multipart → 必然抛解析错；
//   4. 「跳过已存在的数据」勾选没人读，skipExisting 永远是 false。
// 1、2 由静态检查与读代码确认（check-u1-wiring + 人眼）；3、4 靠这份测试锁住。
//
// 判据：
//   ① JSON + content：能进、计数对（脚本/工具那条入口）
//   ② JSON + content + skipExisting：已存在的被跳过、不覆盖
//   ③ multipart + file：能进（界面走的就是这条）
//   ④ multipart + skipExisting=true：勾选真的传到后端（修前必红）
//   ⑤ multipart + 坏 JSON：说明是"不是合法 JSON"，不是崩
//   ⑥ multipart 没带 file：明确报错

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeApp, request } from "./lib/route-harness.mjs";

const { CharacterRepo } = await import("../lib/characters/repo.js");
const { ConversationRepo } = await import("../lib/conversations/repo.js");
const { MigrationExporter } = await import("../lib/migration/export.js");
const { registerMigrationRoutes } = await import("../lib/migration/routes.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 备份导入（HTTP 面）===\n");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-mig-"));

// ── 造一份真备份：一张卡 + 一场对话 ──
const srcDir = path.join(tmpRoot, "src");
const srcChar = new CharacterRepo(srcDir);
await srcChar.init();
const srcConv = new ConversationRepo(srcDir);
await srcConv.init();

const card = await srcChar.create({ name: "备份里的角色", description: "描述", first_mes: "开场" });
const conv = await srcConv.create(card.id);
await srcConv.addMessage(conv.id, "user", "一条消息");

const backup = await new MigrationExporter(srcDir).exportAll();
const backupText = JSON.stringify(backup);

/** 拼一个 multipart 请求（模拟浏览器选文件那条路）。 */
function multipart(content, skipExisting) {
  const fd = new FormData();
  if (content !== undefined) {
    fd.append("file", new File([content], "backup.json", { type: "application/json" }));
  }
  if (skipExisting !== undefined) fd.append("skipExisting", String(skipExisting));
  return { headers: { "Content-Type": "multipart/form-data; boundary=----eleckoi" }, formData: fd };
}

// ── JSON 那条入口 ──
const appJson = makeApp();
registerMigrationRoutes(appJson, path.join(tmpRoot, "dst-json"));

await okAsync("① JSON + content：能进，角色与对话各 +1", async () => {
  const r = await request(appJson, "POST", "/migration/import", { body: { content: backupText } });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.characters.added, 1, JSON.stringify(r.data.characters));
  assert.strictEqual(r.data.conversations.added, 1, JSON.stringify(r.data.conversations));
});

await okAsync("② JSON + skipExisting：已存在的被跳过（added 0 / skipped 1）", async () => {
  const r = await request(appJson, "POST", "/migration/import", {
    body: { content: backupText, skipExisting: true }
  });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.characters.added, 0, "已存在的卡不该被重复导入");
  assert.strictEqual(r.data.characters.skipped, 1, JSON.stringify(r.data.characters));
  assert.strictEqual(r.data.conversations.skipped, 1, JSON.stringify(r.data.conversations));
});

// ── multipart 那条入口（界面走的）──
const appMp = makeApp();
registerMigrationRoutes(appMp, path.join(tmpRoot, "dst-mp"));

await okAsync("③ multipart + file：能进（前端发的就是这种）", async () => {
  const r = await request(appMp, "POST", "/migration/import", multipart(backupText, false));
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.characters.added, 1, JSON.stringify(r.data.characters));
  assert.strictEqual(r.data.conversations.added, 1, JSON.stringify(r.data.conversations));
});

await okAsync("④ multipart + skipExisting=true：勾选真的传到后端了", async () => {
  const r = await request(appMp, "POST", "/migration/import", multipart(backupText, true));
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.characters.added, 0, "勾了'跳过已存在'却还是导入了——skipExisting 没传过去");
  assert.strictEqual(r.data.characters.skipped, 1, JSON.stringify(r.data.characters));
});

await okAsync("⑤ multipart + 坏 JSON：说清是文件不合法，不是崩", async () => {
  const r = await request(appMp, "POST", "/migration/import", multipart("{这不是 JSON", false));
  assert.strictEqual(r.status, 400, `状态 ${r.status}`);
  assert.ok(/不是合法 JSON/.test(r.error || ""), `错误话是：${r.error}`);
});

await okAsync("⑥ multipart 没带 file：明确报错", async () => {
  const r = await request(appMp, "POST", "/migration/import", multipart(undefined, false));
  assert.strictEqual(r.status, 400, `状态 ${r.status}`);
  assert.ok(/No file/.test(r.error || ""), `错误话是：${r.error}`);
});

console.log(`\n${fail === 0 ? "✅" : "❌"} 备份导入：${pass} 过 / ${fail} 败\n`);
process.exit(fail === 0 ? 0 : 1);
