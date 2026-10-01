// test/regression-battle.mjs — 战斗系统（第 8 期）：状态机 + 公式结算
// node test/regression-battle.mjs
// 骰子不参与这些公式（伤害用确定公式），测试可锁死具体值。

import { createBattle, initHp, playerAction, parseBattlePack } from "../lib/battle/protocol.js";

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label); }
}

const PACK = {
  player: {
    name: "月曦夜",
    attrs: { 攻击: 30, 防御: 10, 敏捷: 8, 体力: 100 },
    skills: [
      { name: "灵力箭", formula: "{攻击} * 2 - {敌人.防御}", cost: "体力 -10" }
    ]
  },
  enemy: { name: "魔族斥候", attrs: { 攻击: 12, 防御: 8, 体力: 60 } }
};

// ── createBattle / initHp ──
{
  const b = createBattle(PACK, { 体力: 80 });   // conv.variables 体力 80 被战斗包覆盖为 100
  initHp(b);
  ok(b.status === "active" && b.turn === 1, "初始状态 active/turn1");
  ok(b.player.hp === 100, "玩家 HP 取战斗包属性（100，覆盖 conv 的 80）");
  ok(b.enemyHp === 60, "敌人 HP 60");
  ok(b.player.skills.length === 1, "技能池载入");
}

// ── 普攻：max(1, 30 - 8) = 22 ──
{
  const b = initHp(createBattle(PACK));
  playerAction(b, { kind: "attack" });
  ok(b.enemyHp === 38, `普攻 22 伤害（60→38）`);
  ok(b.log.some(l => l.text.includes("22 点伤害")), "日志记伤害");
  // 敌人反击：max(1, 12-10)=2 → 玩家 98
  ok(b.player.hp === 98, "敌人反击 2 伤害（100→98）");
  ok(b.turn === 2, "回合推进");
}

// ── 技能：30*2-8=52，消耗体力 -10（另算敌人反击 -2 → hp 88）──
{
  const b = initHp(createBattle(PACK));
  playerAction(b, { kind: "skill", name: "灵力箭" });
  ok(b.enemyHp === 8, `技能 52 伤害（60→8）`);
  ok(b.player.attrs["体力"] === 90, "技能消耗体力 -10");
  ok(b.player.hp === 88, "技能消耗同步 HP 且含敌人反击（100-10-2=88）");
}

// ── 击杀 ──
{
  const b = initHp(createBattle(PACK));
  playerAction(b, { kind: "skill", name: "灵力箭" });   // 52 → 8
  playerAction(b, { kind: "skill", name: "灵力箭" });   // 52 → 0 死
  ok(b.status === "won", "敌人 HP 归零 → won");
  ok(b.turn === 2, "胜利后不推进回合（敌人已死）");
}

// ── 失败：把敌人属性改弱让玩家撑不到反击死，而是连续被打 ──
{
  const pack = JSON.parse(JSON.stringify(PACK));
  pack.enemy.attrs = { 攻击: 60, 防御: 0, 体力: 500 };   // 血厚功高
  delete pack.player.skills;                             // 只能普攻（1 伤害）
  const b = initHp(createBattle(pack));
  b.player.hp = 3;
  playerAction(b, { kind: "attack" });                    // 敌人反击 50 → -47
  ok(b.status === "lost", "玩家 HP 归零 → lost");
}

// ── 撤退 ──
{
  const b = initHp(createBattle(PACK));
  b.player.attrs["逃跑率"] = 100;
  playerAction(b, { kind: "flee" });
  ok(b.status === "fled", "逃跑率 100 → 必撤");
  const b2 = initHp(createBattle(PACK));
  b2.player.attrs["逃跑率"] = 0;
  playerAction(b2, { kind: "flee" });
  ok(b2.status === "active" && b2.log.some(l => l.text.includes("失败")), "逃跑率 0 → 必败但活着");
}

// ── 敌人属性自由定义（精神系）──
{
  const pack = JSON.parse(JSON.stringify(PACK));
  pack.enemy.attrs = { 攻击: 5, 防御: 0, 体力: 30, 恐惧: 20 };
  pack.player.skills.push({ name: "勇气审视", formula: "max(1, {灵力} - {敌人.恐惧}/2)", cost: "体力 -5" });
  const b = initHp(createBattle(pack));
  b.player.attrs["灵力"] = 30;
  playerAction(b, { kind: "skill", name: "勇气审视" });
  ok(b.enemyHp === 10, `精神系公式：max(1, 30-20/2)=20（敌 HP 30→${b.enemyHp}）`);
}

// ── parseBattlePack ──
{
  const text = `【战前剧情】
雨夜，斥候现身。

【战斗属性】
{"player":{"attrs":{"攻击":30}},"enemy":{"name":"斥候","attrs":{"体力":50}}}

【战斗行动】
- 重击 | {攻击} * 2 - {敌人.防御} | 体力 -10
- 快箭 | {敏捷} + 5

【胜利剧情】
斥候倒下。

【失败剧情】
眼前一黑。`;
  const p = parseBattlePack(text);
  ok(p.preStory === "雨夜，斥候现身。", "战前剧情切片");
  ok(p.winStory === "斥候倒下。" && p.loseStory === "眼前一黑。", "胜负剧情切片");
  ok(p.enemy?.name === "斥候" && p.enemy.attrs["体力"] === 50, "属性 JSON 解析");
  ok(p.skills.length === 2 && p.skills[0].name === "重击" && p.skills[0].cost === "体力 -10", "技能池切片（含消耗）");
}

// ── 坏公式不崩 ──
{
  const pack = JSON.parse(JSON.stringify(PACK));
  pack.player.skills.push({ name: "坏技能", formula: "1/0" });
  const b = initHp(createBattle(pack));
  playerAction(b, { kind: "skill", name: "坏技能" });
  ok(b.status === "active" && b.log.some(l => l.text.includes("公式错误")), "坏公式记日志不崩，敌人照常行动");
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
