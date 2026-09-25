// core.js — 前端工具函数（B5 从 characters.js 拆出）
//
// 无副作用，所有 Tab 模块共用。

import { hana } from "../sdk.js";

// ── 工具函数 ──────────────────────────────────────────

export function toast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// 自定义确认弹窗（iframe 沙箱阻止了 window.confirm）
export function confirmDialog(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:99999;";
    const box = document.createElement("div");
    box.style.cssText = "background:var(--hana-bg,#1e1e1e);border:1px solid var(--hana-border,#333);border-radius:8px;padding:20px;min-width:300px;max-width:90vw;";
    const msg = document.createElement("p");
    msg.textContent = message;
    msg.style.cssText = "margin:0 0 16px;font-size:14px;color:var(--hana-fg,#e0e0e0);";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";
    const okBtn = document.createElement("button");
    okBtn.textContent = "确认";
    okBtn.style.cssText = "padding:6px 16px;background:#e74c3c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "取消";
    cancelBtn.style.cssText = "padding:6px 16px;background:var(--hana-border,#333);color:var(--hana-fg,#e0e0e0);border:none;border-radius:4px;cursor:pointer;font-size:13px;";
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    box.appendChild(msg);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    okBtn.onclick = () => { overlay.remove(); resolve(true); };
    cancelBtn.onclick = () => { overlay.remove(); resolve(false); };
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } };
  });
}

/**
 * 拿一个 App 内路由的完整 URL（带 appSurfaceSession）。
 *
 * 流式请求必须走这个：它要裸 fetch 一个 URL，而 session 在 URL 上，
 * hana.api.fetch 那套封装帮不上。SDK 的 api.url() 负责拼。
 */
export function apiUrl(path) {
  const fn = hana?.api?.url;
  if (typeof fn !== "function") {
    throw new Error("宿主未提供 hana.api.url：这个页面可能不在 App surface 里运行");
  }
  return fn(String(path ?? "").replace(/^\/+/, ""));
}

/**
 * 取一张 App 路由里的图片，返回一个可以直接交给 <img src> 的 blob URL。
 *
 * 为什么不能直接把 apiUrl(...) 写进 <img src>：
 *   <img> 不会自己带鉴权，而宿主对 App 路由是有校验的——真机里那条请求回的是
 *   403（日志里看得清清楚楚），URL 里连 /_surface/<票据>/ 那一段都没有。
 *   而 App 手里的 hana.api.fetch 是带鉴权的正门，用它取字节、转 blob，
 *   图片就不用自己拿着裸 URL 去撞门了。
 *
 * 用完要 revoke：卡片列表会反复重画，不回收就是一路漏内存。
 */
/** 上一张发出去的 blob URL。卡片列表一次只会显示一张，单槽够用——
 *  它的意义是“换新的之前先把旧的收回来”，不回收就是一路漏内存。 */
let lastAvatarBlob = "";

export async function apiBlobUrl(path) {
  const fn = hana?.api?.fetch;
  if (typeof fn !== "function") throw new Error("宿主未提供 hana.api.fetch");
  const res = await fn(apiUrl(path), { method: "GET" });
  if (res && res.ok === false) throw new Error(res.error || `取图失败（${res.status ?? "?"}）`);
  if (!res || typeof res.blob !== "function") throw new Error("拿回来的不是一个可读响应");
  if (res.ok === false) throw new Error(`取图失败（${res.status}）`);
  const url = URL.createObjectURL(await res.blob());
  if (lastAvatarBlob && lastAvatarBlob !== url) revokeBlobUrl(lastAvatarBlob);
  lastAvatarBlob = url;
  return url;
}

/** 把之前发出去的 blob URL 收回来。 */
export function revokeBlobUrl(url) {
  if (typeof url === "string" && url.startsWith("blob:")) {
    try { URL.revokeObjectURL(url); } catch { /* 收了就好，失败不影响别的 */ }
  }
}

/** 单次请求的超时。App 内请求都是本地回环，10 秒足够；卡住不放比失败更糟。 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * 统一的App内请求。
 *
 * 通道是宿主注入的 hana.api.fetch（见 ui/assets/sdk.js）：
 *   pluginApiFetch → ${origin}/api/apps/<appId>/routes/<path>
 * appId 从 iframe route 读，所以这里只传路由本身（如 "characters"），
 * 不要带 App id 前缀。
 *
 * 失败时把真实原因带出来——早期版本 catch 后只 throw "All fetch
 * attempts failed"，把宿主的真实报错吞掉，排查时完全抓瞎。
 */
export async function apiFetch(path, options = {}) {
  const fetchFn = hana?.api?.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("宿主未提供 hana.api.fetch：这个页面可能不在 App surface 里运行");
  }

  const p = String(path ?? "").replace(/^\/+/, "");
  let lastErr = null;
  // 先试原样，再试带前导斜杠：两种写法不同宿主版本接受度不同
  for (const candidate of [p, "/" + p]) {
    try {
      const r = await Promise.race([
        fetchFn(candidate, options),
        new Promise((_, rej) => setTimeout(() => rej(new Error("请求超时")), FETCH_TIMEOUT_MS))
      ]);
      if (r === undefined || r === null) { lastErr = new Error("宿主返回空（候选 " + candidate + "）"); continue; }
      if (typeof r.json === "function") return await r.json();
      if (typeof r === "string") return JSON.parse(r);
      return r;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error("请求失败 " + p + "：" + (lastErr?.message || lastErr || "未知原因"));
}

// 从 API 响应中提取数据数组
/**
 * 拆信封。
 *
 * 服务端统一是 `{ok:true, data}`（respond.js 的契约），而 apiFetch 返回的是
 * `r.json()`，也就是**完整信封**——它不替你拆。
 *
 * 列表类有 extractArray 兜着，单个对象就得自己拆。写漏了**不会报错**：
 * `res.name` 只是 undefined，于是预设编辑器打开是空白、预览是空的，
 * 看起来像「没有数据」而不像「代码写错了」。
 *
 * （其他模块用的是 `res.data || res` 写法，等价；这里给一个统一的名字。）
 */
export function unwrap(res) {
  if (!res || typeof res !== "object") return res;
  if (res.ok === true && "data" in res) return res.data;
  return res;
}

export function extractArray(res) {
  if (!res) return [];
  // 直接是数组
  if (Array.isArray(res)) return res;
  // { data: [] }
  if (Array.isArray(res.data)) return res.data;
  // { exports: [] }
  if (Array.isArray(res.exports)) return res.exports;
  // { items: [] }
  if (Array.isArray(res.items)) return res.items;
  // { results: [] }
  if (Array.isArray(res.results)) return res.results;
  return [];
}

export function formatDate(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

export function formatTime(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}


// ── 错误可读化 ────────────────────────────────────────


/**
 * 把一次失败转成用户能看懂的一句话。
 *

 * 为什么要这一层：apiFetch 抛出的可能是 JSON、Error、或 {error: "..."}。
 * 直接把 e 拼进 toast 会得到 "[object Object]"。统一在这里收敛，
 * 调用方只管 toast(+'保存失败: '+,"error")。
 */
export function friendlyError(e) {
  if (!e) return "未知错误";
  if (typeof e === "string") return e;
  if (typeof e.error === "string" && e.error) return e.error;
  if (Array.isArray(e.results)) {
    const failed = e.results.filter(r => r && r.ok === false);
    if (failed.length > 0) {
      const first = failed[0].error || failed[0].name || "未知";
      return failed.length === 1 ? first : first + "（等 " + failed.length + " 条）";
    }
  }
  if (typeof e.message === "string" && e.message) return e.message;
  if (typeof e.detail === "string" && e.detail) return e.detail;
  try { return JSON.stringify(e); } catch { return String(e); }
}