// lib/macros/registry.js — 酒馆核心宏集
//
// 覆盖范围：让 ST 角色卡能正常工作所需的那一集。
// 参照 docs.sillytavern.app/usage/core-concepts/macros 与 context-template。
//
// 分四类：
//   角色/用户：{{char}} {{user}} {{persona}} {{description}} {{personality}} ...
//   时间：    {{time}} {{date}} {{weekday}} {{isotime}} {{isodate}}
//   变量：    {{getvar}} {{setvar}} {{getglobalvar}} {{setglobalvar}} {{.x}} {{$x}}
//   工具：    {{random}} {{roll}} {{reverse}} {{newline}} {{trim}}

import { MacroRegistry } from "./engine.js";

/** 按 ST 语义判断真假：空串 / false / 0 / off / no 为假。 */
export function isFalsy(v) {
  if (v === undefined || v === null) return true;
  const s = String(v).trim().toLowerCase();
  return s === "" || s === "false" || s === "0" || s === "off" || s === "no";
}

/** 生成时间相关宏。 */
function timeMacros() {
  return {
    time: () => new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
    date: () => new Date().toLocaleDateString("zh-CN"),
    weekday: () => new Date().toLocaleDateString("zh-CN", { weekday: "long" }),
    isotime: () => new Date().toTimeString().slice(0, 8),
    isodate: () => new Date().toISOString().slice(0, 10),
    datetime: () => new Date().toLocaleString("zh-CN"),
    timestamp: () => String(Math.floor(Date.now() / 1000)),
    idle_duration: () => "0",
    localtime: () => new Date().toLocaleString("zh-CN")
  };
}

/** 变量存取（对话级 + 全局级）。 */
function variableMacros() {
  const readVar = (ctx, name, global = false) => {
    const store = global ? ctx.globalVariables : ctx.variables;
    return store?.[name];
  };
  const writeVar = (ctx, name, value, global = false) => {
    const store = global ? ctx.globalVariables : ctx.variables;
    if (!store) return undefined;
    store[name] = value;
    // 通知调用方变量已变更（便于持久化）
    ctx.onVariableChange?.(name, value, global);
    return undefined; // set 类宏不产生输出
  };

  return {
    getvar: (args, ctx) => {
      const name = args[0];
      if (!name) return "";
      const v = readVar(ctx, name, false);
      return v === undefined ? "" : String(v);
    },
    setvar: (args, ctx) => {
      const [name, value] = args;
      if (!name) return undefined;
      writeVar(ctx, name, value ?? "", false);
      return "";
    },
    addvar: (args, ctx) => {
      const [name, value] = args;
      if (!name) return undefined;
      const cur = Number(readVar(ctx, name, false)) || 0;
      writeVar(ctx, name, cur + (Number(value) || 0), false);
      return "";
    },
    incvar: (args, ctx) => {
      const name = args[0];
      if (!name) return undefined;
      const cur = Number(readVar(ctx, name, false)) || 0;
      writeVar(ctx, name, cur + 1, false);
      return "";
    },
    decvar: (args, ctx) => {
      const name = args[0];
      if (!name) return undefined;
      const cur = Number(readVar(ctx, name, false)) || 0;
      writeVar(ctx, name, cur - 1, false);
      return "";
    },
    getglobalvar: (args, ctx) => {
      const name = args[0];
      if (!name) return "";
      const v = readVar(ctx, name, true);
      return v === undefined ? "" : String(v);
    },
    setglobalvar: (args, ctx) => {
      const [name, value] = args;
      if (!name) return undefined;
      writeVar(ctx, name, value ?? "", true);
      return "";
    }
  };
}

/** 工具类宏。 */
function utilityMacros() {
  return {
    newline: () => "\n",
    trim: (args) => (args[0] || "").trim(),
    reverse: (args) => (args[0] || "").split("").reverse().join(""),
    random: (args) => {
      if (args.length === 0) return "";
      return args[Math.floor(Math.random() * args.length)];
    },
    pick: (args) => {
      if (args.length === 0) return "";
      return args[Math.floor(Math.random() * args.length)];
    },
    roll: (args) => {
      const spec = (args[0] || "1d20").trim();
      const m = spec.match(/^(\d*)d(\d+)([+-]\d+)?$/i);
      if (!m) return "0";
      const count = parseInt(m[1] || "1", 10);
      const sides = parseInt(m[2], 10);
      const mod = parseInt(m[3] || "0", 10);
      let total = 0;
      for (let i = 0; i < count; i++) total += Math.floor(Math.random() * sides) + 1;
      return String(total + mod);
    },
    // 变量简写：{{.name}} / {{$name}}
    ".": (args, ctx) => {
      const name = args[0];
      if (!name) return "";
      const v = ctx.variables?.[name];
      return v === undefined ? "" : String(v);
    },
    "$": (args, ctx) => {
      const name = args[0];
      if (!name) return "";
      const v = ctx.globalVariables?.[name];
      return v === undefined ? "" : String(v);
    }
  };
}

/** 构建酒馆核心宏注册表。 */
export function createTavernMacros() {
  const reg = new MacroRegistry();

  // ── 角色与用户 ──
  reg.define("char", (_a, ctx) => ctx.charName || "Character");
  reg.define("user", (_a, ctx) => ctx.userName || "User");
  reg.define("persona", (_a, ctx) => ctx.persona || "");
  reg.define("description", (_a, ctx) => ctx.charDescription || "");
  reg.define("personality", (_a, ctx) => ctx.charPersonality || "");
  reg.define("scenario", (_a, ctx) => ctx.charScenario || "");
  reg.define("firstmessage", (_a, ctx) => ctx.charFirstMes || "", ["first_mes"]);
  reg.define("mesexample", (_a, ctx) => ctx.charMesExample || "", ["mes_example"]);
  reg.define("systemprompt", (_a, ctx) => ctx.charSystemPrompt || "", ["system_prompt"]);
  reg.define("creatorsnotes", (_a, ctx) => ctx.charCreatorNotes || "", ["creator_notes"]);
  reg.define("charname", (_a, ctx) => ctx.charName || "Character");
  reg.define("username", (_a, ctx) => ctx.userName || "User");

  // ── 时间 ──
  for (const [name, fn] of Object.entries(timeMacros())) reg.define(name, fn);

  // ── 变量 ──
  for (const [name, fn] of Object.entries(variableMacros())) reg.define(name, fn);

  // ── 工具 ──
  for (const [name, fn] of Object.entries(utilityMacros())) reg.define(name, fn);

  // ── 条件与选择 ──
  reg.define("if", (args, ctx, meta) => {
    // {{if cond}}A{{/if}} 的作用域形式在 scope.js 里处理；
    // 这里只处理内联形式 {{if::cond::then::else}}
    const [cond, then, otherwise] = args;
    return isFalsy(cond) ? (otherwise ?? "") : (then ?? "");
  });

  reg.define("comment", () => "");

  return reg;
}

/** 从角色卡构建宏上下文。 */
export function contextFromCharacter(character, extras = {}) {
  return {
    charName: character?.name || "",
    charDescription: character?.description || "",
    charPersonality: character?.personality || "",
    charScenario: character?.scenario || "",
    charFirstMes: character?.first_mes || "",
    charMesExample: character?.mes_example || "",
    charSystemPrompt: character?.system_prompt || "",
    charCreatorNotes: character?.creator_notes || "",
    userName: extras.userName || "User",
    persona: extras.persona || "",
    variables: extras.variables || {},
    globalVariables: extras.globalVariables || {},
    onVariableChange: extras.onVariableChange
  };
}
