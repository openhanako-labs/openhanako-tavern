// lib/media/service.js — 出图：走宿主那道门
//
// ## 调用形状是读宿主实现定下的，不是猜的
//
// 宿主里那段原话（bundle 的 generateImageFromBus）：
//   `if (appScope && !isResponseDelivery) throw new Error(
//      "app-scoped media generation requires response delivery");`
//
// 也就是说：**应用发起的出图必须走同步交付**（delivery.mode = "response"），
// 不能在应用侧用 submit + taskId 那套（那套是会话侧/工具侧走的）。
// 所以这里固定传 response —— 少一次瞎试。
//
// ## 为什么结果里要挑文件
//
// 返回里到底长什么样，是**看过一次真实结果**才定下的（2026-09-25 一次真出图）：
//   {
//     files: ["vera-….png"],                     ← 裸文件名，不是路径
//     sessionFiles: [{ filePath: "W:\\…\\vera-….png", realPath: … }]
//   }
// 只认 files 里的字符串、拿去 fs.readFile 的话会 ENOENT——
// 而那句错误话只会说“找不到文件”，看不出是“我没找对地方”。
// 所以：先收 sessionFiles 的完整路径，再收 files，最后只信绝对路径。

const PROMPT_MAX = 800;

/** 把返回里每一项尽量读成一个路径（可能只是文件名）。去重保序。 */
export function pickPaths(result) {
  const out = [];
  const push = (p) => {
    if (typeof p === "string" && p.trim()) out.push(p.trim());
  };

  for (const f of Array.isArray(result?.sessionFiles) ? result.sessionFiles : []) {
    if (f && typeof f === "object") {
      push(f.filePath);
      push(f.realPath);
    }
  }

  for (const f of Array.isArray(result?.files) ? result.files : []) {
    if (typeof f === "string") {
      push(f);
    } else if (f && typeof f === "object") {
      push(f.path);
      push(f.filePath);
      push(f.localPath);
      push(f.absolutePath);
    }
  }

  return [...new Set(out)];
}

/** 只有绝对路径才拿得到文件；裸文件名只能当报错时的线索。
 *
 * Windows 上的绝对路径不止 `C:\` 一种写法——复核指出过：
 * Node 处理长路径时会给 `\\?\C:\…`，网络盘是 `\\server\share\…`。
 * 只认盘符的话，真返回值里带长路径前缀时就报“没拿到可读路径”，
 * 而那句错会把人往“盘有问题”上带。
 */
export function isAbsolutePath(p) {
  if (typeof p !== "string") return false;
  const s = p.trim();
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true;          // C:\…
  if (/^\\\\\?\\[a-zA-Z]:[\\/]/.test(s)) return true;   // \\?\C:\…（长路径）
  if (/^\\\\[^\\]/.test(s)) return true;              // \\server\share\…（UNC）
  return false;
}

/** 挑第一个真正的路径；挑不出来返回 null。 */
export function pickImageFile(result) {
  return pickPaths(result).find(isAbsolutePath) || null;
}

/** 媒体面就绪没有。 */
export function status(sdk) {
  const hasMedia = !!sdk && typeof sdk.media === "object" && sdk.media !== null;
  const hasGenerateImage = hasMedia && typeof sdk.media.generateImage === "function";
  return {
    available: hasGenerateImage,
    reason: hasGenerateImage
      ? null
      : hasMedia
        ? "宿主的媒体面里没有 generateImage（契约对不上）"
        : "宿主没提供 sdk.media（manifest 里可能还缺 app/media.generate）"
  };
}

/**
 * 归一化 `image` / `referenceImages` 为契约要求的形状：
 *   · { kind: "local-file", path } 或 { kind: "session-file", fileId }
 *   · 其他形态一律丢掉，不硬凑（凑错了宿主认不出）
 * 见 sdk/app-contract/bus-requests.d.ts 里 AppMediaReferenceV2 的定义。
 */
function normalizeRef(v) {
  if (!v || typeof v !== "object") return null;
  if (v.kind === "local-file" && typeof v.path === "string" && v.path.trim()) {
    return { kind: "local-file", path: v.path.trim() };
  }
  if (v.kind === "session-file" && typeof v.fileId === "string" && v.fileId.trim()) {
    return { kind: "session-file", fileId: v.fileId.trim() };
  }
  return null;
}

function normalizeRefList(v) {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  const out = [];
  for (const x of arr) {
    const n = normalizeRef(x);
    if (n) out.push(n);
  }
  return out;
}

/**
 * 生成一张图，返回本地文件路径。
 *
 * 参考图字段（image / referenceImages）是契约的**顶层字段**，不是 options 里的键。
 * 契约来源：sdk/app-contract/bus-requests.d.ts:246-247 的 AppMediaGenerationInputV2。
 * 塞进 options 宿主不认（options 是 provider 自己读的扩展位，参考图是通用字段）。
 *
 * **契约支持 ≠ 后端行为**。providers.d.ts 那层只有 `input: ("text"|"image")[]`
 * （模型能不能吃图），没有「能不能吃参考图做 i2i」的语义说明。所以后端 provider
 * 会不会读这个字段——目前**没有真机验证**。真调用失败时，会打上
 * ERR_REF_IMAGE_FAILED 码，让上层可以据此降级重试（见 lib/illustration/service.js）。
 *
 * @param {object} sdk 宿主 SDK（要有 sdk.media.generateImage）
 * @param {{prompt: string, suggestedFilename?: string, options?: object,
 *          image?: object|object[], referenceImages?: object[]}} args
 * @returns {Promise<{paths: string[], raw: object}>}
 */
export async function generateImageRaw(sdk, { prompt, suggestedFilename, options, image, referenceImages } = {}) {
  const st = status(sdk);
  if (!st.available) throw new Error(`出图未就绪：${st.reason}`);

  const text = String(prompt ?? "").trim();
  if (!text) throw new Error("prompt is required");
  if (text.length > PROMPT_MAX) throw new Error(`提示词太长（${text.length} > ${PROMPT_MAX}）`);

  // 归一化参考图。归不出任何有效项，就当作没给——不硬凑。
  const refs = normalizeRefList(referenceImages);
  const single = normalizeRef(image);
  const usedImage = !!single || refs.length > 0;

  const input = {
    prompt: text,
    ...(suggestedFilename ? { suggestedFilename: String(suggestedFilename).slice(0, 60) } : {}),
    // 必须是 response：应用域不让走异步交付（宿主会直接抛）
    delivery: { mode: "response", ...(options?.ttlMs ? { ttlMs: options.ttlMs } : {}) },
    ...(single ? { image: single } : {}),
    ...(refs.length ? { referenceImages: refs } : {}),
    ...(options && typeof options === "object" ? { options } : {})
  };

  let res;
  try {
    res = await sdk.media.generateImage({ scope: "app", input });
  } catch (e) {
    // 挖 cause：套着 "fetch failed" 的壳时，真话在 cause 里
    const why = e?.cause?.code || e?.cause?.message || e?.code || e?.message || String(e);
    const err = new Error(`出图失败：${why}`);
    // 参考图导致的失败要让上层认得出：上层看到 err.code 就降级重发（不带参考图），
    // 而不是把这张图直接判死。契约支持 ≠ 后端行为，这条降级路径是**必须的**。
    if (usedImage) err.code = "ERR_REF_IMAGE_FAILED";
    err.referenceImages = usedImage;
    throw err;
  }

  if (res && res.ok === false) {
    const err = new Error(`出图失败：${res.error || res.status || "宿主没给原因"}`);
    // 与 try/catch 分支同一套纪律：失败且本次带了参考图，就要能认得出来
    if (usedImage) err.code = "ERR_REF_IMAGE_FAILED";
    err.referenceImages = usedImage;
    throw err;
  }

  // 只出图，不替调用方断言“产物长什么样”：
  // app 域的返回可能是 `{ ok, kind, batchId, prompt }` 这种没有路径的形状，
  // 文件要从 batchId 换（见 lib/media/bytes.js）。调用方自己决定怎么拿字节。
  return res;
}

/**
 * 出图并确保拿到一个可读的路径（留给需要路径的调用方）。
 * @returns {Promise<{paths: string[], raw: object}>}
 */
export async function generateImage(sdk, opts = {}) {
  const res = await generateImageRaw(sdk, opts);
  const file = pickImageFile(res);
  if (!file) {
    const seen = pickPaths(res);
    throw new Error(seen.length
      ? `出图完成但没拿到可读的路径（只看到这些：${seen.join("、").slice(0, 160)}）`
      : `出图完成但没拿到文件（返回：${JSON.stringify(res).slice(0, 200)}）`);
  }
  return { paths: [file], raw: res };
}
