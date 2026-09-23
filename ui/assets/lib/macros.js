// ⚠ 双胞胎镜像：本文件与仓库另一端的宏引擎副本必须逐字节一致（test/check-macro-twin.mjs 盯着）。
// 分家原因：浏览器只能取到 /ui/ 路由暴露域内的文件。
// 改任何一处，都同步另一处——不同步，测试会红。
// lib/macros/index.js — 宏引擎
//
// 宏是 {{name}} 形式的占位替换。真正难的从来不是替换本身，是这三件事：
//
//   1. 静默失败：一个未定义宏把整段提示词糊掉。→ 未定义的宏原样保留并记录，
//      调用方（探针）能看到它，而不是悄悄变成空串。
//   2. 变量副作用：{{setvar name=value}} 之类会写变量。变量写在对话记录上
//      （variableRepo.updateVariables），如果宏执行过程中的写冲突，
//      会覆盖玩家手改的值。→ 所有变量写收敛到 onVariableChange 一个回调，
//      由调用方决定何时真正落盘（对话保存时），不在解析过程中落盘。
//   3. 嵌套与自引用：{{a{{b}}}} 的解析顺序、宏值里含 {{}} 时的循环。
//      → 固定最大深度，超深即停并记录，不无限递归。
//
// 语法：{{name}}、{{name arg}}、{{name arg1 arg2}}（参数空格分隔）。
// 也接受 SillyTavern 习惯的 {{getvar::name}}。

const MAX_DEPTH = 8;
const MAX_PASSES = 3;
/** 宏函数内部再调 process() 的最大递归层数（防自引用宏爆栈） */
const MACRO_RECURSION_LIMIT = 6;

/** 内置宏表。value 可以是常量或 (ctx, args) => string */
function builtinMacros() {
  return {
    user: (ctx) => ctx?.userName ?? "User",
    char: (ctx) => ctx?.characterName ?? "Character",
    persona: (ctx) => ctx?.persona ?? "",
    description: (ctx) => ctx?.character?.description ?? "",
    personality: (ctx) => ctx?.character?.personality ?? "",
    scenario: (ctx) => ctx?.character?.scenario ?? "",
    first_mes: (ctx) => ctx?.character?.first_mes ?? "",
    mes_example: (ctx) => ctx?.character?.mes_example ?? "",
    system_prompt: (ctx) => ctx?.character?.system_prompt ?? "",
    time: () => new Date().toLocaleTimeString(),
    date: () => new Date().toLocaleDateString(),
    datetime: () => new Date().toLocaleString(),
    weekday: () => ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date().getDay()],
    /** 反转一段文本 */
    reverse: (ctx, args) => [...String(args[0] ?? "")].reverse().join(""),
    /** 掷骰：{{roll::1d6}}、{{roll 2d6+3}}。非法表达式返回空串，不抛。 */
    roll: (ctx, args) => {
      const expr = String(args.join(" ") || "1d6").replace(/\s+/g, "");
      const m = expr.match(/^([0-9]*)d([0-9]+)([+-][0-9]+)?$/i);
      if (!m) return "";
      const count = Math.min(Number(m[1] || 1), 100); // 上限 100 个骰子
      const sides = Number(m[2]);
      if (!Number.isFinite(sides) || sides < 2) return "";
      let sum = 0;
      for (let i = 0; i < count; i++) sum += 1 + Math.floor(Math.random() * sides);
      if (m[3]) sum += Number(m[3]);
      return String(sum);
    },
    random: (ctx, args) => {
      // 兼容两种写法：逗号分隔（{{random a,b}}）与 :: 分隔（{{random::红::绿}}）
      const joined = args.join(" ");
      const pool = (joined.includes(",") ? joined.split(",") : args)
        .flatMap(s => String(s).split("::"))
        .map(s => s.trim())
        .filter(Boolean);
      return pool.length ? pool[Math.floor(Math.random() * pool.length)] : "";
    },
    newline: () => "\n",
    // SillyTavern 兼容
    getvar: (ctx, args) => {
      const name = (args[0] || "").replace(/^::/, "");
      const v = lookupVariable(ctx, name);
      return v == null ? "" : String(v);
    },
    setvar: (ctx, args) => {
      // 支持 {{setvar::name::value}}、{{setvar name=value}}、{{setvar::name=value}}
      // 按 :: 或 = 切一次，只取前两段——值里允许再出现这些字符。
      const joined = args.join("::");
      const sep = joined.includes("::") ? "::" : (joined.includes("=") ? "=" : null);
      if (!sep) return "";
      const idx = joined.indexOf(sep);
      const name = joined.slice(0, idx).trim();
      const value = joined.slice(idx + sep.length).trim();
      if (name) queueVariableChange(ctx, name, value);
      return "";
    }
  };
}

function lookupVariable(ctx, name) {
  if (!name) return null;
  const v = ctx?.variables || {};
  const g = ctx?.globalVariables || {};
  if (name in v) return v[name];
  if (name in g) return g[name];
  return null;
}

/** 变量写先入队，不立即落盘（见文件头第 2 条） */
function queueVariableChange(ctx, name, value) {
  if (!ctx || !name) return;
  // 直接写回 ctx.variables：调用方传进来的就是它持有的对象
  // （测试里是 const vars = {}），只写 __pendingChanges 的话
  // 调用方看不到任何变化，等于没写。
  if (ctx.variables && typeof ctx.variables === "object") {
    ctx.variables[name] = value;
  }
  ctx.__pendingChanges = ctx.__pendingChanges || {};
  ctx.__pendingChanges[name] = value;
  if (typeof ctx.onVariableChange === "function") {
    try { ctx.onVariableChange(name, value); } catch { /* 回调失败不阻断宏解析 */ }
  }
}

export class MacroProcessor {
  constructor(macros = null) {
    this.macros = macros || builtinMacros();
  }

  /** 注册自定义宏（后注册覆盖内置同名） */
  register(name, fn) {
    if (typeof name === "string" && typeof fn === "function") this.macros[name] = fn;
    return this;
  }

  /**
   * 解析一段文本。
   * @param {string} text
   * @param {object} ctx
   * @returns {{text: string, undefinedMacros: string[], depthLimitHit: boolean}}
   */
  parse(text, ctx = {}) {
    const undefinedMacros = [];
    let depthLimitHit = false;
    let current = String(text ?? "");

    // \{\{ 转义：把「反斜杠 + {{」整段换成占位符，解析完还原成 {{。
    // 关键是占位符替换要连同一个反斜杠一起吃进——否则还原后
    // 输出里会多出一个反斜杠，玩家写 \{\{ 就得到 \{\{ 。
    // \{\{ 转义：把「反斜杠 + {{」换成占位符，解析完还原成 {{。
    // 注意正则在源码里是 /\\\{\{/ —— 匹配**一个**反斜杠加 {{，
    // 写多一个反斜杠就只匹配双反斜杠，转义永远不生效。
    const ESC_OPEN = "\u0000EO\u0000";
    const ESC_CLOSE = "\u0000EC\u0000";
    // 玩家写的 \{\{ 在内存里是四个字符：\ { \ {
    // （两个 "\{" 单元）。所以正则要匹配「反斜杠+{」重复两次，
    // 写成 /\\\{\\{/ —— 少写一个 \{ 就永远匹配不上。
    // }} 那侧同理：\}\} 也是两个 "\}" 单元。
    // 开/关用不同占位符，否则还原时 \}\} 会变成 {{。
    current = current.replace(/\\\{\\\{/g, ESC_OPEN);
    current = current.replace(/\\\}\\\}/g, ESC_CLOSE);

    // 块级结构：{{if ...}}...{{else}}...{{/if}} 与注释
    // 这些不能按单个 {{}} 处理，否则 else/endif 自己会被当宏名。
    current = this.resolveBlocks(current, ctx, undefinedMacros);

    let pass = 0;
    while (pass < MAX_PASSES) {
      pass++;
      let changed = false;
      let depth = 0;
      let out = "";
      let i = 0;

      while (i < current.length) {
        if (current.startsWith("{{", i)) {
          // 深度检查必须放在"能否解析"之前：未定义的宏同样会走进
          // 这条分支，若不先计数，"{{{{{{{{{{x" 这类病态输入永远不会
          // 触发保护——保护就名存实亡了。
          if (depth >= MAX_DEPTH) {
            depthLimitHit = true;
            out += current[i];
            i++;
            continue;
          }
          // 找配对的 }}
          const end = this.findClose(current, i + 2);
          if (end === -1) { out += current[i]; i++; continue; }

          const inner = current.slice(i + 2, end).trim();
          // 内层仍是完整宏（如 {{getvar::{{char}}_mood}} 的内层
          // 是 {{char}}_mood）时，先把内层解析掉，再拿结果当外层参数。
          let effectiveInner = inner;
          if (/\{\{[\s\S]*\}\}/.test(inner)) {
            const nested = this.parse(inner, ctx);
            effectiveInner = nested.text;
          }
          const res = this.resolveOne(effectiveInner, ctx, undefinedMacros);
          if (res.resolved) {
            depth++;
            out += res.value;
            changed = true;
            i = end + 2;
          } else if (inner.includes("{{")) {
            // 内层还含 {{：说明这是"多开左括号"的病态输入
            // （如 {{{{{{{{{{x）。若按整段消费，depth 只 +1
            // 就跳过全部，保护永远不触发。
            // 按字符推进，让外层逐层计数。
            depth++;
            out += "{{";
            i += 2;
          } else {
            // 普通未定义宏：原样保留
            depth++;
            out += current.slice(i, end + 2);
            i = end + 2;
          }
        } else {
          out += current[i];
          i++;
        }
      }

      current = out;
      if (!changed) break;
      if (pass >= MAX_PASSES && /\{\{/.test(current)) {
        // 多轮仍有 {{：两种可能——循环引用 / 深度刚好卡在 MAX_DEPTH 上
        // 无论哪种，都算没解析干净，如实告知调用方
        depthLimitHit = true;
        break;
      }
    }

    return {
      text: current.split(ESC_OPEN).join("{{").split(ESC_CLOSE).join("}}"),
      undefinedMacros: [...new Set(undefinedMacros)],
      depthLimitHit
    };
  }

  /**
   * 处理块级结构：{{if X}}...{{else}}...{{/if}}、{{/if}}、注释。
   *
   * 为什么单独一层：这些标记的语义是「决定中间一大段留不留」,
   * 按单个 {{}} 替换会把 else / /if 当成未定义宏留在文本里。
   * 这里用括号配对，非状态机——玩家不会写没闭合的 if，但会写错，
   * 配对失败就原样保留，让未定义宏路径去处理。
   */
  resolveBlocks(text, ctx, undefinedMacros) {
    let out = text;

    // {{if 条件}}A{{else}}B{{/if}}
    // 条件里可能嵌套宏（{{if {{getvar::flag}}}}），所以结束的 }}
    // 必须按括号配对找，不能取第一个 —— 否则条件被截断，
    // 残留的 }} 会出现在输出里。
    for (let guard = 0; guard < 20; guard++) {
      const start = out.search(/\{\{\s*if\s/);
      if (start === -1) break;
      const closeIdx = out.indexOf("{{/if}}", start);
      if (closeIdx === -1) break;

      // 从 start 起按 {{ }} 配对找条件的闭合
      const condEnd = this.matchBrace(out, start + 2);
      if (condEnd === -1 || condEnd > closeIdx) break;

      const condition = out.slice(start + 2, condEnd).replace(/^\s*if\s*/, "").trim();
      const body = out.slice(condEnd + 2, closeIdx);
      const elseAt = body.indexOf("{{else}}");
      const condVal = this.truthy(condition, ctx, undefinedMacros);

      // 没有 else 时：条件为假 → 整块消失；为真 → 留 body。
      // 有 else 时：按条件二选一。
      // 写成这样而不是 taken = body，是因为「无条件分支」会让
      // {{if }}不该出现{{/if}} 的原样漏出去——那不是 ST 的语义。
      const taken = elseAt === -1
        ? (condVal ? body : "")
        : (condVal ? body.slice(0, elseAt) : body.slice(elseAt + 8));

      out = out.slice(0, start) + taken + out.slice(closeIdx + 7);
    }

    // 注释：{{// ...}} 与 {{# ...}} 整块丢弃（不产生输出）
    out = out.replace(/\{\{[\/\/#][\s\S]*?\}\}/g, "");

    return out;
  }

  /**
   * 从 pos 起按 {{ }} 配对，返回最外层 }} 的位置；失败返回 -1。
   * @param {string} s
   * @param {number} pos - {{ 之后的位置
   */
  matchBrace(s, pos) {
    let depth = 1;
    for (let i = pos; i < s.length - 1; i++) {
      if (s.startsWith("{{", i)) { depth++; i++; continue; }
      if (s.startsWith("}}", i)) { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  /**
   * 条件求值。语义刻意宽松：空、"false"、"0"、"no"、"null" 为假，
   * 其余为真。条件本身先过一遍宏（{{if {{getvar::flag}}}} 才成立）。
   */
  truthy(condition, ctx, undefinedMacros) {
    const raw = String(condition ?? "").trim();
    if (raw === "") return false;
    // 条件里可能含宏，先解析
    const expanded = raw.includes("{{") ? this.parse(raw, ctx).text.trim() : raw;
    if (expanded === "") return false;
    const low = expanded.toLowerCase();
    if (["false", "0", "no", "null", "undefined", "否"].includes(low)) return false;
    return true;
  }

  /** 从 pos 起找配对的 }}，支持一层嵌套 */
  findClose(s, pos) {
    let d = 1;
    for (let i = pos; i < s.length; i++) {
      if (s.startsWith("{{", i)) { d++; i++; continue; }
      if (s.startsWith("}}", i)) { d--; if (d === 0) return i; }
    }
    return -1;
  }

  /** 解析单个 {{...}} 内容 */
  resolveOne(inner, ctx, undefinedMacros) {
    if (!inner) return { resolved: false };
    // 参数统一按 :: 与空格切分（ST 两种都有人用）
    const parts = inner.split(/::|\s+/).filter(Boolean);
    const name = parts[0];
    const args = parts.slice(1);

    // {{.x}} → 读对话变量；{{$x}} → 读全局变量
    if (name.startsWith(".") && name.length > 1) {
      const key = name.slice(1);
      const v = lookupVariable(ctx, key);
      return { resolved: true, value: v == null ? "" : String(v) };
    }
    if (name.startsWith("$") && name.length > 1) {
      const key = name.slice(1);
      const g = ctx?.globalVariables || {};
      const v = key in g ? g[key] : null;
      return { resolved: true, value: v == null ? "" : String(v) };
    }

    // 宏名大小写不敏感（ST 用户大小写混写很常见）。先精确，再退小写。
    let fn = this.macros[name] ?? this.macros[name.toLowerCase()];
    // 也接受驼峰写法：{{getVar}} → getvar
    if (typeof fn !== "function" && /^[a-z]+[A-Z]/.test(name)) {
      const flat = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
      fn = this.macros[flat];
    }
    if (typeof fn !== "function") {
      undefinedMacros.push(name);
      return { resolved: false };
    }
    // 递归深度护栏：宏函数内部再调 self.process() 时，depth 会 +1。
    // 自引用宏（{{loop}} 展开成 {{loop}}）靠 MAX_PASSES 拦不住——
    // 每次内部 process 都是全新的 3 轮，会无限递归到爆栈。
    // 这里按调用栈深度硬拦。
    const nextDepth = (ctx.__macroDepth || 0) + 1;
    if (nextDepth > MACRO_RECURSION_LIMIT) {
      return { resolved: false, tooDeep: true };
    }
    try {
      const childCtx = Object.assign({}, ctx, { __macroDepth: nextDepth });
      const v = fn(childCtx, args, this);
      return { resolved: true, value: v == null ? "" : String(v) };
    } catch {
      return { resolved: false };
    }
  }

  /** process 返回纯文本（管线里常用的形式） */
  process(text, ctx = {}) {
    return this.parse(text, ctx).text;
  }

  /**
   * 对对象的指定字段做宏替换，返回新对象（不改原对象）。
   * 这是给角色卡用的：卡是数据，不能就地改。
   */
  processFields(obj, fields, ctx = {}) {
    if (!obj || typeof obj !== "object") return obj;
    const out = { ...obj };
    const allUndefined = [];
    for (const f of fields) {
      if (typeof out[f] === "string") {
        const r = this.parse(out[f], ctx);
        out[f] = r.text;
        allUndefined.push(...r.undefinedMacros);
      }
    }
    out.__macroUndefined = [...new Set(allUndefined)];
    return out;
  }
}

export function createMacroProcessor(macros) {
  return new MacroProcessor(macros);
}

/** 从角色卡与调用参数构建上下文 */
export function contextFromCharacter(character, opts = {}) {
  const name = character?.name ?? opts.characterName ?? "";
  return {
    userName: opts.userName ?? "User",
    characterName: name,
    persona: opts.persona ?? "",
    character: character || {},
    variables: opts.variables && typeof opts.variables === "object" ? opts.variables : {},
    globalVariables: opts.globalVariables && typeof opts.globalVariables === "object"
      ? opts.globalVariables : {},
    onVariableChange: typeof opts.onVariableChange === "function" ? opts.onVariableChange : null,
    __pendingChanges: {}
  };
}

/** 文本里是否含宏。给「要不要跑宏处理器」做快速判断，省掉无宏文本的开销。 */
export function hasMacros(text) {
  return typeof text === "string" && /\{\{[^}]*\}\}/.test(text);
}

/**
 * 列出文本里出现的宏名（去重、保序）。
 * 未定义的宏也列出来——调用方可据此提示用户「这个宏不存在」，
 * 而不是等它静静留在提示词里。
 */
export function usedMacros(text) {
  if (typeof text !== "string") return [];
  const names = [];
  const re = /\{\{\s*([A-Za-z_][\w:-]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].split("::")[0];
    if (!names.includes(name)) names.push(name);
  }
  return names;
}