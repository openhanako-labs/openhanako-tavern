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
// 返回的 files 是 unknown[]（契约里没写死形状）。这里不假设它长什么样：
// 字符串当路径收，对象里找 path / filePath / localPath，其余丢掉。
// 挑不出来就报"宿主没回文件"，而不是把一个空数组当成成功。

const PROMPT_MAX = 800;

/** 把 files 里的每一项尽量读成一个路径。读不出来的返回 null。 */
export function pickPaths(files) {
  const out = [];
  for (const f of Array.isArray(files) ? files : []) {
    if (typeof f === "string" && f.trim()) { out.push(f.trim()); continue; }
    if (f && typeof f === "object") {
      const p = f.path || f.filePath || f.localPath || f.absolutePath;
      if (typeof p === "string" && p.trim()) out.push(p.trim());
    }
  }
  return out;
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
 * 生成一张图，返回本地文件路径。
 *
 * @param {object} sdk 宿主 SDK（要有 sdk.media.generateImage）
 * @param {{prompt: string, suggestedFilename?: string, options?: object}} args
 * @returns {Promise<{paths: string[], raw: object}>}
 */
export async function generateImage(sdk, { prompt, suggestedFilename, options } = {}) {
  const st = status(sdk);
  if (!st.available) throw new Error(`出图未就绪：${st.reason}`);

  const text = String(prompt ?? "").trim();
  if (!text) throw new Error("prompt is required");
  if (text.length > PROMPT_MAX) throw new Error(`提示词太长（${text.length} > ${PROMPT_MAX}）`);

  let res;
  try {
    res = await sdk.media.generateImage({
      scope: "app",
      input: {
        prompt: text,
        ...(suggestedFilename ? { suggestedFilename: String(suggestedFilename).slice(0, 60) } : {}),
        // 必须是 response：应用域不让走异步交付（宿主会直接抛）
        delivery: { mode: "response", ...(options?.ttlMs ? { ttlMs: options.ttlMs } : {}) },
        ...(options && typeof options === "object" ? { options } : {})
      }
    });
  } catch (e) {
    // 挖 cause：套着 "fetch failed" 的壳时，真话在 cause 里
    const why = e?.cause?.code || e?.cause?.message || e?.code || e?.message || String(e);
    throw new Error(`出图失败：${why}`);
  }

  if (res && res.ok === false) throw new Error(`出图失败：${res.error || res.status || "宿主没给原因"}`);

  const paths = pickPaths(res?.files);
  if (paths.length === 0) {
    throw new Error(`出图完成但没拿到文件（返回：${JSON.stringify(res).slice(0, 200)}）`);
  }
  return { paths, raw: res };
}
