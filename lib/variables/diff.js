// lib/variables/diff.js — 变量变化的「账」
//
// 两个原则：
//
//   1. **账从状态长出来，不从自报里长出来。**
//      宏引擎会通过 onVariableChange 告诉我们「我改了谁」，但那个回调是触发器，
//      不是事实——它可能漏、可能被绕过、可能有人改完又改回去。
//      真正算数的是「这一轮前后，值到底变没变」。
//
//   2. **值一律按字符串比。**
//      `7` 与 `"7"` 不该显示成一笔改动：宏写回来的一定是字符串，玩家手输的是数字，
//      同一个值在两条路上类型不同，把它报成「好感 7 → 7」是纯噪音。

/** 归一成一份可比的快照。 */
export function snapshotVars(vars) {
  const out = {};
  if (!vars || typeof vars !== "object") return out;
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) continue;
    out[k] = v === null ? "" : String(v);
  }
  return out;
}

/**
 * 前后快照的差。
 * 返回 [{ name, change: "add" | "set" | "remove", from, to }]，**按名字排序**——
 * 顺序稳定才好断言、也才不会因为键序抖动让同一件事看起来变了两次。
 */
export function diffVars(before, after) {
  const b = snapshotVars(before);
  const a = snapshotVars(after);
  const names = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
  const out = [];
  for (const name of names) {
    const hadB = Object.prototype.hasOwnProperty.call(b, name);
    const hadA = Object.prototype.hasOwnProperty.call(a, name);
    if (!hadB && hadA) out.push({ name, change: "add", from: null, to: a[name] });
    else if (hadB && !hadA) out.push({ name, change: "remove", from: b[name], to: null });
    else if (b[name] !== a[name]) out.push({ name, change: "set", from: b[name], to: a[name] });
  }
  return out;
}

/**
 * 人读的一行：`好感 3 → 4`、`势力 → 5`（新增）、`旧线索 已移除（原 …）`。
 * 长值截断——一条几百字的变量不该把整行版式撑破。
 */
export function describeVarDiff(d) {
  const clip = (s) => {
    const t = String(s ?? "");
    return t.length > 24 ? `${t.slice(0, 24)}…` : t;
  };
  if (!d || !d.name) return "";
  if (d.change === "add") return `${d.name} → ${clip(d.to)}`;
  if (d.change === "remove") return `${d.name} 已移除（原 ${clip(d.from)}）`;
  return `${d.name} ${clip(d.from)} → ${clip(d.to)}`;
}
