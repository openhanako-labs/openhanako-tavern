// lib/gen/net.js — 生成器的出网唯一入口
//
// 为什么要有这一层：App 里 globalThis.fetch 会被 AppHost 的 Node 权限模型拒掉
//（报错长得像 DNS 坏：getaddrinfo ERR_ACCESS_DENIED）。宿主给的门是
// sdk.network.fetch，白名单/私网/HTTPS/方法/超时/字节上限都由它查。
//
// 所以这里**没有回退**：拿不到 net 就明确报「出网未就绪」。
// 回退到 globalThis.fetch 只会把「门没开」伪装成「网络坏了」，那是最难查的一种错。

export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) eleckoi-tavern/0.1";

const TIMEOUT_MS = 20000;

/**
 * 造一个带来源标签的 getter。
 * @param {{fetch?: Function}|null} net 宿主的 sdk.network
 * @param {string} label 来源名（出错时要能说清是谁坏的）
 * @returns {(url: string) => Promise<{status: number, ok: boolean, text: string}>}
 */
export function makeGetter(net, label) {
  if (!net || typeof net.fetch !== "function") {
    throw new Error(`${label}：出网未就绪（宿主未提供 sdk.network.fetch）`);
  }
  const doFetch = net.fetch.bind(net);

  return async function get(url) {
    let res;
    try {
      res = await doFetch(url, {
        headers: { "user-agent": UA },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (e) {
      // 把 cause 挖出来：套着 "fetch failed" 的壳时，真正的话在 cause.code 里
      const why = e?.cause?.code || e?.cause?.message || e?.code || e?.message || String(e);
      throw new Error(`${label} 请求失败: ${why} — ${url}`);
    }
    const text = await res.text();
    return { status: res.status, ok: res.status >= 200 && res.status < 300, text };
  };
}
