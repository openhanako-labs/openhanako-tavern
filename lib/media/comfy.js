// lib/media/comfy.js — 让酒馆走本机 ComfyUI 出图
//
// ## 为什么这条路现在才通
//
// 之前判断过：ComfyUI-Hana **不对外提供服务**（manifest 里没有 services），
// 所以"App 直接调 ComfyUI"看着没门。但契约里还有另一条面——
// `app/environments.manage` 的 `runTool`：**在一个环境里跑另一个扩展的工具**。
// 这条面把门打开了，而且**不用改 ComfyUI-Hana 一行代码**。
//
// ## 调用形状（读 comfyui-hana 的工具手册定的，不是猜的）
//
//   submit:  {action:"submit", workflow:{template:"名称"} | {…API JSON…} | "路径",
//             inputs:{"<node_id>.<input>": 值}}   → details.comfyui.promptId
//   query:   {action:"query", promptId}           → 状态
//   result:  {action:"result", promptId}          → 本地路径列表
//
// 所以这条路是"提交 → 轮询 → 取产物"，跟 App 自己调 sdk.media 那种同步返回不一样。
// 轮询参数可注入，测试里就不必真的等。

/** 找 ComfyUI 那个工具有多宽容：按工具名找，找不到再按扩展 id 找。 */
export function pickComfyTool(catalog) {
  const tools = Array.isArray(catalog?.tools) ? catalog.tools : [];
  const byName = tools.find((t) => t?.name === "comfyui");
  if (byName) return { ref: byName.ref, name: byName.name };
  const byExt = tools.find((t) => String(t?.ref || "").includes("comfyui"));
  return byExt ? { ref: byExt.ref, name: byExt.name } : null;
}

/** 从工具返回值里挖一个字段：先看已知路径，再退到"整棵树上找同名键"。 */
export function dig(obj, key, depth = 0) {
  if (obj === null || obj === undefined || depth > 6) return undefined;
  if (typeof obj !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) return obj[key];
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) {
    const hit = dig(v, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** 工具返回值里可能还包着 content[].text（一段 JSON 字符串）。 */
export function readPayload(result) {
  if (typeof result === "string") {
    const s = result.trim();
    if (s.startsWith("{") || s.startsWith("[")) {
      try { return JSON.parse(s); } catch { return result; }
    }
    return result;
  }
  // MCP 风格的 {content:[{type:"text",text:"{...}"}]}
  const textish = dig(result, "text");
  if (typeof textish === "string" && (textish.trim().startsWith("{") || textish.trim().startsWith("["))) {
    try { return JSON.parse(textish); } catch { /* 不是 JSON 就用原样 */ }
  }
  return result;
}

/** 提交后拿 promptId。 */
export function extractPromptId(result) {
  const p = readPayload(result);
  const id = dig(p, "promptId") ?? dig(p, "prompt_id");
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

/** 收集返回值里所有像本地绝对路径的字符串（去重保序）。 */
export function extractPaths(result, limit = 8) {
  const out = [];
  const seen = new Set();
  const walk = (v, depth = 0) => {
    if (out.length >= limit || v === null || v === undefined || depth > 8) return;
    if (typeof v === "string") {
      // Windows 绝对路径。刻意不收 URL——预览 URL 下载下来是另一码事，
      // 这里要的是 ComfyUI 已经写在盘上的那个文件。
      if (/^[a-zA-Z]:[\\/][^\n"']+\.(png|jpe?g|webp)$/i.test(v.trim())) {
        const s = v.trim();
        if (!seen.has(s)) { seen.add(s); out.push(s); }
      }
      return;
    }
    if (typeof v === "object") {
      for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
    }
  };
  walk(readPayload(result));
  return out;
}

/** 任务状态词：从返回值里认出"好没好"。**认不出来时按未完成处理**——宁可多等一轮，也不把半成品当成品。 */
export function readStatus(result) {
  const p = readPayload(result);
  const s = String(
    dig(p, "status") ?? dig(p, "state") ?? dig(p, "phase") ?? dig(p, "message") ?? ""
  ).toLowerCase();
  if (/(fail|error|invalid|cancel|interrupt)/.test(s)) return "failed";
  if (/(success|complete|done|finished|已完成|完成)/.test(s)) return "done";
  return "pending";
}

/**
 * 在环境里跑一次 ComfyUI 出图。
 *
 * @param {{sdk: object, env: {environmentId: string, revision: number}, tool: {ref: string, name: string},
 *          template: string, promptTarget: string, prompt: string,
 *          refImageTarget?: string, referenceImagePath?: string,
 *          timeoutMs?: number, pollMs?: number, sleep?: Function}} args
 * @returns {Promise<{path: string, promptId: string, waitedMs: number}>}
 */
export async function renderViaComfy({
  sdk,
  env,
  tool,
  template,
  promptTarget,
  prompt,
  refImageTarget,
  referenceImagePath,
  timeoutMs = 180000,
  pollMs = 2500,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms))
} = {}) {
  const api = sdk?.environments;
  if (!api || typeof api.runTool !== "function") {
    throw new Error("宿主没提供 app/environments.manage（manifest 里可能还缺这一条）");
  }
  if (!env?.environmentId) throw new Error("没有可用的环境（先 create 一个）");
  if (!tool?.ref || !tool?.name) throw new Error("没在这台机器上找到 ComfyUI 工具");
  if (!template) throw new Error("还没选工作流——本机出图要指定用哪个工作流");
  if (!promptTarget) throw new Error("还没说提示词写进哪个节点（形如 6.text）");
  if (!String(prompt || "").trim()) throw new Error("没有提示词");

  const call = (args) => api.runTool({
    environmentId: env.environmentId,
    revision: env.revision,
    ref: tool.ref,
    toolName: tool.name,
    args
  });

  // inputs 里写几个键取决于参数：
  //   · promptTarget + prompt 是必填，写一个文本键
  //   · refImageTarget + referenceImagePath 都存在时，写一个参考图键
  //   · 只有一个时不写那个（写了会报错）
  const inputs = { [promptTarget]: String(prompt) };
  const refPath = typeof referenceImagePath === "string" ? referenceImagePath.trim() : "";
  // 注意：必须 !! 归一化——下面这个表达式的值是「第一个非真值」，
  // 可能是空字符串也可能是 refPath 那个字符串本身。不 ! 一下就会把路径
  // 当布尔值传出去，上层拿它当标记用会拿到一个路径。
  const hasRef = !!(typeof refImageTarget === "string" && refImageTarget.trim() && refPath);
  if (hasRef) inputs[refImageTarget.trim()] = refPath;

  const submitted = await call({
    action: "submit",
    workflow: { template },
    inputs,
    clientLabel: "eleckoi-tavern 立绘"
  });
  const promptId = extractPromptId(submitted);
  const started = Date.now();

  // 有些实现提交就带产物（同步工作流），先看一眼，别白等。
  const early = extractPaths(submitted);
  if (early.length) return { path: early[0], promptId, waitedMs: 0, usedReferenceImage: hasRef };

  if (!promptId) {
    const dump = JSON.stringify(readPayload(submitted)).slice(0, 240);
    throw new Error(`ComfyUI 没说这次任务的 id，取不到产物（返回：${dump}）`);
  }

  while (Date.now() - started < timeoutMs) {
    await sleep(pollMs);
    const q = await call({ action: "query", promptId });
    const st = readStatus(q);
    if (st === "failed") {
      const dump = JSON.stringify(readPayload(q)).slice(0, 300);
      throw new Error(`ComfyUI 这一趟失败了：${dump}`);
    }
    if (st === "done") {
      const r = await call({ action: "result", promptId });
      const paths = extractPaths(r);
      if (paths.length) return { path: paths[0], promptId, waitedMs: Date.now() - started, usedReferenceImage: hasRef };
      // 完成了但还没落盘：再等一轮（`result` 说"尚未完成"是已知状况）
      continue;
    }
  }

  throw new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒还没出图——ComfyUI 可能卡在队列里，去它的工作区看看`);
}

/**
 * 备一个环境。
 *
 * 优先复用一个**已经存在**的环境：反复 create 会在宿主里堆出一串环境。
 * 拿不到列表时退回 create。
 */
export async function ensureEnvironment(sdk) {
  const api = sdk?.environments;
  if (!api) throw new Error("宿主没提供 app/environments.manage");
  try {
    const list = await api.list({});
    const first = (Array.isArray(list) ? list : []).find((e) => e?.state === "running") || (Array.isArray(list) ? list[0] : null);
    if (first?.environmentId) return { environmentId: first.environmentId, revision: first.revision };
  } catch { /* 列不出来就新建 */ }
  const created = await api.create({});
  if (!created?.environmentId) throw new Error("建不出环境");
  return { environmentId: created.environmentId, revision: created.revision };
}
