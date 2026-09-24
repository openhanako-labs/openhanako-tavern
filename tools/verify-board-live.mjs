// tools/verify-board-live.mjs — 拿**真实数据**跑一遍装配，人眼看 prompt
//
// 为什么有这个工具：
//   宿主把 App 的 HTTP 面锁在鉴权后面（直接打 /api/apps/<id>/... 是 403），
//   界面里的「组装预览」（⋯ 菜单）要人手点。两条路都不适合在做改动时
//   自己核对。这个脚本直接吃 app-data 目录里的真角色卡与真对话，
//   跑同一条 buildGenerationInput，把 [静态前缀][动态尾部] 打出来，
//   并把分界位置标出来——前缀是不是稳的、颜色一眼可辨。
//
// 用法：
//   node tools/verify-board-live.mjs                    # 只读：看现在的装配结果
//   node tools/verify-board-live.mjs --seed             # 往对话里放两格演示黑板
//   node tools/verify-board-live.mjs --clean            # 把那两格删掉
//   node tools/verify-board-live.mjs --conv <id>        # 指定对话
//
// 环境变量 ELECKOI_DATA 可以改数据目录（默认本机 app-data）。

import fs from "node:fs";
import path from "node:path";

const DATA = process.env.ELECKOI_DATA
  || "W:/Games/Hanako/.hanako/app-data/eleckoi-tavern";

const args = process.argv.slice(2);
const FLAG = (name) => args.includes(`--${name}`);
const OPT = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

const { CharacterRepo } = await import("../lib/characters/repo.js");
const { ConversationRepo } = await import("../lib/conversations/repo.js");
const { SettingRepo } = await import("../lib/settings/repo.js");
const { RegexRepo } = await import("../lib/regex/repo.js");
const { BoardRepo } = await import("../lib/board/repo.js");
const { charVisibility, USER_VISIBILITY } = await import("../lib/board/model.js");
const { applyMacrosToCharacter, buildGenerationInput } = await import("../lib/conversations/pipeline.js");

const SEED_TITLE = "第七塔的夜";
const SEED_PRIVATE = "她的旧疤";
const SEED_USER = "我今晚要做的事";

const charRepo = new CharacterRepo(DATA);
const convRepo = new ConversationRepo(DATA);
const settingRepo = new SettingRepo(DATA);
const regexRepo = new RegexRepo(DATA);
const boardRepo = new BoardRepo(DATA);
await charRepo.init();
await convRepo.init();
await settingRepo.init();
await regexRepo.init();
await boardRepo.init();

// ── 挑一条对话 ──
const convs = await convRepo.list();
if (convs.length === 0) {
  console.error("数据目录里没有对话，先在界面上建一条。");
  process.exit(1);
}
const convId = OPT("conv") || convs[0].id;
const conv = await convRepo.get(convId);
if (!conv) { console.error(`找不到对话 ${convId}`); process.exit(1); }

const card = await charRepo.get(conv.characterId);
if (!card) { console.error(`对话指向的角色卡读不到：${conv.characterId}`); process.exit(1); }

console.log(`数据目录  ${DATA}`);
console.log(`对话      ${conv.id}`);
console.log(`角色      ${card.name}`);

// ── --clean ──
if (FLAG("clean")) {
  const cells = await boardRepo.listChatCells(conv.id);
  let n = 0;
  for (const c of cells) {
    if ([SEED_TITLE, SEED_PRIVATE, SEED_USER].includes(c.title)) {
      await boardRepo.deleteCell(c.id, conv.id);
      n++;
    }
  }
  console.log(`\n已删除 ${n} 格演示黑板。`);
  process.exit(0);
}

// ── --seed ──
if (FLAG("seed")) {
  const existing = new Set((await boardRepo.listChatCells(conv.id)).map(c => c.title));
  const want = [
    { title: SEED_TITLE, body: "塔顶的结界在响，风里有冰屑味。第七塔只有她一个人守。", activation: "constant", order: 10 },
    { title: SEED_PRIVATE, body: "左眼的疤在发烫。三年前那一夜她没说完的话。", activation: "constant", visible: charVisibility(card.id), order: 20 },
    { title: SEED_USER, body: "今晚试探她的底线。", activation: "constant", visible: USER_VISIBILITY, order: 30 }
  ];
  let n = 0;
  for (const w of want) {
    if (existing.has(w.title)) continue;
    await boardRepo.createCell({ ...w, lifespan: "chat", visible: w.visible || "public" }, conv.id);
    n++;
  }
  console.log(`\n已放入 ${n} 格演示黑板（公共常驻 / 只有她 / 只有你）。`);
}

// ── 装配 ──
const character = applyMacrosToCharacter(card, conv, {});
const INPUT = "我上来了。今晚风大。";
const result = await buildGenerationInput(
  { conversationRepo: convRepo, characterRepo: charRepo, settingRepo, regexRepo, boardRepo },
  conv, character, INPUT, { contextWindow: 32000, maxTokens: 800 }
);

const sp = result.systemPrompt;
const marks = ["## 世界设定", "## 世界 · 本轮"]
  .map(m => ({ m, i: sp.indexOf(m) }))
  .filter(x => x.i >= 0);
const cut = marks.length ? Math.min(...marks.map(x => x.i)) : sp.length;

console.log(`\n世界书命中  ${result.meta.loreCount} 条`);
console.log(`黑板        ${result.meta.boardCount} 格（常驻 ${result.meta.boardPrefixCount} / 本轮 ${result.meta.boardTailCount}）`);
if (result.meta.boardTitles?.length) console.log(`            ${result.meta.boardTitles.join(" / ")}`);

const bar = "─".repeat(64);
console.log(`\n${bar}\n静态前缀（这一段该被 prefix cache 命中）\n${bar}`);
console.log(sp.slice(0, cut).trimEnd());

console.log(`\n${bar}\n动态尾部（每轮都可能变，从前缀之后开始）\n${bar}`);
console.log(cut < sp.length ? sp.slice(cut) : "（本轮没有尾部）");

console.log(`\n${bar}`);
console.log(`前缀 ${sp.slice(0, cut).trimEnd().length} 字符 / 尾部 ${sp.length - cut} 字符`);
