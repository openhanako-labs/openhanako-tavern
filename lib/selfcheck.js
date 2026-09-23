// lib/selfcheck.js — 启动自检：验证那些"静态查不出、运行时才炸"的绑定
//
// 为什么需要：BUG-043 里 /activation-preview 与 /prompt-preview 用了
// activate / estimateTokens 却从未 import —— node --check 只查语法，
// 查不出"引用了一个不存在的绑定"。结果两个端点一调用就 ReferenceError，
// 而因为前端没有入口，坏了两周没人发现。
//
// 自检的思路：不用起 HTTP 服务器（宿主的认证层绕不过去），
// 而是在 App 启动后直接**调用一次这段代码路径**。
// 测的是"修好的 import 在运行时解析成功且产出正确"，
// 这正是 BUG-043 的本质。结果落到 probe-state.json，可复查。

import { activate } from "./lore/index.js";
import { estimateTokens, trimHistory, prepareHistory, mergeSummary } from "./llm/history.js";
import { stWorldBookToSettings } from "./settings/import.js";
import { filterForCharacter } from "./settings/model.js";
import { buildGenerationInput } from "./conversations/pipeline.js";

/**
 * 跑一次启动自检。
 *
 * 每一项都是一次真实的函数调用——如果哪个 import 漏了或名字错了，
 * 这里会当场抛错，而不是等用户点到那个功能才炸。
 *
 * @param {{ conversationRepo, characterRepo, settingRepo }} repos
 * @returns {{ ok: boolean, checks: Array<{name, ok, detail}>, at: string }}
 */
export async function runSelfCheck(repos) {
  const checks = [];
  const record = (name, fn) => {
    try {
      const detail = fn();
      checks.push({ name, ok: true, detail: detail === undefined ? null : detail });
    } catch (e) {
      checks.push({ name, ok: false, detail: `${e?.name || "Error"}: ${e?.message || e}` });
    }
  };

  // 1. /activation-preview 的两个运行时依赖
  record("activate 可调用", () => {
    const entries = stWorldBookToSettings({
      entries: [{ comment: "自检条目", content: "自检内容", key: ["自检关键词"] }]
    });
    const r = activate(entries, "这里有自检关键词", { budget: 500 });
    if (r.entries.length !== 1) throw new Error(`应激活 1 条，实际 ${r.entries.length}`);
    return `激活 ${r.entries.length} 条`;
  });

  record("estimateTokens 可调用", () => {
    const n = estimateTokens("中文十个汉字测试用例");
    if (!Number.isFinite(n) || n < 5) throw new Error(`估算结果异常: ${n}`);
    return `${n} tokens`;
  });

  // 2. 角色隔离（P3 的世界书分级）
  record("filterForCharacter 隔离", () => {
    const list = [
      { name: "全局", characterId: "" },
      { name: "A的", characterId: "charA" },
      { name: "B的", characterId: "charB" }
    ];
    const got = filterForCharacter(list, { characterId: "charA" }).map(s => s.name);
    if (got.length !== 2 || !got.includes("A的") || got.includes("B的")) {
      throw new Error(`隔离结果不对: ${got.join(",")}`);
    }
    return got.join(" + ");
  });

  // 3. /prompt-preview 走的整条管线（含 preset 与真实窗口）
  //    异步，单独处理
  let pipelineOk = false;
  let pipelineNote = "";
  try {
    const { conversationRepo, characterRepo } = repos || {};
    if (!conversationRepo || !characterRepo) throw new Error("repos 未就绪");

    const cards = await characterRepo.list();
    const convs = await conversationRepo.list();
    if (cards.length === 0 || convs.length === 0) throw new Error("无角色卡或对话，跳过");

    const conv = await conversationRepo.get(convs[0].id);
    const character = await characterRepo.get(conv.characterId);
    if (!conv || !character) throw new Error("首条对话或角色卡读不到");

    const input = await buildGenerationInput(
      { conversationRepo, characterRepo, settingRepo: repos.settingRepo || null, regexRepo: null },
      conv, character, "",
      { contextWindow: 32000, maxTokens: 500 }
    );

    if (typeof input.systemPrompt !== "string") throw new Error("systemPrompt 不是字符串");
    if (!Array.isArray(input.messages)) throw new Error("messages 不是数组");
    if (!input.meta || typeof input.meta !== "object") throw new Error("meta 缺失");
    pipelineOk = true;
    pipelineNote = `系统提示 ${input.systemPrompt.length} 字 / ${input.messages.length} 条消息`
      + ` / 世界书 ${input.meta.loreCount} 条`;
  } catch (e) {
    pipelineNote = e?.message || String(e);
  }
  checks.push({ name: "buildGenerationInput 管线", ok: pipelineOk, detail: pipelineNote });

  // 4. 摘要三态（P3 的写回逻辑）
  record("mergeSummary 三态", () => {
    const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: "user", content: `x${i}` }));

    const fresh = mergeSummary(null, mk(10));
    if (!fresh?.text || fresh.coveredCount !== 10) throw new Error("无旧摘要时应现算全部");

    const reuse = mergeSummary({ text: "旧", coveredCount: 10 }, mk(10));
    if (reuse.text !== "旧") throw new Error("覆盖数不变时应复用");

    const grown = mergeSummary({ text: "旧", coveredCount: 10 }, mk(15));
    if (!grown.text.startsWith("旧") || grown.coveredCount !== 15) throw new Error("增长时应追加");

    const shrunk = mergeSummary({ text: "旧", coveredCount: 15 }, mk(8));
    if (shrunk.text === "旧") throw new Error("旧摘要盖得更多时应失效重算");
    return "现算/复用/追加/失效 四态正确";
  });

  // 5. 历史裁剪（/prompt-preview 的 droppedMessages 来源）
  record("trimHistory 返回被折叠的原文", () => {
    const r = trimHistory(
      Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, role: "user", content: "内容".repeat(50) })),
      { maxTokens: 30, keepRecent: 2 }
    );
    if (r.dropped === 0 || r.droppedMessages.length !== r.dropped) {
      throw new Error(`dropped=${r.dropped} 但 droppedMessages=${r.droppedMessages.length}`);
    }
    return `折叠 ${r.dropped} 条`;
  });

  return {
    ok: checks.every(c => c.ok),
    checks,
    at: new Date().toISOString()
  };
}
