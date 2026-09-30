// lib/recall/loop.js — ReAct 轻循环
//
// 骨架照抄 Sirchmunk 的 ReActSearchAgent（src/sirchmunk/agentic/react_agent.py）：
//   · 每轮 LLM 输出 → 解析 <ANSWER> 标签 / {"tool":..,"arguments":{..}} JSON
//   · <ANSWER> 收工；工具调用 → 执行 → 结果塞回对话 → 下一轮
//   · 无输出时 nudge 一次；再也没用就跳出
//   · 循环/预算耗尽 → 强制兜底合成
//   · 工具结果截断到 8000 字符
//
// 与 Sirchmunk 的差异：
//   · 没有 LLMTokenBudgetExceeded 那种类型化异常——直接检查 budgetRemaining
//   · 只有 2 个工具（search / read_entry），工具表是普通对象
//   · 没有 telemetry 的三档（sufficiency / computation_trace），只用一个 dict
//
// 关键契约：循环**必须**返回一个 answer 字符串，可能是空串。
//   调用方把空串当「没召回」处理，不做注入——不阻塞发消息。

import { estimateTokens } from "../llm/history.js";
import { createRecallTools, TOOL_RESULT_CHAR_LIMIT } from "./tools.js";

const ANSWER_RE = /<ANSWER>([\s\S]*?)<\/ANSWER>/;

/**
 * 解析 LLM 输出里的工具调用 JSON。
 * 支持三种风格：
 *   1) ```json {...} ``` 代码块
 *   2) 裸 JSON: {"tool":"search","arguments":{...}}
 *   3) {"name":"...","args":{...}}（Sirchmunk 兼容）
 *
 * 返回 { name, args } 或 null。
 */
export function parseToolCall(text, availableTools) {
  if (!text || typeof text !== "string") return null;
  const names = availableTools || [];
  if (names.length === 0) return null;

  const codeBlocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
    .map(m => m[1]);
  const candidates = [...codeBlocks];
  const rawBlocks = [...text.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)].map(m => m[0]);
  candidates.push(...rawBlocks);

  for (const block of candidates) {
    let obj;
    try { obj = JSON.parse(block); }
    catch { continue; }
    if (!obj || typeof obj !== "object") continue;
    const name = obj.tool || obj.name;
    if (!name || typeof name !== "string") continue;
    if (!names.includes(name)) continue;
    const args = obj.arguments || obj.args || obj.parameters || {};
    return { name, args: args && typeof args === "object" ? args : {} };
  }
  return null;
}

function buildSystemPrompt({ toolDescriptions, ctx }) {
  return [
    "你是精准的信息检索助手。任务：根据用户输入，从角色卡 / 世界书 / 对话历史中找出相关证据，然后用 <ANSWER> 标签给出证据总结。",
    "",
    "## 可用工具",
    toolDescriptions,
    "",
    "## 调用格式",
    "一次性只调一个工具，输出 JSON（不带任何其他内容）：",
    "```json",
    '{"tool":"<name>","arguments":{...}}',
    "```",
    "",
    "## 策略",
    "1. 先用 search 找候选，再用 read_entry 读最相关的几条全文。",
    "2. 不要用同一批关键词重复 search——换词。",
    "3. 已读过的条目不用重复读（系统会自动跳过）。",
    "4. 证据够了就用 <ANSWER>…</ANSWER> 结束。",
    "5. 证据不足就再调一次工具，直到预算耗尽。",
    "",
    "## 会话状态",
    `剩余 token: ${ctx.budgetRemaining}`,
    `已读条目: ${ctx.readEntryIds.size}`,
    `检索次数: ${ctx.searchHistory.length}`,
    `循环: ${ctx.loopCount}/${ctx.maxLoops}`,
    "",
    "## 输出契约",
    "证据不足也不要硬编——找不到就明说。不要在 <ANSWER> 里输出 JSON / 代码块 / 工具调用。"
  ].join("\n");
}

function buildContinuationPrompt(ctx) {
  return [
    "继续决定下一步：",
    "1. 证据已足够 → 输出 <ANSWER>...</ANSWER>",
    "2. 还需要信息 → 输出一个工具调用 JSON",
    "3. 预算将尽 → 用已有证据合成最佳答案",
    "",
    `剩余 token: ${ctx.budgetRemaining} | 循环: ${ctx.loopCount}/${ctx.maxLoops} | 已读: ${ctx.readEntryIds.size}`
  ].join("\n");
}

function buildToolDescriptions(tools) {
  const lines = [];
  for (const [name, t] of Object.entries(tools)) {
    const params = t.parameters?.properties || {};
    const required = new Set(t.parameters?.required || []);
    const paramLines = Object.entries(params).map(([pname, pinfo]) => {
      const req = required.has(pname) ? " (required)" : "";
      return `  - ${pname} (${pinfo.type}${req}): ${pinfo.description || ""}`;
    });
    lines.push(`### ${name}\n${t.description}`);
    if (paramLines.length) lines.push("  参数:\n" + paramLines.join("\n"));
  }
  return lines.join("\n");
}

/**
 * 跑一次 ReAct 循环。
 *
 * @param {object} opts
 * @param {object} opts.llm                    LLM 服务实例（有 generate 方法）
 * @param {import("./index.js").InvertedIndex} opts.index  倒排索引
 * @param {import("./context.js").RecallContext} opts.ctx  账本
 * @param {string} opts.query                  用户输入原文
 * @param {object[]} [opts.initialKeywords]    预热关键词，作为第一轮 start hint
 * @param {string} [opts.preloadedEvidence]    预热阶段已抽到的证据文本
 * @param {object} [opts.target]               LLM target（如 {provider, model}），缺省用宿主默认
 * @param {number} [opts.maxTokens=1200]       每次 LLM 调用的 completion 上限
 * @returns {Promise<{answer: string, ctx: RecallContext}>}
 */
export async function runRecallLoop(opts) {
  const {
    llm, index, ctx, query,
    initialKeywords = null,
    preloadedEvidence = null,
    target = null,
    maxTokens = 1200
  } = opts;

  // 契约：任何硬前提不满足就静默返回空串，不抛错
  if (!llm || typeof llm.generate !== "function") return { answer: "", ctx };
  if (!query || !String(query).trim()) return { answer: "", ctx };
  if (!index) return { answer: "", ctx };

  const tools = createRecallTools({ index, ctx });
  const toolNames = Object.keys(tools);
  const toolDescriptions = buildToolDescriptions(tools);

  const sysPrompt = buildSystemPrompt({ toolDescriptions, ctx });
  const messages = [
    { role: "system", content: sysPrompt },
    { role: "user", content: `用户输入：\n${query}` }
  ];

  // 预热证据作为第一条观察塞进去
  if (preloadedEvidence && String(preloadedEvidence).trim()) {
    const ev = String(preloadedEvidence);
    const truncated = ev.length > 4000 ? ev.slice(0, 4000) + "\n... [evidence truncated]" : ev;
    messages.push({
      role: "assistant",
      content: "我先用现成的证据开头，再决定下一步。"
    });
    messages.push({
      role: "user",
      content:
        "**预热检索到的候选证据**（当作线索，不当结论）:\n"
        + truncated
        + "\n\n"
        + buildContinuationPrompt(ctx)
    });
    ctx.telemetry.preloadedChars = ev.length;
  }

  // 预热关键词：作为第一次工具的初始动作（省一次 LLM 决策）
  if (initialKeywords && Array.isArray(initialKeywords) && initialKeywords.length > 0) {
    ctx.incrementLoop();
    let result;
    try { result = await tools.search.execute({ keywords: initialKeywords }); }
    catch (e) { result = { text: `search 失败: ${e?.message || e}`, ok: false }; }
    if (result.text && result.text !== "No results.") {
      messages.push({
        role: "assistant",
        content: `先用预热关键词搜一次：${JSON.stringify({ tool: "search", arguments: { keywords: initialKeywords } })}`
      });
      messages.push({
        role: "user",
        content: `**工具结果** (search):\n${result.text}\n\n${buildContinuationPrompt(ctx)}`
      });
    }
  }

  let finalAnswer = null;
  let nudged = false;

  while (!ctx.isLoopLimitReached() && !ctx.isBudgetExceeded()) {
    ctx.incrementLoop();

    // 提前估算 prompt 长度，避免超预算
    const promptTokens = estimateTokens(
      messages.map(m => String(m.content ?? "")).join("\n")
    );
    const remaining = ctx.budgetRemaining;
    const requested = Math.min(maxTokens, remaining - promptTokens - 64);
    if (requested < 128) {
      ctx.telemetry.hardBudgetExhausted = true;
      ctx.telemetry.hardBudgetReason = `prompt=${promptTokens} remaining=${remaining}`;
      break;
    }

    let resp;
    try {
      resp = await llm.generate(messages, {
        maxTokens: requested,
        temperature: 0.2,
        target
      });
    } catch (e) {
      ctx.telemetry.error = String(e?.message || e);
      break;
    }

    const content = resp?.content || "";
    const usage = resp?.usage || {};
    const tokens = usage.total_tokens
      || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0)
      || 0;
    ctx.addLLMTokens(tokens, usage);

    // 1) <ANSWER> 收工
    const am = content.match(ANSWER_RE);
    if (am) {
      finalAnswer = am[1].trim();
      ctx.telemetry.finishedBy = "answer";
      break;
    }

    // 2) 工具调用
    const tc = parseToolCall(content, toolNames);
    if (tc) {
      const tool = tools[tc.name];
      if (!tool) {
        messages.push({ role: "assistant", content });
        messages.push({
          role: "user",
          content: `未知工具: ${tc.name}。可用: ${toolNames.join(", ")}\n\n${buildContinuationPrompt(ctx)}`
        });
        continue;
      }
      let result;
      try {
        result = await tool.execute(tc.args);
      } catch (e) {
        result = { text: `工具执行失败: ${e?.message || e}`, ok: false };
      }
      const rawText = String(result.text ?? "");
      const text = rawText.length > TOOL_RESULT_CHAR_LIMIT
        ? rawText.slice(0, TOOL_RESULT_CHAR_LIMIT) + "\n... [output truncated]"
        : rawText;
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content: `**工具结果** (${tc.name}):\n${text}\n\n${buildContinuationPrompt(ctx)}`
      });
      continue;
    }

    // 3) 无输出 → nudge 一次
    if (!nudged) {
      nudged = true;
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content:
          "必须给出 <ANSWER>...</ANSWER> 或 {\"tool\":...,\"arguments\":{...}} 的 JSON 调用。\n\n"
          + buildContinuationPrompt(ctx)
      });
      continue;
    }

    // 第二次没输出——不再 nudge，直接跳出走兜底
    break;
  }

  // 兜底合成
  if (finalAnswer == null) {
    ctx.telemetry.forcedSynthesis = true;
    messages.push({
      role: "user",
      content: "预算/循环已用尽。请用 <ANSWER>...</ANSWER> 给出你能得出的最佳证据总结（或明说无证据）。不要再调用工具。"
    });
    try {
      const resp = await llm.generate(messages, {
        maxTokens: Math.min(800, ctx.budgetRemaining),
        temperature: 0.2,
        target
      });
      const usage = resp?.usage || {};
      const tokens = usage.total_tokens
        || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0)
        || 0;
      ctx.addLLMTokens(tokens, usage);
      const am = (resp?.content || "").match(ANSWER_RE);
      finalAnswer = am ? am[1].trim() : (resp?.content || "");
    } catch (e) {
      ctx.telemetry.synthesisError = String(e?.message || e);
      finalAnswer = "";
    }
  }

  return { answer: finalAnswer || "", ctx };
}
