// test/macros-selftest.mjs — 宏引擎自检（恢复期临时，正式测试替换后删）
import { createMacroProcessor, contextFromCharacter } from "../lib/macros/index.js";

const m = createMacroProcessor();
const ctx = contextFromCharacter({ name: "末日后旅馆" }, { userName: "月曦夜" });
let pass = 0, fail = 0;
function chk(label, got, want) {
  const ok = got === want;
  if (ok) pass++; else { fail++; console.log(`  ✗ ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
}

chk("char", m.process("{{char}}", ctx), "末日后旅馆");
chk("user", m.process("{{user}}", ctx), "月曦夜");
chk("混合", m.process("{{char}} 对 {{user}}", ctx), "末日后旅馆 对 月曦夜");
chk("未定义保留", m.process("{{nope}}", ctx), "{{nope}}");
chk("getvar", m.process("{{getvar::mood}}", ctx), "");
ctx.variables.mood = "低落";
chk("getvar 有值", m.process("{{getvar::mood}}", ctx), "低落");
chk("setvar 入队", m.process("{{setvar x=1}}z", ctx), "z");
chk("setvar pending", ctx.__pendingChanges.x, "1");
chk("random 池内", ["a", "b", "c"].includes(m.process("{{random a,b,c}}", ctx)), true);
chk("date 非空", m.process("{{date}}", ctx).length > 0, true);
chk("newline", m.process("a{{newline}}b", ctx), "a\nb");
chk("16层命中", m.parse("{{".repeat(16) + "a" + "}}".repeat(16), ctx).depthLimitHit, true);
chk("8层放行", m.parse("{{".repeat(8) + "a" + "}}".repeat(8), ctx).depthLimitHit, false);

// 自引用宏：不得无限递归
m.register("loop", (c, args, self) => self.process("{{loop}}", c));
const looped = m.parse("x{{loop}}y", ctx);
chk("自引用不炸", typeof looped.text === "string", true);
chk("自引报告", looped.depthLimitHit, true);

// processFields 只改指定字段
const card = m.processFields(
  { description: "{{char}}", personality: "p", first_mes: "{{user}}", captain: "{{char}}" },
  ["description", "personality", "first_mes"],
  ctx
);
chk("pf description", card.description, "末日后旅馆");
chk("pf personality", card.personality, "p");
chk("pf first_mes", card.first_mes, "月曦夜");
chk("pf 未列字段不动", card.captain, "{{char}}");
chk("pf 不改原对象", ctx.character.description, undefined);

console.log(`\n宏引擎: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
