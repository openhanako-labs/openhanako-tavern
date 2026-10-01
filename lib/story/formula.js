// lib/story/formula.js — 公式求值器（cwv1 效果结算的可选表达式层）
//
// 为什么自己写、不用 eval：
//   eval 会把任意 JS 跑在进程里——一个提示词注入（"帮我算一下 process.exit()"）
//   就能把会话端了。求值器只需要支持**算术 + 变量 + 骰子 + 少量函数**，
//   那就写一个真正的 tokenizer + Pratt parser，让语法之外的字符直接报错。
//
// 支持的语法（cwv1 的公式子集）：
//   数字        10  0.5  -3
//   变量        {体力}  {薇拉.好感度}  {敌人.防御}
//   算术        + - * / （左结合，* / 优先）
//   括号        ( {灵力} + 1 ) * 2
//   比较        {敏捷} >= 12   →  1 / 0
//   函数        max(a,b)  min(a,b)  floor(x)  ceil(x)  abs(x)
//   骰子        d20  2d6  d6+3  1d8-1
//
// 变量解析：{name} → 查 conv.variables[name]；层级名（a.b）按整键查，
//   查不到按 0 起（与 effectsToPatch 的纪律一致）。
//
// 返回值：数字。解析/求值失败抛 FormulaError（带位置信息），
//   上层（effects.js）catch 后回退为「整行照原文 set」。

export class FormulaError extends Error {
  constructor(msg, pos) {
    super(pos != null ? `${msg}（位置 ${pos}）` : msg);
    this.name = "FormulaError";
    this.pos = pos ?? null;
  }
}

// ── Tokenizer ──────────────────────────────────────────

const TOKEN = {
  NUM: "num",
  VAR: "var",
  OP: "op",
  LPAREN: "lparen",
  RPAREN: "rparen",
  COMMA: "comma",
  DICE: "dice",
  IDENT: "ident"
};

const OPS = new Set(["+", "-", "*", "/", "(", ")", ",", ">=", "<=", ">", "<", "==", "!="]);

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  const isDigit = (ch) => ch >= "0" && ch <= "9";
  const isVarStart = (ch) => /[A-Za-z_一-龥]/.test(ch);

  while (i < n) {
    const ch = src[i];
    if (ch === " " || ch === "\t") { i++; continue; }

    // 变量 {name} / {name.with.dots}
    if (ch === "{") {
      const j = src.indexOf("}", i);
      if (j === -1) throw new FormulaError("变量括号未闭合", i);
      const name = src.slice(i + 1, j).trim();
      if (!name) throw new FormulaError("空变量名", i);
      tokens.push({ t: TOKEN.VAR, v: name, pos: i });
      i = j + 1;
      continue;
    }

    // 骰子 d20 / 2d6 / d6+3 —— 必须在数字匹配之前试，
    // 否则「2d6」的 2 会先被 NUM 吃掉，剩下 d6 变成「表达式后面还有内容」。
    const diceM = src.slice(i).match(/^(\d*)d(\d+)([+-]\d+)?/i);
    if (diceM) {
      const count = diceM[1] === "" ? 1 : parseInt(diceM[1], 10);
      const sides = parseInt(diceM[2], 10);
      const mod = diceM[3] ? parseInt(diceM[3], 10) : 0;
      tokens.push({ t: TOKEN.DICE, v: { count, sides, mod }, pos: i });
      i += diceM[0].length;
      continue;
    }

    // 数字（含小数）
    if (isDigit(ch) || (ch === "." && isDigit(src[i + 1]))) {
      let j = i;
      while (j < n && (isDigit(src[j]) || src[j] === ".")) j++;
      const num = Number(src.slice(i, j));
      if (!Number.isFinite(num)) throw new FormulaError("非法数字", i);
      tokens.push({ t: TOKEN.NUM, v: num, pos: i });
      i = j;
      continue;
    }

    // 运算符（两字符优先）
    const two = src.slice(i, i + 2);
    if (OPS.has(two)) {
      tokens.push({ t: TOKEN.OP, v: two, pos: i });
      i += 2;
      continue;
    }
    if (OPS.has(ch)) {
      tokens.push({ t: TOKEN.OP, v: ch, pos: i });
      i++;
      continue;
    }

    // 函数名 max / min / floor / ceil / abs
    const identM = src.slice(i).match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
    if (identM) {
      tokens.push({ t: TOKEN.IDENT, v: identM[0], pos: i });
      i += identM[0].length;
      continue;
    }

    throw new FormulaError(`不认识的字符「${ch}」`, i);
  }

  tokens.push({ t: "eof", v: null, pos: n });
  return tokens;
}

// ── Pratt parser（优先级爬升）─────────────────────────────

const PRECEDENCE = {
  "==": 1, "!=": 1,
  ">": 2, "<": 2, ">=": 2, "<=": 2,
  "+": 3, "-": 3,
  "*": 4, "/": 4
};

const FUNCTIONS = {
  max: (...xs) => Math.max(...xs),
  min: (...xs) => Math.min(...xs),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  abs: (x) => Math.abs(x)
};

export function parseFormula(src, variables = {}) {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];
  const expect = (t, v) => {
    const tok = consume();
    if (tok.t !== t || (v !== undefined && tok.v !== v)) {
      throw new FormulaError(`期望 ${v ?? t}，得到 ${tok.t}「${tok.v ?? ""}」`, tok.pos);
    }
    return tok;
  };

  const vars = variables || {};

  // 主表达式：比较级
  function parseExpr() {
    let left = parseAddSub();
    while (peek().t === TOKEN.OP && PRECEDENCE[peek().v] <= 2) {
      const op = consume().v;
      const right = parseAddSub();
      const a = toNum(left), b = toNum(right);
      left = op === ">=" ? (a >= b ? 1 : 0)
        : op === "<=" ? (a <= b ? 1 : 0)
        : op === ">" ? (a > b ? 1 : 0)
        : op === "<" ? (a < b ? 1 : 0)
        : op === "==" ? (a === b ? 1 : 0)
        : (a !== b ? 1 : 0);
    }
    return left;
  }

  function parseAddSub() {
    let left = parseMulDiv();
    while (peek().t === TOKEN.OP && (peek().v === "+" || peek().v === "-")) {
      const op = consume().v;
      const right = parseMulDiv();
      left = op === "+" ? toNum(left) + toNum(right) : toNum(left) - toNum(right);
    }
    return left;
  }

  function parseMulDiv() {
    let left = parseUnary();
    while (peek().t === TOKEN.OP && (peek().v === "*" || peek().v === "/")) {
      const op = consume().v;
      const right = parseUnary();
      const a = toNum(left), b = toNum(right);
      left = op === "*" ? a * b : b === 0 ? (() => { throw new FormulaError("除数为 0"); })() : a / b;
    }
    return left;
  }

  function parseUnary() {
    if (peek().t === TOKEN.OP && peek().v === "-") {
      consume();
      return -toNum(parseUnary());
    }
    if (peek().t === TOKEN.OP && peek().v === "+") {
      consume();
      return toNum(parseUnary());
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const tok = peek();

    if (tok.t === TOKEN.NUM) { consume(); return tok.v; }

    if (tok.t === TOKEN.VAR) {
      consume();
      const raw = vars[tok.v];
      const num = Number(raw ?? 0);
      return Number.isFinite(num) ? num : 0;
    }

    if (tok.t === TOKEN.DICE) {
      consume();
      const { count, sides, mod } = tok.v;
      let total = 0;
      for (let i = 0; i < count; i++) total += Math.floor(Math.random() * sides) + 1;
      return total + mod;
    }

    if (tok.t === TOKEN.IDENT) {
      const name = consume().v;
      expect(TOKEN.OP, "(");
      const args = [];
      if (peek().v !== ")") {
        args.push(parseExpr());
        while (peek().v === ",") { consume(); args.push(parseExpr()); }
      }
      expect(TOKEN.OP, ")");
      const fn = FUNCTIONS[name];
      if (!fn) throw new FormulaError(`未知函数「${name}」`, tok.pos);
      return fn(...args);
    }

    if (tok.v === "(") {
      consume();
      const v = parseExpr();
      expect(TOKEN.OP, ")");
      return v;
    }

    throw new FormulaError(`意外的 ${tok.t}「${tok.v ?? ""}」`, tok.pos);
  }

  const value = parseExpr();
  if (peek().t !== "eof") {
    throw new FormulaError(`表达式后面还有内容「${peek().v ?? peek().t}」`, peek().pos);
  }
  return toNum(value);
}

function toNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new FormulaError(`无法转成数字：${v}`);
  return n;
}

// ── 给效果结算用的便捷入口 ──────────────────────────────

/**
 * 求值一段公式文本。
 * @param {string} src
 * @param {object} variables  conv.variables 快照
 * @returns {number}
 * @throws {FormulaError}
 */
export function evalFormula(src, variables = {}) {
  return parseFormula(String(src ?? "").trim(), variables);
}

/**
 * 判值里有没有公式标记——决定要不要走求值器。
 * 纯数字（"10"、"-3"、"0.5"）不走；含 {变量} / d骰子 / 函数 / 运算符的走。
 * @param {string} raw
 * @returns {boolean}
 */
export function isFormula(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return false;
  // 纯数字：不是公式
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return false;
  // 有变量/骰子/函数/运算符的才是
  return /\{[^}]+\}/.test(s) || /\d*d\d+/i.test(s) || /[+\-*/()]/.test(s) || /\b(max|min|floor|ceil|abs)\b/.test(s);
}

export default { evalFormula, isFormula, FormulaError };
