// lib/probe/cache-probe.js — 一次性真实调用验证（验证后删除）
//
// 为什么需要它：
//   静态测试能证明「签名按预期带上/不带」，但不能证明
//   「provider 真的会因此命中缓存」。
//
//   复核明确要求：跑一次真实链路，看 usage 里到底有没有 cacheRead。
//
// 触发方式：dataDir 下存在 cache-probe.json 时执行，结果落 cache-probe-result.json。
// 跑完自己删触发文件，避免每次加载都调模型。

import fs from "node:fs";
import path from "node:path";

export async function runCacheProbe(dataDir, llmService) {
  if (!dataDir) return;

  const trigger = path.join(dataDir, "cache-probe.json");
  if (!fs.existsSync(trigger)) return;

  const out = path.join(dataDir, "cache-probe-result.json");
  const result = { at: new Date().toISOString(), steps: [] };

  const write = () => {
    try {
      fs.writeFileSync(out, JSON.stringify(result, null, 2), "utf8");
    } catch { /* 写不了就算了 */ }
  };

  // 先写一条「我醒了」——如果后面卡住，至少知道它启动过
  result.stage = "started";
  write();

  try {
    // 立刻删触发文件——避免重复跑
    fs.rmSync(trigger, { force: true });
    result.stage = "trigger consumed";
    write();

    if (!llmService?.streamAvailable) {
      result.stage = "no stream";
      write();
      return;
    }

    const target = await llmService.resolveTarget(null);
    result.target = target;
    result.stage = "target resolved";

    // 把目录也记下来——超时时能看出是模型本身的问题还是链路问题
    try {
      const models = await llmService.listModels(true);
      result.catalog = models.map(m => ({
        id: m.id, provider: m.provider, name: m.name,
        maxTokens: m.maxTokens, contextWindow: m.contextWindow
      }));
    } catch { /* 目录拿不到就算了 */ }
    write();

    // 如果只要目录，写完就退出
    if (fs.existsSync(path.join(dataDir, "cache-probe-catalog-only.json"))) {
      fs.rmSync(path.join(dataDir, "cache-probe-catalog-only.json"), { force: true });
      result.stage = "catalog only";
      write();
      return;
    }

    // 一段足够长的 systemPrompt，让前缀缓存有东西可缓存
    const systemPrompt = [
      "你是一个测试助手。",
      "规则一：回答必须简短。",
      "规则二：每句话末尾加一个句号。",
      "规则三：不要使用任何 Markdown 语法。",
      "规则四：不要提问，只陈述。",
      "规则四说明：这是为了制造足够长的稳定前缀，让缓存有意义。",
      "背景设定：北境有七座哨塔，守夜人靠体温维持结界，霜语一族能看见裂痕。",
      "背景设定续：第七塔是最北的一座，也是最冷的一座，常年风雪。",
      "背景设定续：守夜人的任期是七年，期满可以离开，但多数人不会离开。"
    ].join("\n");

    const mkMessages = (userText) => [{ role: "user", content: userText }];

    // 给调用加超时——否则卡住时探针就永远停在中间，
    // 结果文件停在某个 stage，看不出是慢还是死。
    const withTimeout = (p, ms, label) => Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时 ${ms}ms`)), ms))
    ]);

    // ── 第一轮：建立前缀 ──
    result.stage = "round 1 calling";
    write();

    // 允许用触发文件指定模型，便于逐个试
    let wantTarget = null;
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, "cache-probe-target.json"), "utf8"));
      if (cfg?.provider && cfg?.model) wantTarget = cfg;
    } catch { /* 没配置就用默认 */ }
    if (wantTarget) {
      result.target = wantTarget;
      result.stage = "using configured target";
      write();
    }

    const r1 = await withTimeout(
      llmService.generate(mkMessages("说一句话。"), {
        systemPrompt, maxTokens: 60, temperature: 0, target: wantTarget
      }),
      60000, "round1"
    );
    result.steps.push({
      round: 1,
      usage: r1.usage,
      content: String(r1.content || "").slice(0, 120),
      hasRawContent: Array.isArray(r1.rawContent),
      rawTypes: (r1.rawContent || []).map(c => c.type),
      hasSignature: (r1.rawContent || []).some(c => c.textSignature),
      model: r1.model
    });
    write();

    // ── 第二轮：同样的前缀 + 新消息，看缓存是否命中 ──
    result.stage = "round 2 calling";
    write();
    const assistantMsg = {
      role: "assistant",
      content: r1.content,
      rawContent: r1.rawContent,
      model: r1.model
    };
    const r2 = await withTimeout(
      llmService.generate(
        [mkMessages("再说一句。")[0], assistantMsg, { role: "user", content: "继续。" }],
        { systemPrompt, maxTokens: 60, temperature: 0, target: wantTarget }
      ),
      60000, "round2"
    );
    result.steps.push({
      round: 2,
      usage: r2.usage,
      content: String(r2.content || "").slice(0, 120),
      hasSignature: (r2.rawContent || []).some(c => c.textSignature)
    });
    write();

    // ── 结论 ──
    const u2 = r2.usage || {};
    result.stage = "done";
    result.verdict = {
      cacheRead: u2.cacheRead ?? null,
      cacheWrite: u2.cacheWrite ?? null,
      input: u2.input ?? null,
      cacheWorks: Number(u2.cacheRead) > 0
    };
  } catch (e) {
    result.error = String(e?.message || e);
    result.stage = "failed";
  }

  write();
}
