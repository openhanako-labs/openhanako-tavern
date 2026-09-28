// gallery.js — 图库：本场 / 全部两级
//
// 一句话：把台账里那些图摊成一张网格，按「属于哪一级」筛，点开看大图。
//
// 两级的分界是**归属**，不是时间：
//   · 本场 —— 这一场对话里画出来的场景插图（台账里 conversationId 对得上）
//   · 全部 —— 立绘 + 所有场次的场景插图
//
// 立绘属于**角色卡**，不属于某一场。所以「本场 + 立绘」恒为空。
// 这不是 bug——空态会把这句话说出来（galleryEmptyState），
// 否则用户会在这里反复点选却永远看不到东西，还以为图库坏了。
//
// 三条实现纪律：
//   ① 字节**懒加载**。台账是轻的（路径 + 大小），字节是重的（一张 PNG 几 MB）。
//      一张 340px 的抽屉里同屏只放得下 4 张，一次要 20 张的 base64
//      等于白烧 80MB 流量。所以只有滚到可见区才去取。
//   ② 三态分开：骨架条 / 空态 / 错误态。不写「加载中…」——
//      数据回来了但确实没有时，那句话会让用户一直等（基准 5 · 第四节）。
//   ③ 空态要**教一次用法**，不是「暂无数据」。

import { apiFetch, escapeHtml, friendlyError, openImageViewer } from "./core.js";
import { dom, DRAWERS } from "./dom.js";
import { emptyHtml, errHtml } from "./drawer-state.js";
import { state } from "./state.js";
import { buildGalleryQuery, galleryEmptyState, galleryCountText } from "./gallery-query.js";

/** 一页几张。抽屉 344px、两列，20 张 = 十屏，够翻一会儿又不至于一次拉爆。 */
const PAGE = 20;

/* ─────────────────────────────────────────────────────────────
 * 两级范围与空态文案是**契约**，住在 gallery-query.js（零依赖，Node 可测）。
 * 这里是界面：把契约的结果画出来，并处理字节的来去。
 * ───────────────────────────────────────────────────────────── */



/* ─────────────────────────────────────────────────────────────
 * 模块状态
 * ───────────────────────────────────────────────────────────── */

const ui = {
  scope: "conv",
  kind: "",
  items: [],      // 当前这一级全量台账记录（轻）
  shown: 0        // 已经渲染了几张
};

/** 角色 id → 名字。立绘格子要显示「这是谁的」，光有 id 等于没显示。 */
let charNames = null;

let io = null;    // 懒加载用的 IntersectionObserver

async function ensureCharNames() {
  if (charNames) return charNames;
  charNames = new Map();
  try {
    const res = await apiFetch("characters");
    const list = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);
    for (const c of list) {
      if (c?.id) charNames.set(String(c.id), c.name || "（无名）");
    }
  } catch { /* 名字拿不到就退回显示类型与时间，不阻断看图 */ }
  return charNames;
}

function currentConvId() {
  return String(state.currentConv?.id || "").trim();
}

/** 一条记录的一行小字：它是什么、是谁的、什么时候。 */
function metaLine(rec) {
  const bits = [];
  if (rec.kind === "portrait") {
    const name = charNames?.get(String(rec.characterId || ""));
    bits.push(name ? `立绘 · ${name}` : "立绘");
  } else {
    bits.push("场景插图");
  }
  const t = String(rec.createdAt || "");
  if (t) {
    // 只取日期部分：ISO 串太长，而格子只有 150px 宽
    const d = t.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) bits.push(d);
  }
  return bits.join(" · ");
}

/**
 * 建一次观察器，之后就复用。
 *
 * 为什么用 IntersectionObserver 而不是「滚动到底再加载」：
 * 网格是两列，滚动容器就是抽屉本身；「到底」要用户一路滚完才触发，
 * 而可见区边缘那几张会一直空着。观察器是按「进入可见区」触发的，
 * 正好对上「滚到哪里加载到哪里」。
 */
function ensureObserver() {
  if (io) return io;
  if (typeof IntersectionObserver !== "function") return null;   // 老浏览器/测试环境
  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      void fillCell(e.target);
    }
  }, { root: null, rootMargin: "120px 0px" });
  return io;
}

/** 把一个格子填上真图。失败要留下话说清是哪一张、为什么——不许静默裂图。 */
async function fillCell(cell) {
  const id = cell.dataset.mediaId;
  if (!id) return;
  cell.dataset.loading = "1";
  try {
    const r = await apiFetch(`media/${encodeURIComponent(id)}`);
    const d = r?.data;
    if (r?.ok && d?.base64) {
      const img = cell.querySelector("img");
      if (img) {
        img.src = `data:${d.mime || "image/png"};base64,${d.base64}`;
        img.classList.remove("hidden");
        cell.classList.add("gal-loaded");
      }
      cell.addEventListener("click", () => openImageViewer(img.src, cell.dataset.label || ""));
    } else {
      // 台账里有、文件没了（删过文件 / 换了机器）。这话必须说出来。
      cell.classList.add("gal-broken");
      cell.title = `这张看不了：${friendlyError(d?.reason || "字节取不到")}`;
    }
  } catch (e) {
    cell.classList.add("gal-broken");
    cell.title = `这张看不了：${friendlyError(e)}`;
  } finally {
    delete cell.dataset.loading;
  }
}

function cellHtml(rec) {
  const label = escapeHtml(metaLine(rec));
  return `<div class="gal-cell" data-media-id="${escapeHtml(rec.id || "")}" data-label="${label}">
    <div class="gal-ph"><span class="gal-ph-ico">🖼</span></div>
    <img class="hidden" alt="${escapeHtml(rec.prompt || rec.scene || "图")}" draggable="false">
    <div class="gal-kind${rec.kind === "portrait" ? " is-portrait" : ""}">${rec.kind === "portrait" ? "立绘" : "场景"}</div>
    <div class="gal-meta">${label}</div>
  </div>`;
}

/** 渲染下一页。observer 在这之后统一挂。 */
function renderPage() {
  const listEl = dom.galleryListEl;
  if (!listEl) return;
  const slice = ui.items.slice(ui.shown, ui.shown + PAGE);
  if (!slice.length) return;
  ui.shown += slice.length;

  const html = slice.map(cellHtml).join("");

  if (ui.shown === slice.length) {
    // 第一页：整个容器换掉（骨架条就是在这儿被替换掉的）
    listEl.innerHTML = `<div class="gal-grid">${html}</div>`;
  } else {
    // 续页：接着往同一个网格里塞
    listEl.querySelector(".gal-grid")?.insertAdjacentHTML("beforeend", html);
  }

  // 「再看更多」：已经全显示 → 整行不显示（基准 5 · 一节 ⑥）
  if (dom.galleryMoreEl) {
    dom.galleryMoreEl.classList.toggle("hidden", ui.shown >= ui.items.length);
  }

  const ob = ensureObserver();
  if (!ob) {
    // 没有 IntersectionObserver（老环境/测试）：直接全填，总比裂图好
    listEl.querySelectorAll(".gal-cell:not([data-bound])").forEach((c) => {
      c.dataset.bound = "1";
      void fillCell(c);
    });
    return;
  }
  listEl.querySelectorAll(".gal-cell:not([data-bound])").forEach((c) => {
    c.dataset.bound = "1";
    ob.observe(c);
  });
}

function renderEmpty() {
  const listEl = dom.galleryListEl;
  if (!listEl) return;
  const s = galleryEmptyState({
    scope: ui.scope,
    kind: ui.kind,
    hasConv: !!currentConvId()
  });
  listEl.innerHTML = emptyHtml({ title: s.title, desc: s.desc, ico: s.ico });
  if (dom.galleryMoreEl) dom.galleryMoreEl.classList.add("hidden");
}

/**
 * 读一级。scope / kind 由界面上的两个 select 决定。
 *
 * 错误处理分两种，因为**下一步不一样**：
 *   · 拿不到（网络/宿主）→ 错误态 + 重试，用户等一会儿再点
 *   · 读到了但空        → 空态，教一次用法
 */
export async function loadGallery() {
  const listEl = dom.galleryListEl;
  if (!listEl) return;

  // 读之前先画骨架：抽屉打开到数据回来有几十到几百毫秒，
  // 那一瞬间容器是空的，用户会以为坏了。
  listEl.innerHTML = `<div class="gal-grid">${'<div class="gal-cell gal-skel"></div>'.repeat(4)}</div>`;
  if (dom.galleryMoreEl) dom.galleryMoreEl.classList.add("hidden");

  ui.items = [];
  ui.shown = 0;

  try {
    await ensureCharNames();
    const q = buildGalleryQuery({
      scope: ui.scope,
      kind: ui.kind,
      conversationId: currentConvId()
    });
    const res = await apiFetch(`media/index${q}`);
    const data = res?.data || res || {};
    ui.items = Array.isArray(data.records) ? data.records : [];

    if (dom.galleryCountEl) {
      const txt = galleryCountText({ scope: ui.scope, shown: Math.min(PAGE, ui.items.length), total: ui.items.length });
      dom.galleryCountEl.textContent = txt;
    }

    if (!ui.items.length) {
      renderEmpty();
      return;
    }
    renderPage();
  } catch (e) {
    listEl.innerHTML = errHtml(
      "没能读到图库",
      `${friendlyError(e)}。图还在盘上，这只是这一趟没读上来——重试一下多半就好。`
    );
    if (dom.galleryMoreEl) dom.galleryMoreEl.classList.add("hidden");
  }
}

/** 界面初始化：两个 select 各绑一次，「再看更多」绑一次。 */
export function bindGallery() {
  const drawer = DRAWERS.gallery;
  if (!drawer || drawer.dataset.bound === "1") return;
  drawer.dataset.bound = "1";

  dom.galleryScopeEl?.addEventListener("change", (e) => {
    ui.scope = e.target.value === "all" ? "all" : "conv";
    void loadGallery();
  });

  dom.galleryKindEl?.addEventListener("change", (e) => {
    ui.kind = e.target.value === "scene" || e.target.value === "portrait" ? e.target.value : "";
    void loadGallery();
  });

  dom.galleryMoreBtn?.addEventListener("click", () => { renderPage(); });
}
