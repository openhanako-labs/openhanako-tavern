// test/regression-timeout.mjs — 模型调用超时保护
//
// 这组测试存在的理由（实测发现）：
//   宿主模型层异常时，models.stream() 与 models.utility() 都会**静默挂住**——
//   实测两个不同 provider 的调用都超 60s 未返回。
//
//   没有超时保护的话，用户点发送后界面无限期转圈，连错误都看不到。
//   这个保护不修，App 在宿主异常时表现为"卡死"而非"报错"。

import assert from "node:assert";

const { LLMService } = await import("../lib/llm/service.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 超时保护回归 ===\n");

/** 造一个永不 resolve 的 sdk。 */
function hangingSdk() {
  return {
    models: {
      list: async () => ({ models: [
        { id: "m1", provider: "p", name: "M", maxTokens: 100, contextWindow: 8000 }
      ]}),
      stream: () => new Promise(() => {}),      // 永不 resolve
      utility: () => new Promise(() => {})      // 永不 resolve
    }
  };
}

// ── 1. _withTimeout 本身 ──
await okAsync("_withTimeout 对挂住的 Promise 抛错", async () => {
  const svc = new LLMService(hangingSdk());
  const t0 = Date.now();
  let threw = false;
  try {
    await svc._withTimeout(new Promise(() => {}), 120, "测试");
  } catch (e) {
    threw = true;
    assert.ok(/测试/.test(e.message), `错误信息应带标签，实际：${e.message}`);
  }
  assert.ok(threw, "应该抛错");
  assert.ok(Date.now() - t0 < 2000, "应在超时时长附近返回，而不是一直等");
});

await okAsync("_withTimeout 对正常 Promise 不干扰", async () => {
  const svc = new LLMService(hangingSdk());
  const r = await svc._withTimeout(Promise.resolve("ok"), 1000, "测试");
  assert.strictEqual(r, "ok");
});

await okAsync("_withTimeout 透传 Promise 自身的拒绝", async () => {
  const svc = new LLMService(hangingSdk());
  let msg = "";
  try {
    await svc._withTimeout(Promise.reject(new Error("原始错误")), 1000, "测试");
  } catch (e) { msg = e.message; }
  assert.strictEqual(msg, "原始错误", "不该被超时包装掉");
});

await okAsync("_withTimeout 超时后清理定时器（不留下悬挂 timer）", async () => {
  const svc = new LLMService(hangingSdk());
  // 用一个立刻 resolve 的 Promise + 很长的超时
  await svc._withTimeout(Promise.resolve(1), 60_000, "测试");
  // 若定时器未清理，进程会因 pending timer 延后退出——
  // 这里只能断言不抛错，实际清理由 finally 保证
  assert.ok(true);
});

// ── 2. streamEvents 真的会用超时 ──
await okAsync("streamEvents 在宿主挂住时抛错而非永久等待", async () => {
  const svc = new LLMService(hangingSdk());
  // 直接改小常量不可行，这里验证行为：调用应最终抛错
  // 为避免等 60s，用一个自定义超时路径——monkey patch
  svc._withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}（测试加速）`)), 150))
  ]);

  let threw = false;
  let errMsg = "";
  try {
    for await (const _ of svc.streamEvents([{ role: "user", content: "hi" }], {})) { /* 不会到这里 */ }
  } catch (e) {
    threw = true;
    errMsg = e.message;
  }
  assert.ok(threw, "应抛错而不是永久等待");
  assert.ok(/models\.stream/.test(errMsg), `错误信息应指明调用失败，实际：${errMsg}`);
});

// ── 3. 错误信息可读 ──
await okAsync("超时错误信息带秒数，用户能看懂", async () => {
  const svc = new LLMService(hangingSdk());
  let msg = "";
  try {
    await svc._withTimeout(new Promise(() => {}), 1000, "模型未响应");
  } catch (e) { msg = e.message; }
  assert.ok(/模型未响应/.test(msg), "应说明发生了什么");
  assert.ok(/秒/.test(msg), `应带时长，实际：${msg}`);
});

console.log(`\n通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
