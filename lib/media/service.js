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

/** 只有绝对路径才拿得到文件；裸文件名只能当报错时的线索。 */
export function isAbsolutePath(p) {
  return typeof p === "string" && /^[a-zA-Z]:[\\/]/.test(p);
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

  const file = pickImageFile(res);
  if (!file) {
    const seen = pickPaths(res);
    throw new Error(seen.length
      ? `出图完成但没拿到可读的路径（只看到这些：${seen.join("、").slice(0, 160)}）`
      : `出图完成但没拿到文件（返回：${JSON.stringify(res).slice(0, 200)}）`);
  }
  return { paths: [file], raw: res };
}
