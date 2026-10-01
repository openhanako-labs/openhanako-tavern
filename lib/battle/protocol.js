// lib/battle/protocol.js — 战斗系统核心（第 8 期）：纯状态机 + 公式结算
//
// 设计：AI 只负责"叙事"（战前/战后剧情、技能设计），**数字全部由规则引擎算**。
//   战斗实体 = 一个纯状态对象（可 JSON 序列化，存对话上 conv.battle）；
//   每次行动 = 状态转移（attack / skill / item / flee）；
//   伤害 = 公式引擎求值（lib/story/formula.js，无 eval）。
//
// 敌人属性自由定义：不只 HP/攻击/防御——"精神系敌人"可以有 恐惧/理智伤害，
// "社交系敌人"可以有 魅力。公式里 {敌人.恐惧} 直接引用。
//
// 战斗包（AI 一次生成，按标签切片）由 routes 层解析；本文件消费的是
// 解析后的结构化对象：
//   {
//     player:   { name, attrs: {攻击, 防御, 敏捷, 体力, ...}, skills: [{name, formula, cost}] },
//     enemy:    { name, attrs: {...}, desc },
//     preStory, winStory, loseStory          // AI 写的三段剧情
//   }

import { evalFormula, FormulaError } from "../story/formula.js";

/** 新建一场战斗。 */
export function createBattle(pack, convVariables = {}) {
  return {
    status: "active",                       // active | won | lost | fled
    turn: 1,
    player: {
      name: String(pack?.player?.name || "玩家"),
      attrs: { ...convVariables, ...(pack?.player?.attrs || {}) },   // 玩家属性以 conv.variables 为底，战斗包可覆盖
      skills: Array.isArray(pack?.player?.skills) ? pack.player.skills.filter(s => s?.name && s?.formula) : [],
      hp: null
    },
    enemy: {
      name: String(pack?.enemy?.name || "敌人"),
      attrs: { ...(pack?.enemy?.attrs || {}) },
      desc: String(pack?.enemy?.desc || "")
    },
    enemyHp: null,
    log: []                                  // [{turn, side, text, detail}]
  };
}

/** 初始化 HP（体力变量或默认 100）。幂等——只在 null 时设置。 */
export function initHp(battle) {
  if (!battle) return battle;
  if (battle.player.hp == null) battle.player.hp = Number(battle.player.attrs["体力"] ?? 100) || 100;
  if (battle.enemyHp == null) battle.enemyHp = Number(battle.enemy.attrs["体力"] ?? battle.enemy.attrs["生命"] ?? 100) || 100;
  return battle;
}

/**
 * 玩家行动一次。
 * @param {object} battle
 * @param {{kind:"attack"}|{kind:"skill",name:string}|{kind:"flee"}} action
 * @returns {object} battle（原地修改）+ 本次转移的摘要从 battle.log 尾部取
 */
export function playerAction(battle, action) {
  if (!battle || battle.status !== "active") return battle;
  initHp(battle);

  const pAttrs = battle.player.attrs;
  const eAttrs = battle.enemy.attrs;
  const get = (obj, k) => Number(obj[k] ?? 0) || 0;

  // 玩家打敌人：公式里的 {x} 是玩家属性，{敌人.x} 是敌人属性
  const playerVars = {};
  for (const [k, v] of Object.entries(pAttrs)) playerVars[k] = v;
  for (const [k, v] of Object.entries(eAttrs)) playerVars[`敌人.${k}`] = v;
  playerVars["敌人.HP"] = battle.enemyHp;

  if (action.kind === "flee") {
    const chance = Number(pAttrs["逃跑率"] ?? 50);
    if (Math.random() * 100 < chance) {
      battle.status = "fled";
      battle.log.push({ turn: battle.turn, side: "player", text: "撤退成功。" });
    } else {
      battle.log.push({ turn: battle.turn, side: "player", text: "撤退失败！" });
      enemyTurn(battle);
    }
    return battle;
  }

  let formula;
  let label;
  if (action.kind === "skill") {
    const skill = battle.player.skills.find(s => s.name === action.name);
    if (!skill) {
      battle.log.push({ turn: battle.turn, side: "player", text: `没有「${action.name}」这个技能。` });
      return battle;
    }
    // 消耗（cost: "体力 -10" 或 {var: x, delta: n}）
    if (skill.cost) applyCost(battle, skill.cost);
    formula = skill.formula;
    label = skill.name;
  } else {
    formula = "max(1, {攻击} - {敌人.防御})";
    label = "攻击";
  }

  let dmg;
  try {
    dmg = Math.max(0, Math.round(evalFormula(formula, playerVars)));
  } catch (e) {
    if (e instanceof FormulaError) {
      battle.log.push({ turn: battle.turn, side: "player", text: `${label}失败了（公式错误：${e.message}）` });
      enemyTurn(battle);
      return battle;
    }
    throw e;
  }

  battle.enemyHp = Math.max(0, battle.enemyHp - dmg);
  battle.log.push({ turn: battle.turn, side: "player", text: `${label}命中，敌人受到 ${dmg} 点伤害（敌人 HP ${battle.enemyHp}）。`, dmg });

  if (battle.enemyHp <= 0) {
    battle.status = "won";
    return battle;
  }

  enemyTurn(battle);
  return battle;
}

/** 敌人回合：伤害公式 {敌人.攻击} - {防御}，下限 1。 */
function enemyTurn(battle) {
  const vars = { ...battle.player.attrs, ...renameEnemy(battle.enemy.attrs) };
  let dmg;
  try {
    dmg = Math.max(1, Math.round(evalFormula("max(1, {敌人.攻击} - {防御})", vars)));
  } catch {
    dmg = 1;
  }
  battle.player.hp = Math.max(0, battle.player.hp - dmg);
  battle.log.push({ turn: battle.turn, side: "enemy", text: `${battle.enemy.name}反击，你受到 ${dmg} 点伤害（你的 HP ${battle.player.hp}）。`, dmg });
  if (battle.player.hp <= 0) battle.status = "lost";
  else battle.turn += 1;
}

function renameEnemy(attrs) {
  const out = {};
  for (const [k, v] of Object.entries(attrs || {})) out[`敌人.${k}`] = v;
  return out;
}

/** 应用技能消耗。cost 形状："体力 -10" 简写 或 {var, delta}。 */
function applyCost(battle, cost) {
  if (typeof cost === "string") {
    const m = cost.match(/^\s*(\S+)\s*([+-])\s*(\d+)\s*$/);
    if (m) {
      const cur = Number(battle.player.attrs[m[1]] ?? 0) || 0;
      battle.player.attrs[m[1]] = m[2] === "-" ? cur - Number(m[3]) : cur + Number(m[3]);
      if (m[1] === "体力") battle.player.hp = Math.max(0, battle.player.hp - Number(m[3]));
    }
  } else if (cost && typeof cost === "object" && cost.var) {
    const cur = Number(battle.player.attrs[cost.var] ?? 0) || 0;
    battle.player.attrs[cost.var] = cur + (Number(cost.delta) || 0);
  }
}

/**
 * 解析 AI 战斗包文本（标签切片，与剧情卡协议同风格）。
 * 标签：战斗属性（player/enemy JSON）、战斗行动（技能池）、战前剧情、战后胜利/失败。
 */
export function parseBattlePack(text) {
  const out = { preStory: "", winStory: "", loseStory: "", player: null, enemy: null, skills: [] };
  const lines = String(text ?? "").split(/\r?\n/);
  let section = null;
  const buf = [];
  const flush = () => {
    if (!section) return;
    const body = buf.join("\n").trim();
    if (section === "战前剧情") out.preStory = body;
    else if (section === "胜利剧情") out.winStory = body;
    else if (section === "失败剧情") out.loseStory = body;
    else if (section === "战斗属性") {
      try {
        const j = JSON.parse(body.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, ""));
        out.player = j.player || null;
        out.enemy = j.enemy || null;
      } catch { /* 坏 JSON 不崩 */ }
    } else if (section === "战斗行动") {
      out.skills = lines2skills(body);
    }
    buf.length = 0;
  };

  for (const line of lines) {
    const m = line.match(/^【(.+?)】\s*$/);
    if (m) { flush(); section = m[1].trim(); continue; }
    if (section) buf.push(line);
  }
  flush();
  // skills 兜底：从解析出的 player 里来
  if (out.player?.skills?.length) out.skills = out.player.skills;
  return out;
}

/** 行动池逐行：技能名|公式（|消耗 可选） */
function lines2skills(body) {
  return body.split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.replace(/^[-*]\s*/, ""))
    .map(l => {
      const parts = l.split("|").map(s => s.trim());
      if (parts.length < 2) return null;
      return { name: parts[0], formula: parts[1], cost: parts[2] || null };
    })
    .filter(Boolean);
}

export default { createBattle, initHp, playerAction, parseBattlePack };
