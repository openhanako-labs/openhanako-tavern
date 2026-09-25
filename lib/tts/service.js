// lib/tts/service.js — 真的去要一段声音
//
// ## 出网有两扇门，为什么两扇都要试
//
// 宿主给 App 的正门是 `sdk.network.fetch`：它受 manifest 的域名白名单管着，
// 白名单里的域名随 manifest 一起交付、也随它一起被用户复核。
// 这条规矩对**固定供应商**没问题（微软的地址是固定的），
// 但对"用户自己填 API 地址"就不好使了——他填的地址没人在白名单里写过。
//
// 另一扇是 App 运行时自己的网络（`app/runtime.network`，这个 App 已获授权）。
// 本机跑的服务（loopback）走的就是这扇门。
//
// 所以这里的策略是：**先敲正门，正门不开再走侧门，两扇都关就把两句话都写出来**。
// 不猜哪扇是开的——猜错的那次会以一句"请求失败"的形态出现在用户面前，
// 而真正的原因（门没开）被吞掉了。

import { buildRequest, clampText, normalizeMime, TEXT_MAX } from "./providers.js";
import { readiness } from "./config.js";

/** 一次网络尝试的超时。语音合成慢，但也慢不到一分钟。 */
const TIMEOUT_MS = 60000;

function snippet(s, n = 200) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function who(e) {
  return e?.cause?.code || e?.cause?.message || e?.code || e?.message || String(e);
}

/**
 * 造一个"两扇门都会试"的 fetch。
 *
 * @param {object|null} sdk 宿主 SDK（有 network.fetch 就是正门）
 * @returns {(url: string, init: object) => Promise<Response>}
 */
export function makeFetch(sdk) {
  const hostFetch = sdk && typeof sdk.network?.fetch === "function"
    ? (url, init) => sdk.network.fetch(url, init)
    : null;
  const runtimeFetch = typeof globalThis.fetch === "function"
    ? (url, init) => globalThis.fetch(url, init)
    : null;

  return async (url, init) => {
    if (hostFetch) {
      try {
        return await hostFetch(url, init);
      } catch (e) {
        // 正门不开（白名单没放行 / 宿主没给）——记下原因，接着敲侧门
        if (!runtimeFetch) {
          throw new Error(`出网被宿主的白名单拦下（${who(e)}），且没有可用的本机网络通道`);
        }
        try {
          return await runtimeFetch(url, init);
        } catch (e2) {
          throw new Error(
            `两扇门都没开。宿主白名单：${who(e)}；本机运行时：${who(e2)}。` +
            `固定供应商请把域名加进 manifest 的 network.allowedHosts；本机服务请确认它真的在跑。`
          );
        }
      }
    }
    if (!runtimeFetch) throw new Error("这个环境里没有任何可用的网络通道");
    return runtimeFetch(url, init);
  };
}

/**
 * 合成一段语音。返回音频字节，不落盘（落盘是路由的事）。
 *
 * @param {{config: object, text: string, sdk?: object, fetchImpl?: Function}} args
 * @returns {Promise<{buffer: Buffer, mime: string, ext: string, provider: string, voice: string, chars: number, truncated: number}>}
 */
export async function synthesize({ config, text, sdk = null, fetchImpl = null } = {}) {
  const r = readiness(config);
  if (!r.ready) throw new Error(`语音还没配好：${r.reason}`);

  const { text: body, truncated } = clampText(text);
  if (!body) throw new Error("没有要读的文字");

  const req = buildRequest(config, body);
  const doFetch = fetchImpl || makeFetch(sdk);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await doFetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: ac.signal
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`连不上语音服务（${who(e)}）：${req.url}`);
  }
  clearTimeout(timer);

  if (!res || typeof res.ok !== "boolean") {
    throw new Error("语音服务没有回一个正常的响应对象");
  }

  if (!res.ok) {
    // 供应商把原因写在 body 里（key 错、region 错、声音名不存在都在那儿），
    // 只报一个状态码等于让用户去猜。
    let detail = "";
    try {
      detail = snippet(await res.text());
    } catch { /* 读不出就算了，至少还有状态码 */ }
    throw new Error(`语音服务回了 ${res.status}${detail ? "：" + detail : ""}`);
  }

  const ab = await res.arrayBuffer();
  const buffer = Buffer.from(ab);
  if (buffer.length === 0) throw new Error("语音服务回了 0 字节——不是成功");

  const mime = normalizeMime(res.headers?.get?.("content-type"), req.mime);

  return {
    buffer,
    mime,
    ext: mime === "audio/wav" ? "wav" : req.ext,
    provider: req.provider,
    voice: req.voice,
    chars: body.length,
    truncated
  };
}

export { TEXT_MAX };
