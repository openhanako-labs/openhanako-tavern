// tools/perf-gen.mjs — 生成链路非 LLM 开销实测（第 1 项专项检查）
// 对真实数据副本跑一次 buildGenerationInput 计时——LLM 延迟是网络的事，
// App 能负责的是「模型调用之前那一串串行步骤」有多快。
// 用法：node tools/perf-gen.mjs

import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const SRC = "W:/Games/Hanako/.hanako/app-data/eleckoi-tavern";
const DATA = path.join(os.tmpdir(), "eleckoi-perf-data");
fs.rmSync(DATA, { recursive: true, force: true });
fs.cpSync(SRC, DATA, { recursive: true });

const { ConversationRepo } = await import("../lib/conversations/repo.js");
const { CharacterRepo } = await import("../lib/characters/repo.js");
const { SettingRepo } = await import("../lib/settings/repo.js");
const { BoardRepo } = await import("../lib/board/repo.js");
const { PresetRepo } = await import("../lib/presets/repo.js");
const { RegexRepo } = await import("../lib/regex/repo.js");
const { buildGenerationInput } = await import("../lib/conversations/pipeline.js");

const convRepo = new ConversationRepo(DATA);
const charRepo = new CharacterRepo(DATA);
const setRepo = new SettingRepo(DATA);
const boardRepo = new BoardRepo(DATA);
const presetRepo = new PresetRepo(DATA);
const regexRepo = new RegexRepo(DATA);

const repos = { settingRepo: setRepo, boardRepo, opsRepo: null, directorRepo: null, codexRepo: null, presetRepo, regexRepo };
const fakeLlm = {
  available: true,
  generate: async () => ({ content: "ok", usage: null }),
  resolveContextWindow: async () => 32000
};

const convs = await convRepo.list();
console.log(`对话数: ${convs.length}`);

// 挑消息最多的一场，重复跑 5 次取中位数
const conv = convs.sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0))[0];
const full = await convRepo.get(conv.id);
const card = await charRepo.get(full.characterId);
console.log(`测试场: ${full.title}（${full.messages?.length || 0} 条消息）卡: ${card?.name}`);

const times = [];
for (let i = 0; i < 5; i++) {
  const t0 = performance.now();
  await buildGenerationInput(convRepo, fakeLlm, repos, full, card, "我们继续。", {});
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
console.log(`buildGenerationInput ×5: ${times.map(t => t.toFixed(0) + "ms").join(" ")}`);
console.log(`中位数: ${times[2].toFixed(0)}ms —— 这是模型调用前的固定开销`);

// 会话列表（rail 首屏）
const t1 = performance.now();
await convRepo.list();
console.log(`会话列表: ${(performance.now() - t1).toFixed(0)}ms（${convs.length} 场）`);

fs.rmSync(DATA, { recursive: true, force: true });
