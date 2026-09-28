// test/regression-scene-instruction.mjs — 「配图约定」按配置注入
//
// 背景（2026-09-27）：spec §4 原本的立场是「模型漏写标记？不救」——
// 可 App 从来没告诉过模型有 `[场景]` 这回事。于是 `mode=marker` 对普通用户
// 等于**永不触发**，而设置面板写着「模型写 [场景] 时自动出图」，读起来像它自己会。
// 判据 3「开启后出图」在那种状态下不是验不出 bug，是**从来没机会发生**。
//
// 定案：只在 `enabled && mode === "marker"` 时往稳定前缀注入一句约定。
//
// 四条：
//   ① marker 开着 → 提示词里有那句，且用的是解析器认的那个标记
//   ② mode=off   → 不注入
//   ③ 总闸关（默认）→ 不注入（一个字都不多花）
//   ④ 它得是**前缀的一部分**——开关一次，账上要说得出是哪块变了

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeApp, request } from "./lib/route-harness.mjs";

const { CharacterRepo } = await import("../lib/characters/repo.js");
const { ConversationRepo } = await import("../lib/conversations/repo.js");
const { SettingRepo } = await import("../lib/settings/repo.js");
const { RegexRepo } = await import("../lib/regex/repo.js");
const { PresetRepo } = await import("../lib/presets/repo.js");
const { BoardRepo } = await import("../lib/board/repo.js");
const { registerConversationRoutes } = await import("../lib/conversations/routes.js");
const { writeSceneConfig, emptySceneConfig } = await import("../lib/illustration/config.js");
const { SCENE_MARKER_HEAD } = await import("../lib/illustration/scene-marker.js");

let pass = 0, fail = 0;
async function ok(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e.message}`);
    fail++;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-scene-ins-"));
const dataDir = tmp;

const charRepo = new CharacterRepo(tmp); await charRepo.init();
const convRepo = new ConversationRepo(tmp); await convRepo.init();
const setRepo = new SettingRepo(tmp); await setRepo.init();
const regexRepo = new RegexRepo(tmp); await regexRepo.init();
const presetRepo = new PresetRepo(tmp); await presetRepo.init();
const boardRepo = new BoardRepo(tmp); await boardRepo.init();

// 预览不跑模型；但注册要一个形状像 llm 的东西。
const fakeLlm = {
  async *stream() { yield { type: "done" }; },
  async complete() { return { content: "（不该被调到）" }; }
};

const app = makeApp();
// 关键：把 dataDir 传进去 —— 注入的门票就在这里（不传则整块跳过，行为与今天一致）
registerConversationRoutes(app, convRepo, fakeLlm, charRepo, setRepo, regexRepo, presetRepo, boardRepo, { sdk: null, dataDir });

const card = await charRepo.create({ name: "薇拉·霜语", description: "北境守夜法师", first_mes: "「……」" });
const conv = await convRepo.create(card.id);

async function preview() {
  const r = await request(app, "POST", `/conversations/${conv.id}/prompt-preview`, {
    body: { text: "你好" }
  });
  assert.equal(r.status, 200, `prompt-preview 应 200，实为 ${r.status}（${r.error || ""}）`);
  return r.data || {};
}

console.log("\n场景插图 · 配图约定的注入");

await ok("① enabled=true + mode=marker → 注入，且用的是解析器认的标记", async () => {
  await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: true, mode: "marker" });
  const { systemPrompt } = await preview();
  assert.ok(systemPrompt.includes("配图约定"), "该有那句约定");
  assert.ok(systemPrompt.includes(SCENE_MARKER_HEAD), "标记的写法必须和解析器一致");
});

await ok("② mode=off → 不注入", async () => {
  await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: true, mode: "off" });
  const { systemPrompt } = await preview();
  assert.ok(!systemPrompt.includes("配图约定"), "mode=off 不该注入");
});

await ok("③ 总闸关（默认）→ 不注入（一个字都不多花）", async () => {
  await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: false, mode: "marker" });
  const { systemPrompt } = await preview();
  assert.ok(!systemPrompt.includes("配图约定"), "总闸关着不该注入");
});

await ok("④ 它得是稳定前缀的一部分——开关一次，账上说出是哪块变了", async () => {
  await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: true, mode: "marker" });
  const r1 = await preview();
  const parts1 = r1.audit?.prefix?.parts || [];
  assert.ok(parts1.some(p => p.kind === "scene-instruction"),
    "前缀分区里该有 scene-instruction（不在分区里就说明没进前缀）");
  const fp1 = r1.audit?.prefix?.fingerprint;

  // 关掉总闸，前缀指纹必须变；而且账上要说得出是哪一块
  await writeSceneConfig(dataDir, { ...emptySceneConfig(), enabled: false, mode: "marker" });
  const r2 = await preview();
  const fp2 = r2.audit?.prefix?.fingerprint;
  assert.notEqual(fp1, fp2, "关掉总闸后前缀指纹必须变（不变说明它压根没进前缀）");
  assert.ok((r2.audit?.prefix?.changed?.parts || []).includes("scene-instruction"),
    "账上该指出是 scene-instruction 变了");
});

console.log("");
if (fail) {
  console.error(`❌ 配图约定注入：${pass} 过 / ${fail} 败`);
  process.exit(1);
}
console.log(`✅ 配图约定注入：${pass} 过 / 0 败`);
