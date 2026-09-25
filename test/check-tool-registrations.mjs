// test/check-tool-registrations.mjs
//
// 为什么需要这个文件：
//   2026-09-25 的事故——`lib/media/tool.js` 与 `lib/gen/tool.js` 的注册对象
//   **两个键名都写错了**，而全套 68 个测试文件全绿：
//
//     1. `execute` 写成了 `handler`
//        → 宿主 `registration.execute === undefined`
//        → `toolExecutors.set(handleId, undefined)` → 调用时取出来是空的
//        → 报 `no tool executor for hXX`。
//        表现：工具在目录里**列得出来**，一调就死。
//     2. `parameters` 写成了 `inputSchema`
//        → 宿主兵底成 `{ type:"object", properties:{} }` → 参数对模型不可见。
//        这个连报错都没有，最安静。
//
//   旧测试为什么绿：它们全都直接调 `handler(...)` / `execute(...)` 那个函数本身，
//   从没走"宿主认不认这个注册对象"这一层。绿得没有意义——就是那种绿。
//
// 所以这里查的是**契约**（对的是同仓 `lib/probe/tools.js`、`lib/embed/tool.js`
// 那份活得好好的形状），不是行为。检查器自带反证：改坏必须立刻红。

import assert from "node:assert/strict";

// 宿主真正读的两个键（见 app-host-entry.js 的 tools.register 与 ToolsRegister）
const EXEC_KEY = "execute";
const PARAM_KEY = "parameters";
// 看着像、其实没人读的键——写错一次就会踩上面那两个坑
const SUSPECT_KEYS = ["handler", "inputSchema", "schema", "args"];

// ── 一个什么都能点、点了都给函数的替身 ──
// 工具工厂在 build 期只会"存"依赖（真调用发生在 execute 里），
// 这些对象不需要真行为，只要不炸。
const anyProxy = new Proxy(function () {}, {
  get: (_t, k) => (k === "then" ? undefined : anyProxy),
  apply: () => anyProxy
});
const stub = () => anyProxy;

// ── 载入所有工具工厂（与 index.js 的注册清单一一对应）──
const { createCharacterTools, createConversationTools, createVariableTools, createSettingTools } =
  await import("../lib/probe/tools.js");
const { createEmbedTools } = await import("../lib/embed/tool.js");
const { createGenTools } = await import("../lib/gen/tool.js");
const { createMediaTools } = await import("../lib/media/tool.js");

const groups = [
  ["characters", () => createCharacterTools(stub())],
  ["conversations", () => createConversationTools({
    conversationRepo: stub(), characterRepo: stub(), settingRepo: stub(),
    llmService: stub(), regexRepo: stub(), boardRepo: stub()
  })],
  ["variables", () => createVariableTools({ variableRepo: stub(), conversationRepo: stub() })],
  ["settings", () => createSettingTools({ settingRepo: stub(), conversationRepo: stub() })],
  ["embed", () => createEmbedTools({ sdk: stub(), dataDir: process.cwd() })],
  ["gen", () => createGenTools({ llm: stub() })],
  ["media", () => createMediaTools({ characterRepo: stub(), transfer: stub(), sdk: stub() })]
];

const fail = [];
let checked = 0;

// ── 判据：一个注册对象有什么毛病（纯函数，反证要用）──
function problemsOf(t, seenNames) {
  const out = [];
  const o = t || {};
  const tag = typeof o.name === "string" && o.name ? o.name : "(无名)";

  if (typeof o[EXEC_KEY] !== "function") {
    out.push(`${tag}: 缺 ${EXEC_KEY}（宿主拿到 undefined 执行器 → 调不动）`);
  }
  if (!o[PARAM_KEY] || typeof o[PARAM_KEY] !== "object" || o[PARAM_KEY].type !== "object" || !o[PARAM_KEY].properties) {
    out.push(`${tag}: ${PARAM_KEY} 不合规（要 type:"object" 且带 properties）`);
  }
  for (const k of SUSPECT_KEYS) {
    if (k in o) out.push(`${tag}: 有 ${k} 键——宿主不读它，八成是把 ${k === "handler" ? EXEC_KEY : PARAM_KEY} 写错了`);
  }
  if (typeof o.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(o.name)) {
    out.push(`${tag}: name 不合规（小写字母开头、只含小写字母数字下划线）`);
  } else if (seenNames.has(o.name)) {
    out.push(`${tag}: 名字重复`);
  }
  // 阈值只用来拦“空描述 / 一个字”，不评长短：中文七个字和英文七个词不是一个量级
  if (typeof o.description !== "string" || o.description.trim().length < 4) {
    out.push(`${tag}: description 缺失或过短`);
  }
  return out;
}

// ── 逐组检查 ──
const seen = new Set();
const counts = [];

for (const [label, build] of groups) {
  let tools;
  try {
    tools = build();
  } catch (e) {
    fail.push(`组 ${label} 建不起来：${e?.message || e}`);
    continue;
  }
  assert.ok(Array.isArray(tools), `组 ${label} 应返回数组`);
  if (tools.length === 0) fail.push(`组 ${label} 一个工具都没有`);

  for (const t of tools) {
    const probs = problemsOf(t, seen);
    if (probs.length) fail.push(...probs.map((p) => `[${label}] ${p}`));
    if (t?.name) seen.add(t.name);
    checked++;
  }
  counts.push(`${label}=${tools.length}`);
}

// 与 index.js 的注册清单对得上：15 个（含 lib/probe/state.js 里那个探针工具）
if (checked + 1 !== 15) {
  fail.push(`工具总数对不上：这里查到 ${checked} 个 + 探针 1 个 = ${checked + 1}，实际常态是 15 个——查少了说明有工厂没被覆盖到`);
}

// ── 反证：正确对象故意改坏，检查器必须报出来 ──
{
  const good = {
    name: "ok_tool",
    description: "这是一个足够长的描述",
    parameters: { type: "object", properties: {} },
    execute: () => {}
  };
  assert.deepEqual(problemsOf(good, new Set()), [], "反证①：正确的对象被判有问题");

  const wrongExec = { ...good, handler: () => {} };
  delete wrongExec.execute;
  const p1 = problemsOf(wrongExec, new Set());
  assert.ok(p1.some((x) => /缺 execute/.test(x)), "反证②：execute 写成 handler 没报出来");

  const wrongParam = { ...good, parameters: undefined, inputSchema: { type: "object", properties: {} } };
  const p2 = problemsOf(wrongParam, new Set());
  assert.ok(p2.some((x) => /parameters 不合规/.test(x)), "反证③：parameters 写成 inputSchema 没报出来");

  assert.ok(problemsOf({ ...good, description: "x" }, new Set()).length >= 1, "反证④：描述缺失没报");
  assert.ok(problemsOf(good, new Set(["ok_tool"])).some((x) => /重复/.test(x)), "反证⑤：重名没报");

  console.log("  反证五条：改坏就红 ✓");
}

// ── 结论 ──
console.log(`  分组：${counts.join("  ")}`);

if (fail.length) {
  console.error("");
  for (const f of fail) console.error("  ❌ " + f);
  console.error(`\n❌ 工具注册契约：${fail.length} 条不合规（共查 ${checked + 1} 个工具）`);
  process.exit(1);
}

console.log(`✅ 工具注册契约：${checked + 1} 个工具全合规（execute / parameters / name / description）`);
