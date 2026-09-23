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

export async function apiFetch(path, options = {}) {
  const attempts = [
    () => hana?.api?.fetch?.(path, options),
    () => hana?.api?.fetch?.("/" + path, options),
  ];

  for (const attempt of attempts) {
    if (typeof attempt !== "function") continue;
    try {
      const r = await Promise.race([
        attempt(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("fetch timeout")), FETCH_TIMEOUT_MS)),
      ]);
      if (r) {
        // Response 对象 — 需要解析 body
        if (typeof r.json === "function") {
          return await r.json();
        }
        if (typeof r === "string") return JSON.parse(r);
        if (typeof r === "object") return r;
      }
    } catch (e) {
      console.error("apiFetch error:", e);
    }
  }
  throw new Error("All fetch attempts failed");
}

// 从 API 响应中提取数据数组
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