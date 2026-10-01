// tools/seed-story-demo.mjs — 造一份带剧情卡消息的数据副本，供 ui-host 起界面肉眼验收
//
// 用法：node tools/seed-story-demo.mjs
// 产出：把真实数据拷到 <repo>/tools/.story-demo-data，往里塞一场对话，
//       其中一条 assistant 消息是 cwv1 协议文本，并已走 settleStoryMessage 解析。
//       随后可用 ELECKOI_DATA=<该目录> node tools/ui-host.mjs 起界面看渲染。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.env.ELECKOI_DATA || "W:/Games/Hanako/.hanako/app-data/eleckoi-tavern";
const DEST = path.join(ROOT, "tools", ".story-demo-data");

const { ConversationRepo } = await import("../lib/conversations/repo.js");
const { CharacterRepo } = await import("../lib/characters/repo.js");
const { settleStoryMessage } = await import("../lib/story/effects.js");

// 1. 拷一份数据（覆盖旧的）
fs.rmSync(DEST, { recursive: true, force: true });
fs.cpSync(SRC, DEST, { recursive: true });
console.log("数据副本:", DEST);

// 2. 挑一张角色卡
const charRepo = new CharacterRepo(DEST);
const chars = await charRepo.list();
if (!chars.length) { console.error("没有角色卡，无法造样本"); process.exit(1); }
const card = chars[0];
console.log("用卡:", card.name, card.id);

// 3. 建一场对话
const convRepo = new ConversationRepo(DEST);
const conv = await convRepo.create(card.id, { title: "剧情卡渲染验收" });

// 4. 一条用户消息 + 一条协议 assistant 消息
await convRepo.addMessage(conv.id, "user", "我环顾四周，看看这是哪里。");

const STORY = `【剧情】
类型: 主线
标题: 雨夜的第七塔
场景: 北境哨塔 · 夜 · 雨

【对话】
【旁白】: 雨点敲在结界上，像无数细小的锤子。薇拉裹紧守夜人的斗篷，塔灯在她身后摇晃。
【薇拉|警惕】: 「这个点钟，商队不该出现在北境。」
【你】: 「也许只是迷路了。雪原上的参照物不多。」
【薇拉|摇头】: 「迷路的商队不会带着魔族的徽记。」
【旁白】: 她按住腰间的短刀。

【效果】
体力 -10
薇拉.好感度 +2
时间 = 深夜

【场景更新】
新增人物: 商队头领|男|戒备|次要：高大，戴斗篷
新增物品: 魔族徽记：黑铁，刻有眼睛

【选项】
A. 跟薇拉一起去塔下盘查商队
B. 留在塔顶，用望远镜继续观察
C. 先检查结界的损耗情况

【摘要】
月曦夜在雨夜登上第七塔，与守护者薇拉一同发现了可疑的商队。`;

const saved = await convRepo.addMessage(conv.id, "assistant", STORY);
const fresh = await convRepo.get(conv.id);
const r = await settleStoryMessage({ conv: fresh, message: saved, conversationRepo: convRepo });
console.log("解析 found:", r.parsed?.found, "| 效果落账:", r.applied, "| 错误:", r.errors);

const after = await convRepo.get(conv.id);
const msg = after.messages.find(m => m.id === saved.id);
console.log("msg.story 已挂:", !!msg?.story?.found, "| varDiff:", (msg?.varDiff || []).length, "条");
console.log("conv id:", conv.id);
console.log("\n起界面：");
console.log(`  $env:ELECKOI_DATA="${DEST}"; node tools/ui-host.mjs`);
