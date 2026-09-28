// test/regression-settings-quarantine.mjs — 一条坏数据不该带走整表
//
// settings.json 是一个大数组：几十上百条设定躺在同一个文件里。
// 以前任何一条坏数据（null、字符串、缺 id）都会跟着数组一起被读出来——
// 轻则在界面上渲染成空白卡片，重则在某次写入时被原样搬回去，越传越脏。
//
// 处理方式是「挪」不是「删」：坏条目进隔离区留证。
// 跟 atomic.js 把整个坏文件改名备份（.broken-<时间戳>）是同一个态度。
//
// 这里钉住五条：坏的搬走、好的照用、隔离留证、追加不覆盖、读时也过滤。

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { createSettingRepo } from "../lib/settings/repo.js";

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

async function freshRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tavern-quarantine-"));
  return { dir, repo: createSettingRepo(dir) };
}

const good = (id, name) => ({
  id, name, content: "c", keywords: [], enabled: true, order: 1, priority: 100
});

const quarantinePath = (dir) => path.join(dir, "settings.malformed.json");

console.log("\n设定库 · 损坏条目隔离");

await test("★ 一条坏数据不带走整表（改坏点）", async () => {
  const { dir, repo } = await freshRepo();
  await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify([
    good("s1", "好的甲"),
    null,                                  // 坏：根本不是对象
    good("s2", "好的乙"),
    "我是一个字符串",                       // 坏：类型错
    { name: "没有 id 的条目", content: "c" }, // 坏：定位不了
    good("s3", "好的丙")
  ]), "utf8");

  const moved = await repo.quarantineMalformedEntries();
  const all = await repo.list();

  assert.equal(moved, 3, `该搬走 3 条，实际 ${moved}`);
  assert.equal(all.length, 3, `好条目该全留下，实际 ${all.length} 条`);
  assert.deepEqual(all.map(s => s.name), ["好的甲", "好的乙", "好的丙"]);
});

await test("隔离区留证：时间、来源、原条目都在", async () => {
  const { dir, repo } = await freshRepo();
  await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify([good("s1", "好"), { name: "孤儿" }]), "utf8");
  await repo.quarantineMalformedEntries();

  const quarantined = JSON.parse(await fs.readFile(quarantinePath(dir), "utf8"));
  assert.equal(quarantined.length, 1, "该有 1 条隔离记录");
  const rec = quarantined[0];
  assert.ok(rec.quarantinedAt, "要记时间");
  assert.equal(rec.source, "settings.json", "要记来源文件");
  assert.equal(rec.entry.name, "孤儿", "原条目要原样保留");
});

await test("隔离是累积的：第二次坏的追加，不覆盖第一次", async () => {
  const { dir, repo } = await freshRepo();
  await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify([{ bad: 1 }]), "utf8");
  await repo.quarantineMalformedEntries();

  await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify([{ bad: 2 }]), "utf8");
  await repo.quarantineMalformedEntries();

  const quarantined = JSON.parse(await fs.readFile(quarantinePath(dir), "utf8"));
  assert.equal(quarantined.length, 2, `两次隔离该都留着，实际 ${quarantined.length} 条`);
});

await test("没有坏条目时不写盘（不白写）", async () => {
  const { dir, repo } = await freshRepo();
  await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify([good("s1", "甲"), good("s2", "乙")]), "utf8");
  const before = (await fs.stat(path.join(dir, "settings.json"))).mtimeMs;

  const moved = await repo.quarantineMalformedEntries();

  assert.equal(moved, 0);
  assert.equal((await fs.stat(path.join(dir, "settings.json"))).mtimeMs, before,
    "干净的库不该被重写");
  await assert.rejects(() => fs.stat(quarantinePath(dir)), "不该凭空造出隔离文件");
});

await test("list() 也过滤——文件被外部改坏时照样读得出来", async () => {
  const { dir, repo } = await freshRepo();
  // 绕过 init：直接落一份脏文件，模拟运行期间被外部改坏
  await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify([good("s1", "好"), 42]), "utf8");

  const all = await repo.list();
  assert.equal(all.length, 1, "读路径也该过滤掉坏条目");
  assert.equal(all[0].name, "好");
});

console.log(`\n通过 ${passed} / 失败 ${failed}`);
process.exit(failed > 0 ? 1 : 0);
