// test/regression-models-config.mjs — 模型按用途分选（Q3）
//
// 三层回退的语义钉在这里：
//   1. 单用途指定了模型 → 用它
//   2. 单用途「跟随默认」而全局默认有值 → 用全局默认
//   3. 全局默认没设 → null（交给 resolveTarget 走宿主目录）
//
// 加上三条验收：
//   · 正文用 A、变量更新用 B 可同时生效（两个用途各自独立）
//   · 改全局默认后，跟随的用途跟着变
//   · 手动模型不存在时不炸（resolveTarget 那侧的事；这里只验解析层不炸）

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  PURPOSES,
  PURPOSE_LABELS,
  emptyConfig,
  norm,
  readConfig,
  writeConfig,
  mergeConfig,
  resolveTargetFor,
  publicConfig,
  configPath
} = await import("../lib/models/config.js");

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 模型按用途分选 ===\n");

// ── 归一化 ────────────────────────────────────────────

ok("emptyConfig：五用途都在、默认全 null", () => {
  const c = emptyConfig();
  assert.equal(c.default, null);
  for (const p of PURPOSES) {
    assert.ok(c[p], `${p} 缺失`);
    assert.equal(c[p].mode, "default");
  }
});

ok("PURPOSES 顺序即 UI 顺序，标签齐全", () => {
  assert.deepEqual(PURPOSES, ["chat", "vars", "summary", "suggest", "embed"]);
  for (const p of PURPOSES) assert.ok(PURPOSE_LABELS[p], `${p} 没标签`);
});

ok("norm：坏条目归一为跟随默认", () => {
  const c = norm({
    default: { provider: "p" },            // 缺 model → 清成 null
    chat: { provider: "pp", model: "mm" }, // 正常
    summary: "随便写啥",                    // 非对象 → 跟随默认
    suggest: { provider: "", model: "" }   // 空串 → 跟随默认
  });
  assert.equal(c.default, null);
  assert.deepEqual(c.chat, { mode: "target", provider: "pp", model: "mm" });
  assert.equal(c.summary.mode, "default");
  assert.equal(c.suggest.mode, "default");
});

ok("norm：多键兜底只认 provider / model，别乱塞", () => {
  const c = norm({ default: { provider: "p", model: "m", providerId: "x", modelId: "y" } });
  assert.deepEqual(c.default, { provider: "p", model: "m" });
});

// ── 三层回退 ──────────────────────────────────────────

ok("回退 1：用途指定 → 用它，不看全局", () => {
  const c = {
    default: { provider: "g", model: "gg" },
    chat: { mode: "target", provider: "a", model: "aa" },
    vars: { mode: "default" }
  };
  assert.deepEqual(resolveTargetFor(c, "chat"), { provider: "a", model: "aa" });
});

ok("回退 2：用途跟随 + 全局有值 → 用全局", () => {
  const c = {
    default: { provider: "g", model: "gg" },
    summary: { mode: "default" }
  };
  assert.deepEqual(resolveTargetFor(c, "summary"), { provider: "g", model: "gg" });
});

ok("回退 3：用途跟随 + 全局空 → null（走宿主目录默认）", () => {
  const c = { default: null, suggest: { mode: "default" } };
  assert.equal(resolveTargetFor(c, "suggest"), null);
});

ok("未知的 purpose 一律回退到 chat（不炸，不返回 undefined）", () => {
  const c = { default: { provider: "p", model: "m" }, chat: { mode: "default" } };
  assert.deepEqual(resolveTargetFor(c, "not-a-purpose"), { provider: "p", model: "m" });
  assert.deepEqual(resolveTargetFor(null, "chat"), null);
});

// ── 三条验收 ──────────────────────────────────────────

ok("验收 1：正文 A、变量 B 可同时生效", () => {
  const c = {
    default: null,
    chat: { mode: "target", provider: "p", model: "A" },
    vars: { mode: "target", provider: "p", model: "B" },
    summary: { mode: "default" },
    suggest: { mode: "default" },
    embed: { mode: "default" }
  };
  assert.deepEqual(resolveTargetFor(c, "chat"), { provider: "p", model: "A" });
  assert.deepEqual(resolveTargetFor(c, "vars"), { provider: "p", model: "B" });
  assert.equal(resolveTargetFor(c, "summary"), null, "summary 跟随而全局空 → null");
});

ok("验收 2：改全局默认，跟随的用途跟着变", () => {
  const before = {
    default: { provider: "p", model: "OLD" },
    summary: { mode: "default" },
    suggest: { mode: "default" }
  };
  assert.deepEqual(resolveTargetFor(before, "summary"), { provider: "p", model: "OLD" });

  const after = mergeConfig(before, { default: { provider: "p", model: "NEW" } });
  assert.deepEqual(resolveTargetFor(after, "summary"), { provider: "p", model: "NEW" });
  assert.deepEqual(resolveTargetFor(after, "suggest"), { provider: "p", model: "NEW" });
});

ok("验收 3：手动指定的模型不存在时 resolveTargetFor 仍返回它（回退由 service 层做）", () => {
  // resolveTargetFor 只负责「按用途选出该用谁」，不知道目录长什么样。
  // 指定的模型即使不在目录里，它也照样返回 —— 让 resolveTarget 去回退。
  // 这正是分工的关键：配置层不校验，服务层兜底。
  const c = {
    default: null,
    chat: { mode: "target", provider: "ghost", model: "not-there" }
  };
  assert.deepEqual(resolveTargetFor(c, "chat"), { provider: "ghost", model: "not-there" });
});

// ── mergeConfig ───────────────────────────────────────

ok("mergeConfig：缺字段 = 不改", () => {
  const prev = {
    default: { provider: "p", model: "m" },
    chat: { mode: "target", provider: "a", model: "aa" },
    summary: { mode: "default" }
  };
  const next = mergeConfig(prev, { suggest: "default" });
  assert.deepEqual(next.default, { provider: "p", model: "m" });
  assert.deepEqual(next.chat, { mode: "target", provider: "a", model: "aa" });
  assert.equal(next.summary.mode, "default");
  assert.equal(next.suggest.mode, "default");
});

ok("mergeConfig：default:null 是显式清空（不是「没改」）", () => {
  const prev = { default: { provider: "p", model: "m" } };
  assert.equal(mergeConfig(prev, { default: null }).default, null);
  // 对照：不出现 default 字段就是不改
  assert.deepEqual(
    mergeConfig(prev, {}).default,
    { provider: "p", model: "m" }
  );
});

ok("mergeConfig：用途传字符串 'default' 与对象两种都认", () => {
  const p1 = mergeConfig({ chat: { mode: "target", provider: "x", model: "y" } }, { chat: "default" });
  assert.equal(p1.chat.mode, "default");
  const p2 = mergeConfig({}, { chat: { mode: "target", provider: "x", model: "y" } });
  assert.deepEqual(p2.chat, { mode: "target", provider: "x", model: "y" });
  // 直接传 {provider,model}（不带 mode）也算 target
  const p3 = mergeConfig({}, { chat: { provider: "x", model: "y" } });
  assert.deepEqual(p3.chat, { mode: "target", provider: "x", model: "y" });
});

// ── publicConfig 形状 ─────────────────────────────────

ok("publicConfig：每用途带上 effectiveTarget", () => {
  const c = {
    default: { provider: "p", model: "g" },
    chat: { mode: "target", provider: "x", model: "xx" },
    summary: { mode: "default" }
  };
  const pub = publicConfig(c);
  assert.equal(pub.purposes.length, PURPOSES.length);
  const chat = pub.purposes.find(p => p.id === "chat");
  const sum = pub.purposes.find(p => p.id === "summary");
  assert.equal(chat.mode, "target");
  assert.deepEqual(chat.effectiveTarget, { provider: "x", model: "xx" });
  assert.equal(sum.mode, "default");
  assert.deepEqual(sum.effectiveTarget, { provider: "p", model: "g" });
});

// ── 落盘 ─────────────────────────────────────────────

await okAsync("read/write：写进去再读出来形状不变", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-models-"));
  try {
    await writeConfig(tmp, {
      default: { provider: "p", model: "m" },
      chat: { mode: "target", provider: "a", model: "aa" }
    });
    assert.ok(fs.existsSync(configPath(tmp)), "文件没落盘");
    const r = await readConfig(tmp);
    assert.deepEqual(r.default, { provider: "p", model: "m" });
    assert.deepEqual(r.chat, { mode: "target", provider: "a", model: "aa" });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await okAsync("readConfig：文件不存在时返回空配置（不炸）", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-models-"));
  try {
    const r = await readConfig(tmp);
    assert.equal(r.default, null);
    assert.equal(r.chat.mode, "default");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
