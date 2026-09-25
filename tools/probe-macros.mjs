// tools/probe-macros.mjs —— 问宏引擎：setvar 的四种写法，哪几种真的认
//
// 直觉（"文件头写了三种都支持"）不算证据：这一步之前我已经两次读错宏的行为。

const { createMacroProcessor, contextFromCharacter } = await import("../lib/macros/index.js");

const cases = [
  "{{setvar::好感::7}}",
  "{{setvar 好感=7}}",
  "{{setvar::好感=7}}",
  "{{setvar 好感 7}}",
  "{{getvar::好感}}",
  "{{getvar 好感}}",
  "{{roll::1d6}}",
  "{{roll 1d6}}"
];

for (const src of cases) {
  const vars = {};
  const ctx = contextFromCharacter({ name: "薇拉" }, { variables: vars });
  const m = createMacroProcessor();
  const out = m.process(src, ctx);
  const pending = ctx.__pendingChanges || {};
  console.log(
    `${src.padEnd(24)} → ${JSON.stringify(out).padEnd(14)} vars=${JSON.stringify(vars)} pending=${JSON.stringify(pending)}`
  );
}

// 看看引擎自己认为"哪些宏名是注册过的"
const m = createMacroProcessor();
const names = typeof m.names === "function" ? m.names() : (m.macros ? [...m.macros.keys()] : null);
console.log("\n已注册的宏名：", names ? names.join(", ") : "(拿不到)");
