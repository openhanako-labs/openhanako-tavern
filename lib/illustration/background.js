// lib/illustration/background.js — AI 背景图生成（第 4 期）
//
// 自动链：场景文本 → LLM 写背景提示词（**严格禁人物**）→ 现有出图引擎
//（host / comfyui 双后端，复用 lib/media/）→ AppearanceRepo.saveImage 落盘。
// 前端 #app-bg 层（appearance 模块）自动生效——不另立展示层。
//
// 三道人物防线（提示词注入防线，模型不听话时兜底）：
//   1. systemPrompt 明令禁止
//   2. 解析层校验：产出提示词含人物标记词 → 拒收重试一次
//   3. 重试仍含 → 返回错误（不花钱出图）
//
// 默认关（background.json enabled=false）——花钱动作默认关，与 scene.json 同纪律。

import fs from "node:fs/promises";

/** 人物标记词：产出提示词里出现任何一个就拒收。 */
const PERSON_MARKERS = [
  "person", "people", "human", "man", "woman", "girl", "boy", "portrait",
  "character", "face", "figure", "silhouette", "shadow of a",
  "人物", "人影", "身影", "少女", "少年", "男人", "女人", "角色"
];

/** 背景默认配置。 */
export const BACKGROUND_DEFAULTS = {
  enabled: false,        // 总闸。花钱动作默认关。
  style: "natural",      // natural（自然语言，Qwen-Image/Flux）| clip（标签，SD1.5/Pony）
  wideSuffix: "wide shot, 16:9 aspect ratio, scenic background, no people, empty scene"
};

/** 人物标记词校验。返回命中的标记（空数组 = 通过）。 */
export function checkNoPerson(promptText) {
  const s = String(promptText ?? "").toLowerCase();
  return PERSON_MARKERS.filter(m => s.includes(m.toLowerCase()));
}

/**
 * 构造"场景文本 → 背景提示词"的 LLM 输入。
 *
 * @param {string} sceneText  场景描述（剧情卡场景行 / 手动输入）
 * @param {{style?: string}} [opts]
 * @returns {{systemPrompt: string, userPrompt: string}}
 */
export function buildBackgroundPrompt(sceneText, opts = {}) {
  const style = opts.style === "clip" ? "clip" : "natural";
  const formatRule = style === "clip"
    ? "输出英文 CLIP 标签短语，用逗号分隔（如：stone tower, night, heavy rain, cold blue lighting）。"
    : "输出一段英文自然语言描述（1-3 句），描述场景的环境与光照。";

  return {
    systemPrompt: [
      "你是场景背景提示词写手。把给定的场景描述转成一张**纯环境背景图**的提示词。",
      "三条硬约束：",
      "1. 严格禁止出现任何人物——不画人、不画人影、不画剪影、不画身体部位。",
      "2. 只描述：建筑、自然、光照、天气、氛围、时间。",
      "3. " + formatRule,
      "只输出提示词本身，不解释，不包代码块。"
    ].join("\n"),
    userPrompt: String(sceneText ?? "").trim()
  };
}

/**
 * 从对话里猜场景文本：优先最后一条剧情卡的场景行，退化到最近一段旁白。
 * @returns {string|null}
 */
export function guessSceneText(conv) {
  if (!conv || !Array.isArray(conv.messages)) return null;
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.role !== "assistant") continue;
    // 剧情卡：story.story.scene
    const scene = m.story?.story?.scene;
    if (typeof scene === "string" && scene.trim()) return scene.trim();
  }
  // 退化：最后一段旁白（从正文里抽第一句）——粗略，够用
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.role !== "assistant") continue;
    const narr = (m.story?.dialogue || []).find(d => d.isNarration);
    if (narr?.text) return narr.text.slice(0, 120);
  }
  return null;
}

/**
 * 生成背景图。
 *
 * @param {object} opts
 * @param {object} opts.sdk            App SDK（media/environments 面）
 * @param {object} opts.llm            LLM 服务（generate）
 * @param {object} opts.resolveTarget  resolveModelTarget 函数
 * @param {string} opts.sceneText      场景描述
 * @param {object} [opts.config]       背景配置（style 等）
 * @param {object} [opts.comfy]        comfyui 路：{ renderViaComfy, ensureEnvironment, findComfyTool }（由调用方注入，避免循环依赖）
 * @param {object} [opts.host]         host 路：{ generateImageRaw, readProductBytes }
 * @returns {Promise<{bytes: Buffer, mime: string, prompt: string, via: string}>}
 */
export async function generateBackground(opts = {}) {
  const { sdk, llm, resolveTarget, sceneText, config = {}, comfy, host } = opts;
  if (!sceneText || !String(sceneText).trim()) throw new Error("场景描述是空的");
  if (!llm || typeof llm.generate !== "function") throw new Error("模型服务未就绪");

  const cfg = { ...BACKGROUND_DEFAULTS, ...config };
  const { systemPrompt, userPrompt } = buildBackgroundPrompt(sceneText, { style: cfg.style });

  // 两道防线：生成 + 校验（重试一次）
  let promptText = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await llm.generate(
      [{ role: "user", content: userPrompt }],
      {
        systemPrompt,
        maxTokens: 300,
        temperature: 0.4,
        target: resolveTarget || null
      }
    );
    const candidate = String(r?.content ?? "").trim()
      .replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim()
      .replace(/^(?:好的|好|嗯)[，,、:：]?\s*/, "").trim()
      .replace(/^(?:背景|提示词|prompt)\s*[:：]\s*/i, "").trim();

    const hits = checkNoPerson(candidate);
    if (hits.length === 0) { promptText = candidate; break; }
    if (attempt === 1) {
      throw new Error(`生成的提示词含人物元素（${hits.join("、")}），已拒绝出图。请改写场景描述。`);
    }
  }
  if (!promptText) throw new Error("提示词生成失败");

  const finalPrompt = `${promptText}, ${cfg.wideSuffix}`;

  // 出图：两条路
  if (cfg.backend === "comfyui") {
    if (!comfy?.renderViaComfy) throw new Error("comfyui 路未注入（comfy.renderViaComfy 缺失）");
    const out = await comfy.renderViaComfy({ sdk, prompt: finalPrompt });
    const bytes = await fs.readFile(out.path);
    return { bytes, mime: "image/png", prompt: finalPrompt, via: "comfyui" };
  }

  if (!host?.generateImageRaw) throw new Error("host 路未注入（host.generateImageRaw 缺失）");
  const raw = await host.generateImageRaw(sdk, { prompt: finalPrompt });
  const picked = await host.readProductBytes(sdk, raw, {});
  if (!picked.ok) throw new Error(picked.reason || "出图失败");
  return { bytes: picked.bytes, mime: picked.mime || "image/png", prompt: finalPrompt, via: "host" };
}

export default { buildBackgroundPrompt, checkNoPerson, guessSceneText, generateBackground, BACKGROUND_DEFAULTS };
