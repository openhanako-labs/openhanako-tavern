// rail.js — Hana 左栏（functionPanel）里的角色 / 对话导航
//
// 与 card 页（characters.html）是两个独立 surface（不同 iframe），
// 但同源同在 /api/apps/eleckoi-tavern/ 下 —— localStorage 共享，
// storage 事件跨 iframe 触发。导航就用这条通道：
//   rail 写 {t, id, ts}，card 页收到后打开对应对话。
//
// 为什么不用 bus / appEvents：那些是 App↔宿主 / App↔Agent 的通道，
// 同一个 App 的两个自己的 surface 之间没有直连消息，localStorage
// 是同源下最可靠的一条。

import { hana } from "./sdk.js";

const API = (p, init) => hana.api.fetch(p, init);
const BUS_KEY = "eleckoi:nav";
const ACTIVE_KEY = "eleckoi:active-conv";
const HEARTBEAT_KEY = "eleckoi:rail-alive";

let chars = [];
let convs = [];
let activeConv = null;
let query = "";

const $ = (id) => document.getElementById(id);

async function apiJson(p, init) {
  const r = await API(p, init);
  const data = (typeof r?.json === "function") ? await r.json() : r;
  // 后端 route() 统一把响应包成 {ok, data}；本文件旧版裸判 Array.isArray，
  // 结果请求明明成功、永远走不进数组分支，空态就是这么演了三帧。
  // 主区 core.js 的 extractArray 处理同一件事——两边各写一份的教训：
  // 同一个响应格式，解析假设必须同一个。
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.results)) return data.results;
  return data;
}

/** 主题跟随宿主。 */
function applyTheme() {
  try {
    const snap = hana?.theme?.getSnapshot?.();
    const dark = snap?.mode === "dark" || snap?.appearance === "dark";
    document.body.classList.toggle("t-dark", !!dark);
    hana?.theme?.subscribe?.((s) => {
      document.body.classList.toggle("t-dark", s?.mode === "dark" || s?.appearance === "dark");
    });
  } catch { /* 主题拿不到就用默认亮 */ }
}

/** 告诉 card 页：左栏活着，你不用显示自己的兜底侧栏。 */
function beat() {
  try { localStorage.setItem(HEARTBEAT_KEY, String(Date.now())); } catch { /* ignore */ }
}

/** 发导航意图。 */
function nav(payload) {
  try {
    localStorage.setItem(BUS_KEY, JSON.stringify({ ...payload, ts: Date.now() }));
  } catch { /* ignore */ }
}

// ── 数据 ──────────────────────────────────────────────

async function loadChars() {
  try {
    const params = query ? `?q=${encodeURIComponent(query)}` : "";
    const list = await apiJson(`characters${params}`);
    chars = Array.isArray(list) ? list : [];
  } catch { chars = []; }
  renderChars();
}

async function loadConvs() {
  try {
    const list = await apiJson("conversations");
    convs = (Array.isArray(list) ? list : [])
      .filter(c => !query
        || (c.title || "").toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, 24);
  } catch { convs = []; }
  renderConvs();
}

// ── 渲染 ──────────────────────────────────────────────

function renderChars() {
  const el = $("chars");
  if (!el) return;
  if (chars.length === 0) {
    el.innerHTML = `<div class="empty">${query ? "没匹配的角色" : "还没有角色卡"}</div>`;
    return;
  }
  el.innerHTML = chars.map(c => `
    <div class="item" data-char="${c.id}" role="button" tabindex="0" title="${esc(c.name || "")}">
      ${avatar(c)}
      <div class="bd"><div class="nm">${esc(c.name || "（无名称）")}</div></div>
    </div>
  `).join("");
  el.querySelectorAll(".item").forEach(item => {
    item.addEventListener("click", () => openChar(item.dataset.char));
    // 键盘与无障碍：role=button 必须可 Tab 可回车。
    // UIA 靠它拿 Invoke——裸 div 只有 text pattern，点击派发不到，
    // nav 链看起来像断了，其实是链头没起火。
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openChar(item.dataset.char);
      }
    });
  });
}

function renderConvs() {
  const el = $("convs");
  if (!el) return;
  $("conv-n").textContent = convs.length ? String(convs.length) : "";
  if (convs.length === 0) {
    el.innerHTML = `<div class="empty">${query ? "没匹配的对话" : "还没有对话"}</div>`;
    return;
  }
  el.innerHTML = convs.map(c => `
    <div class="item ${activeConv === c.id ? "on" : ""}" data-conv="${c.id}" role="button" tabindex="0"${activeConv === c.id ? ' aria-current="true"' : ""}>
      <div class="bd">
        <div class="nm">${esc(c.title || "（无标题）")}</div>
        <div class="mt">${c.messageCount || 0} 条 · ${fmtDate(c.updatedAt)}</div>
      </div>
    </div>
  `).join("");
  el.querySelectorAll(".item").forEach(item => {
    item.addEventListener("click", () => openConv(item.dataset.conv));
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openConv(item.dataset.conv);
      }
    });
  });
}

function avatar(c) {
  // 宿主给资源路径；拿不到头像就用占位块，不显示碎图
  const url = hana?.api?.url ? hana.api.url(`characters/${c.id}/avatar`) : "";
  return url
    ? `<img src="${esc(url)}" alt="" onerror="this.outerHTML='<div class=ph></div>'">`
    : `<div class="ph"></div>`;
}

// ── 动作 ──────────────────────────────────────────────

/** 点角色：0 条对话直接建，1 条直接开，多条交给 card 页弹选择器。 */
async function openChar(id) {
  const mine = convs.filter(c => c.characterId === id);
  if (mine.length === 1) { openConv(mine[0].id); return; }
  if (mine.length === 0) {
    nav({ t: "new-char", id });
    return;
  }
  nav({ t: "pick-char", id });
}

function openConv(id) {
  activeConv = id;
  try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* ignore */ }
  renderConvs();
  nav({ t: "open-conv", id });
}

// ── 工具 ──────────────────────────────────────────────

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

// ── 装配 ──────────────────────────────────────────────

function bind() {
  let timer = null;
  $("q").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { query = $("q").value.trim(); loadChars(); loadConvs(); }, 200);
  });
  $("conv-refresh").addEventListener("click", () => { loadChars(); loadConvs(); });
  $("new-conv")?.addEventListener("click", () => nav({ t: "new-conv" }));
  $("new-char")?.addEventListener("click", () => nav({ t: "new-char" }));
  // 页内侧栏删了，"导入"从此只能从 rail 进——链路：nav → card 页 shell
  // 消费 import-char → 点隐藏的 file-input → change → handleImport（那条链一直活着，
  // 只是过去三个人抢着当入口却一个都没绑）。
  $("rail-import")?.addEventListener("click", () => nav({ t: "import-char" }));

  // card 页新建/删除对话后，可能通知左栏刷新
  window.addEventListener("storage", (e) => {
    if (e.key === ACTIVE_KEY && e.newValue) {
      activeConv = e.newValue;
      renderConvs();
    } else if (e.key === BUS_KEY && e.newValue) {
      try {
        const msg = JSON.parse(e.newValue);
        if (msg?.t === "rail-refresh") { loadChars(); loadConvs(); }
      } catch { /* ignore */ }
    }
  });
}

async function init() {
  if (typeof hana?.ready === "function") {
    try { await hana.ready(); } catch { /* ignore */ }
  }
  applyTheme();
  bind();
  beat();
  setInterval(beat, 5000);
  await loadChars();
  await loadConvs();
}

init();
