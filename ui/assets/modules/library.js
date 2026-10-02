// library.js — 角色库（全页网格：搜索 / 标签 / 分页）
//
// 为什么存在：角色列表只在宿主 rail 上，而那是一根窄柱——十几张卡还能扫，
// 几十上百张就该有一个能搜索、能筛标签、能翻页的面子。
// 数据口径与 rail 相同（GET characters?q=，服务端筛文本）；标签与分页在本页做：
// 标签来自卡本身，没必要为筛标签再跑一趟服务端。
//
// 入口：rail 的「全部 N 张」（nav-bus {t:"open-library"}）+ ⋯ 菜单「角色库」。

import { apiFetch, escapeHtml, extractArray, toast, friendlyError } from "./core.js";
import { handleCharacterAction } from "./characters.js";

const PAGE_SIZE = 24;

let all = [];        // 按当前搜索词拉回来的全量（文本筛在服务端）
let tagFilter = "";  // 客户端筛
let page = 1;
let bound = false;

const $ = (id) => document.getElementById(id);

export async function openLibrary(initialQuery = "") {
  const m = $("library-modal");
  if (!m) return;
  const input = $("library-search");
  if (input && !input.value.trim() && initialQuery) input.value = initialQuery;
  m.classList.remove("hidden");
  await loadLibrary();
}

export function closeLibrary() {
  $("library-modal")?.classList.add("hidden");
}

async function loadLibrary() {
  const q = $("library-search")?.value.trim() || "";
  try {
    all = extractArray(await apiFetch("characters" + (q ? `?q=${encodeURIComponent(q)}` : "")));
    tagFilter = "";
    page = 1;
    renderTagChips();
    renderPage();
  } catch (e) {
    toast(`角色库加载失败: ${friendlyError(e)}`, "error");
  }
}

function availableTags() {
  const set = new Map();
  for (const c of all) for (const t of (c.tags || [])) set.set(t, (set.get(t) || 0) + 1);
  return [...set.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
}

function renderTagChips() {
  const el = $("library-tags");
  if (!el) return;
  const tags = availableTags();
  el.innerHTML = tags.length === 0 ? "" :
    `<button class="lib-tag${tagFilter === "" ? " on" : ""}" data-tag="">全部</button>` +
    tags.map(([t, n]) =>
      `<button class="lib-tag${tagFilter === t ? " on" : ""}" data-tag="${escapeHtml(t)}">${escapeHtml(t)} <i>${n}</i></button>`
    ).join("");
  el.querySelectorAll(".lib-tag").forEach(btn => {
    btn.addEventListener("click", () => {
      tagFilter = btn.dataset.tag || "";
      page = 1;
      renderTagChips();
      renderPage();
    });
  });
}

function filtered() {
  return tagFilter ? all.filter(c => (c.tags || []).includes(tagFilter)) : all;
}

function renderPage() {
  const list = filtered();
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  page = Math.min(page, pages);
  const from = (page - 1) * PAGE_SIZE;
  const rows = list.slice(from, from + PAGE_SIZE);

  const count = $("library-count");
  if (count) count.textContent = list.length > 0 ? `${list.length} 张` : "";
  const pager = $("library-pager");
  if (pager) {
    pager.innerHTML = `
      <button class="pager-btn" id="library-prev" ${page <= 1 ? "disabled" : ""}>‹</button>
      <span class="lib-page">${page} / ${pages}</span>
      <button class="pager-btn" id="library-next" ${page >= pages ? "disabled" : ""}>›</button>`;
    $("library-prev")?.addEventListener("click", () => { page--; renderPage(); });
    $("library-next")?.addEventListener("click", () => { page++; renderPage(); });
  }

  const grid = $("library-grid");
  if (!grid) return;
  if (rows.length === 0) {
    const q = $("library-search")?.value.trim();
    grid.innerHTML = `<div class="empty">没有匹配的角色卡${q ? "——换个搜索词试试" : ""}</div>`;
    return;
  }
  grid.innerHTML = rows.map(c => {
    // 与抽屉卡片同一套信息层级：描述为空退到开场白，一排「（无描述）」等于没有信息
    const desc = String(c.description || "").trim() || String(c.first_mes || "").trim();
    const descHtml = desc
      ? `<div class="card-desc">${escapeHtml(desc.slice(0, 120))}</div>`
      : `<div class="card-desc is-empty">还没有描述</div>`;
    const tags = (c.tags || []).slice(0, 3).map(t => `<span>${escapeHtml(t)}</span>`).join("");
    return `
    <div class="card lib-card" data-id="${escapeHtml(String(c.id))}">
      <div class="card-header">
        <h3>${escapeHtml(c.name || "（未命名）")}</h3>
        <span class="card-date">${c.has_book ? "带世界书" : ""}</span>
      </div>
      ${descHtml}
      ${tags ? `<div class="card-tags">${tags}</div>` : ""}
      <div class="card-actions">
        <button class="btn-sm" data-act="chat">开聊</button>
        <button class="btn-sm" data-act="edit">编辑</button>
        <button class="btn-sm" data-act="export">导出</button>
        <button class="btn-sm danger" data-act="delete">删除</button>
      </div>
    </div>`;
  }).join("");

  grid.querySelectorAll(".lib-card").forEach(card => {
    const id = card.dataset.id;
    card.querySelector('[data-act="chat"]')?.addEventListener("click", async () => {
      const { startNewConversation } = await import("./shell.js");
      closeLibrary();
      await startNewConversation(id);
    });
    // 编辑是另一张全屏弹窗：先把库收起来，回来时数据由各自动作刷新
    card.querySelector('[data-act="edit"]')?.addEventListener("click", () => {
      closeLibrary();
      handleCharacterAction("edit", id);
    });
    card.querySelector('[data-act="export"]')?.addEventListener("click", () => handleCharacterAction("export", id));
    card.querySelector('[data-act="delete"]')?.addEventListener("click", async () => {
      await handleCharacterAction("delete", id);
      await loadLibrary(); // 删完就地刷新网格，不关库
    });
  });
}

export function bindLibrary() {
  if (bound) return;
  bound = true;
  $("library-close")?.addEventListener("click", closeLibrary);
  $("library-modal")?.addEventListener("click", (e) => { if (e.target.id === "library-modal") closeLibrary(); });
  let timer = null;
  $("library-search")?.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => loadLibrary(), 250);
  });
}
