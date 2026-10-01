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

// 头像 blob 缓存。avatar.json 一次回一张 base64——重画列表再拉一遍就把
// 内存一路抬起来，也白跑一次请求。key 统一字符串化，避免 1 vs "1"。
const avatarCache = new Map();

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
  // 卡列表也要重画：卡项那行「N 场 · 最近 …」依赖 convs。
  // 只画对话列表的话，卡片会一直停在"还没开过"——比不显示更糟。
  renderChars();
}

// ── 渲染 ──────────────────────────────────────────────

function renderChars() {
  const el = $("chars");
  if (!el) return;
  if (chars.length === 0) {
    el.innerHTML = `<div class="empty">${query ? "没匹配的角色" : "还没有角色卡"}</div>`;
    return;
  }
  el.innerHTML = chars.map(c => {
    // 点这张卡会发生什么，**点之前就要能看出来**：
    // 1 场 → 直接续；0 场 → 开新场；多条 → 弹选择器（openChar 的事）。
    // 不写这一行，三种行为在界面上长得一模一样。convs 已按 updatedAt 倒序，取 [0] 就是最近那场。
    const mine = convs.filter(x => x.characterId === c.id);
    const meta = mine.length
      ? `${mine.length} 场 · 最近 ${fmtDate(mine[0].updatedAt)}`
      : "还没开过 · 点一下开演";
    return `
    <div class="item" data-char="${c.id}" role="button" tabindex="0" title="${esc(c.name || "")}">
      ${avatar(c)}
      <div class="bd">
        <div class="nm">${esc(c.name || "（无名称）")}</div>
        <div class="mt">${meta}${c.has_book ? " · 带世界书" : ""}</div>
      </div>
    </div>
  `;
  }).join("");
  hydrateAvatars(el);
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
      <button class="conv-del" data-del="${c.id}" title="删除这场对话" aria-label="删除这场对话">✕</button>
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
  // 删除：stopPropagation 别触发 openConv。
  // 确认用两步内联（✕ → 确认? → 再点才删，3s 不点回弹）——
  // window.confirm 在 iframe 沙箱里被禁（返回 undefined → 直接 return），
  // 就是“删除点了没效果”的原因；core.js 的 confirmDialog 在 card 页那个
  // iframe，rail 这边跨不过去，所以只能本地两步。
  el.querySelectorAll(".conv-del").forEach(btn => {
    const armed = () => btn.dataset.armed === "1";
    const disarm = () => { delete btn.dataset.armed; btn.textContent = "✕"; btn.title = "删除这场对话"; };
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!armed()) {
        btn.dataset.armed = "1";
        btn.textContent = "确认？";
        btn.title = "再点一次确认删除";
        setTimeout(() => { if (btn.isConnected && armed()) disarm(); }, 3000);
        return;
      }
      disarm();
      void deleteConv(btn.dataset.del);
    });
  });
}

async function deleteConv(id) {
  try {
    await API(`conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (err) {
    console.error("[rail] 删除对话失败:", err);
    window.alert("删除失败，请重试");
    return;
  }
  const wasActive = String(activeConv) === String(id);
  convs = convs.filter(c => String(c.id) !== String(id));
  if (wasActive) {
    activeConv = null;
    try { localStorage.removeItem(ACTIVE_KEY); } catch { /* ignore */ }
  }
  renderConvs();
  renderChars();
  // 删的是当前正看的那场：通知 card 页回空态（它自己清 state.currentConv）。
  // 没在看就只发刷新——card 页的 state 不被动。
  if (wasActive) {
    nav({ t: "conv-deleted", id });
  } else {
    nav({ t: "rail-refresh" });
  }
}

function avatar(c) {
  // 先画首字母——图没回来就它站着，图回来了再换掉。
  // <img> 直接拿裸 App URL 会 403（rail 与 card 两个 iframe 都一样）：
  // 请求 URL 里没有 /_surface/<票据>/ 那一段，<img> 又不会自己带鉴权。
  // 所以走 hana.api.fetch 取 JSON 的 base64、自己拼 Blob，
  // 与 card 页那条已验证的路径同一个方向。
  //
  // 用 .ph 而不是 .ava：这一版是**占位**（首字母），拉到了图才升为 .ava。
  // 类名跟着"现在能看见什么"走，而不是"最终会长成什么"。
  const id = String(c?.id || "");
  const initial = esc((String(c?.name || "?").trim().slice(0, 1) || "?"));
  const cached = avatarCache.get(id);
  if (cached) return `<img class="ava" src="${cached}" alt="" data-ava-id="${esc(id)}">`;
  // 首次渲染：先挂占位，然后 hydrateAvatars 会把它换成 img。
  return `<div class="ph" data-ava-id="${esc(id)}">${initial}</div>`;
}

/**
 * 把首字母占位换成真图。失败就保持字母——
 * rail 里一行一失败弹一次 toast 会把屏幕堆满。
 *
 * 为什么把 img 元素先建出来再 hydrate：一次 fetch 期间列表可能被重新渲染
 *（比如 storage 事件触发），旧 img 已经被移除——所以只按 data-ava-id 找
 * 到当前还活着的元素，找不到就什么都不做，不留回调尾巴。
 */
function hydrateAvatars(root) {
  root.querySelectorAll("[data-ava-id]").forEach((el) => {
    const id = el.getAttribute("data-ava-id");
    el.removeAttribute("data-ava-id");
    hydrateAvatar(el, id);
  });
}

function hydrateAvatar(el, id) {
  const useUrl = (url) => {
    // el 可能已经不在文档里（列表被重画）
    if (!el.isConnected) return;
    const img = document.createElement("img");
    img.className = "ava";
    img.alt = "";
    img.src = url;
    el.replaceWith(img);
  };

  if (avatarCache.has(id)) {
    useUrl(avatarCache.get(id));
    return;
  }

  void (async () => {
    try {
      const env = await API(`characters/${encodeURIComponent(id)}/avatar.json`);
      const r = (typeof env?.json === "function") ? await env.json() : env;
      // 后端统一是 {ok, data}，也可能直接回裸对象；两边都接。
      const data = (r && typeof r === "object" && r.ok === true && "data" in r) ? r.data : r;
      const b64 = data?.base64;
      if (typeof b64 !== "string" || !b64) throw new Error("没拿到 base64");
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: data?.mime || "image/png" }));
      avatarCache.set(id, url);
      useUrl(url);
    } catch {
      // 保持首字母。这一层不做错误上报：rail 是常驻面板，
      // 报错会污染 console 但没有对应的用户动作——用户看到的就是一个字母。
    }
  })();
}

// ── 动作 ──────────────────────────────────────────────

/** 点角色：0 条对话直接建，1 条直接开，多条交给 card 页弹选择器。 */
async function openChar(id) {
  const mine = convs.filter(c => c.characterId === id);
  if (mine.length === 1) { openConv(mine[0].id); return; }
  if (mine.length === 0) {
    nav({ t: "new-conv-for", id });
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
  // 「⋯」切换：把低频项收进这个菜单（见 rail.html 的注释）。
  // 不开时菜单默认 hidden，开了就展开；关掉后不自动收，用户可以点外层关。
  const moreBtn = $("rail-more");
  const moreMenu = $("rail-more-menu");
  if (moreBtn && moreMenu) {
    moreBtn.addEventListener("click", () => {
      moreMenu.classList.toggle("hidden");
      moreBtn.setAttribute("aria-expanded", moreMenu.classList.contains("hidden") ? "false" : "true");
    });
  }
  $("new-conv")?.addEventListener("click", () => nav({ t: "new-conv" }));
  $("new-char")?.addEventListener("click", () => nav({ t: "new-char" }));
  // 页内侧栏删了，"导入"从此只能从 rail 进——链路：nav → card 页 shell
  // 消费 import-char → 点隐藏的 file-input → change → handleImport（那条链一直活着，
  // 只是过去三个人抢着当入口却一个都没绑）。
  $("rail-import")?.addEventListener("click", () => nav({ t: "import-char" }));
  // AI 生成：左栏只管发意图，生成台在主视图（跨 iframe 走后巷消息总线）
  $("gen-open")?.addEventListener("click", () => nav({ t: "gen-open" }));

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
