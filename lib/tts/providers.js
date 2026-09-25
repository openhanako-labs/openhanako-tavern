// lib/tts/providers.js — 语音合成：把「配置」变成「一个 HTTP 请求」
//
// ## 为什么是"两根水龙头"而不是内置一家的声音
//
// 宿主没有 TTS 这条能力（见 docs/req-tts.md 的实测）。等它补是一条路，
// 但更直接的是：**把这个口子做在 App 里，水由用户自己灌**。
// 于是微软、OpenAI 兼容的任意一家、本机跑着的 GPT-SoVITS / LocalAI，
// 都只是同一根管子上的不同水龙头——想换就换个地址、换个 key，不用改代码。
//
// ## 两根水龙头的形状差别
//
//   微软（Azure 语音服务）：POST {region}.tts.speech.microsoft.com，body 是 SSML，
//     key 走 Ocp-Apim-Subscription-Key 头。
//   OpenAI 兼容：POST {baseUrl}/audio/speech，body 是 JSON，key 走 Bearer。
//     本机服务多半不需要 key（但要填对 baseUrl，比如 http://127.0.0.1:9880/v1）。
//
// 这一层是**纯函数**：把配置 + 文本变成 {url, headers, body}，不碰网络。
// 于是两条路各自的形状都能被单独钉住，而不必真的连一次服务。

/** 默认选的那家。用户说"默认 TTS 就用微软"。 */
export const DEFAULT_PROVIDER = "azure";

/** 单次合成的文本上限。Azure 的免费档按字符算，本地服务也会被长文本噎住——
 *  与其让它超时报一个看不懂的错，不如在门口拦下来说清。 */
export const TEXT_MAX = 2000;

/** 微软的常用中文声音。默认女声——不是审美判断，是"总得有个默认"。 */
const AZURE_VOICES = [
  "zh-CN-XiaoxiaoNeural",
  "zh-CN-XiaoyiNeural",
  "zh-CN-YunxiNeural",
  "zh-CN-YunjianNeural",
  "zh-CN-YunxiaNeural",
  "zh-CN-YunyangNeural"
];

export const PROVIDERS = [
  {
    id: "azure",
    label: "微软（Azure 语音服务）",
    hint: "要填 key 与 region（region 就是资源所在地，比如 eastasia）。默认声音是晓晓。",
    needsKey: true,
    needsRegion: true,
    defaultVoice: "zh-CN-XiaoxiaoNeural",
    voices: AZURE_VOICES
  },
  {
    id: "openai",
    label: "OpenAI 兼容 / 本机服务",
    hint: "填 baseUrl 即可。本机跑的 GPT-SoVITS、LocalAI 之类多半不用 key（留空）。",
    needsKey: false,
    needsRegion: false,
    defaultVoice: "alloy",
    defaultBaseUrl: "https://api.openai.com/v1",
    voices: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"]
  }
];

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

/** 空的配置骨架。读取时给缺字段的旧配置兜住。 */
export function emptyConfig() {
  return {
    enabled: false,
    provider: DEFAULT_PROVIDER,
    voice: "",
    rate: "",
    azure: { region: "", key: "" },
    openai: { baseUrl: "", model: "tts-1", key: "" }
  };
}

function str(v) {
  return String(v ?? "").trim();
}

/** 把用户填的文本压成一次合成要的长度；超了要能告诉调用方超了多少。 */
export function clampText(text) {
  const s = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (s.length <= TEXT_MAX) return { text: s, truncated: 0 };
  return { text: s.slice(0, TEXT_MAX), truncated: s.length - TEXT_MAX };
}

/** XML 转义。SSML 是 XML，文本里一个裸 `&` 或 `<` 就能让整段请求变 400。 */
export function xmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 配置 + 文本 → 一个 HTTP 请求。
 *
 * 缺什么就在这里说清（而不是让调用方拿着一个会 401 的请求去撞墙）：
 * 微软要看 key/region，OpenAI 兼容要看 baseUrl。
 *
 * @param {object} cfg 已归一化的配置
 * @param {string} text 已经 clamp 过的文本
 * @returns {{url: string, method: string, headers: object, body: string, mime: string, ext: string, provider: string, voice: string}}
 */
export function buildRequest(cfg, text) {
  const id = cfg?.provider || DEFAULT_PROVIDER;
  const p = getProvider(id);
  if (!p) throw new Error(`不认识的语音提供方：${id}`);

  const voice = str(cfg.voice) || p.defaultVoice;
  const rate = str(cfg.rate);

  if (id === "azure") {
    const region = str(cfg.azure?.region);
    const key = str(cfg.azure?.key);
    if (!region) throw new Error("微软语音要先填 region（资源所在地，比如 eastasia）");
    if (!key) throw new Error("微软语音要先填 key");
    if (!/^[a-z0-9-]+$/i.test(region)) {
      throw new Error(`region 看起来不对（只能有字母数字和连字符）：${region}`);
    }

    // 语速走 SSML 的 prosody；不填就不加那层，保持供应商默认
    const inner = rate
      ? `<prosody rate="${xmlEscape(rate)}">${xmlEscape(text)}</prosody>`
      : xmlEscape(text);
    const ssml =
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">` +
      `<voice name="${xmlEscape(voice)}">${inner}</voice></speak>`;

    return {
      url: `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "eleckoi-tavern"
      },
      body: ssml,
      mime: "audio/mpeg",
      ext: "mp3",
      provider: id,
      voice
    };
  }

  // OpenAI 兼容：OpenAI 官方、SiliconFlow、以及本机各种包装都用这个形状
  const baseUrl = str(cfg.openai?.baseUrl).replace(/\/+$/, "");
  if (!baseUrl) throw new Error("这条路要先填 baseUrl（比如 https://api.openai.com/v1）");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error(`baseUrl 要以 http:// 或 https:// 开头：${baseUrl}`);

  const key = str(cfg.openai?.key);
  const model = str(cfg.openai?.model) || "tts-1";
  const headers = { "Content-Type": "application/json", "User-Agent": "eleckoi-tavern" };
  if (key) headers.Authorization = `Bearer ${key}`;

  return {
    url: `${baseUrl}/audio/speech`,
    method: "POST",
    headers,
    body: JSON.stringify({ model, input: text, voice, response_format: "mp3" }),
    mime: "audio/mpeg",
    ext: "mp3",
    provider: id,
    voice
  };
}

/** 外部返回的 content-type 有时不准（本机服务常回 octet-stream）——
 *  但"不准"也不该让浏览器拿着 mp3 当二进制下载。所以只认明显正确的那些。 */
export function normalizeMime(ct, fallback = "audio/mpeg") {
  const s = String(ct || "").toLowerCase();
  if (s.includes("mpeg") || s.includes("mp3")) return "audio/mpeg";
  if (s.includes("wav")) return "audio/wav";
  if (s.includes("ogg")) return "audio/ogg";
  if (s.includes("webm")) return "audio/webm";
  if (s.includes("aac")) return "audio/aac";
  return fallback;
}
