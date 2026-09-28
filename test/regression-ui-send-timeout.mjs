// test/regression-ui-send-timeout.mjs — 发送这条路的两把尺子，别再量错
//
// 为什么需要它：2026-09-27 19:49 截图里那句「发送失败: 请求失败
// conversations/<id>/messages: 请求超时」，真凶不在模型，在这里——
//
//   1. 流式通道已经建立、模型跑了一半才出错时，前端 `return null`
//      静默降级。真错只进 console，用户看不到。
//   2. 降级走的是**同步生成**（一次响应等整段回复），却套着 apiFetch
//      给本地回环定的 10 秒超时。模型还没开口，前端先判了死刑。
//
// 两个错叠在一起，屏幕上只剩「请求超时」四个字——而它指向的
// 是第二条，跟真正的故障没关系。
//
// 这个文件钉住的四件事：
//   - 超时可以被调用方声明，默认值不再是一把全局尺子
//   - 生成阶段的错原样抛到界面，不再被降级吞掉
//   - 「通道没建起来」和「生成断掉」走不同的分支
//   - 同步生成那条显式给了长超时
//
// 判据故意只看源码里的**结构**，不看文案：文案会改，结构才是承诺。

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");

// 抹掉注释（保持行结构与行号），否则注释里提到的旧写法会被当成真代码。
// 字符串内容留着——路径和事件名就在里面。
function blankComments(src) {
  const out = [...src];
  let i = 0, inTpl = false, inS = null;
  while (i < src.length) {
    const ch = src[i], nx = src[i + 1];
    if (inS) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === inS) inS = null;
      i++; continue;
    }
    if (inTpl) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === "`") inTpl = false;
      i++; continue;
    }
    if (ch === "`") { inTpl = true; i++; continue; }
    if (ch === '"' || ch === "'") { inS = ch; i++; continue; }
    if (ch === "/" && nx === "/") {
      while (i < src.length && src[i] !== "\n") { out[i] = " "; i++; }
      continue;
    }
    if (ch === "/" && nx === "*") {
      out[i] = " "; out[i + 1] = " "; i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < src.length) { out[i] = " "; out[i + 1] = " "; i += 2; }
      continue;
    }
    i++;
  }
  return out.join("");
}

const core = blankComments(read("ui/assets/modules/core.js"));
const chat = blankComments(read("ui/assets/modules/chat.js"));

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log("  ✅ " + name); pass++; }
  catch (e) { console.log("  ❌ " + name + "\n      " + (e?.message || e)); fail++; }
}
const has = (src, needle) => assert.ok(src.includes(needle), "缺：" + needle);
const lacks = (src, needle) => assert.ok(!src.includes(needle), "不该再有：" + needle);

console.log("\n=== 发送链路的超时语义 ===\n");

check("apiFetch 的默认超时仍是一条常量，可被调用方覆盖", () => {
  has(core, "const FETCH_TIMEOUT_MS = 10_000;");
  has(core, "const { timeoutMs = FETCH_TIMEOUT_MS, ...fetchOptions } = options;");
});

check("自定义字段不透传给宿主 fetch（timeoutMs 不是请求头）", () => {
  has(core, "fetchFn(candidate, fetchOptions)");
  lacks(core, "fetchFn(candidate, options)");
});

check("超时文案带秒数——「请求超时」单独四个字没法定责", () => {
  has(core, "请求超时（超过 ");
  has(core, "Math.round(timeoutMs / 1000)");
});

check("流式 error 事件抛错，不再 return null 静默降级", () => {
  has(chat, "err.fromStream = true;");
  const i = chat.indexOf("err.fromStream = true;");
  assert.ok(i > 0 && chat.slice(i, i + 80).includes("throw err;"), "标记之后必须真的抛出去");
  // 旧写法：error 分支里直接 return null
  const bad = chat.indexOf('console.error("Stream error:"');
  if (bad >= 0) {
    assert.ok(!/return null/.test(chat.slice(bad, bad + 400)), "error 分支里还有 return null");
  }
});

check("流式外层 catch 放行生成阶段的错，只兜「通道没建起来」", () => {
  has(chat, "if (e?.fromStream) throw e;");
});

check("降级分支的判据是「返回 null」＝通道没起来", () => {
  has(chat, "if (streamRes && !streamRes.content) {");
  has(chat, "} else if (streamRes && streamRes.content) {");
});

check("同步生成那条显式给了长超时", () => {
  const i = chat.indexOf("conversations/${state.currentConv.id}/messages`");
  assert.ok(i > 0, "找不到降级调用点");
  const seg = chat.slice(i, i + 400);
  has(seg, "timeoutMs: 180_000,");
});

console.log("\n通过 " + pass + " / 失败 " + fail + "\n");
if (fail > 0) process.exit(1);
