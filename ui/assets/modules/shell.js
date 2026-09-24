// shell.js — 一屏外壳的交互（U1）
//
// 负责三件事：
//   1. 侧栏折叠 / 展开
//   2. 抽屉（设定库 / 变量 / 预设 / 工具 / 迁移）的开合，互斥单开
//   3. 点角色卡 = 开聊；只有一个存档就直接进，多个则弹选择器
//
// 为什么单独一个模块：这些是"导航层"的事，与 chat / characters 的
// 业务渲染无关。混在 main.js 里会让装配层越来越像第二个 main。

import { dom, DRAWERS } from "./dom.js";
import { state } from "./state.js";
import { apiFetch, extractArray, toast, friendlyError, escapeHtml } from "./core.js";
import { onNavigation, askRailRefresh, setActiveConv, railAlive } from "./nav-bus.js";

/** 当前打开的抽屉名；null = 都关着。 */
let openDrawerName = null;

// ── 侧栏折叠 ──────────────────────────────────────────

/**
 * 折叠 / 展开侧栏。幂等。
 *
 * roomy 态下（抽屉开着）用户手动展开，说明他想同时看两边——
 * 那就尊重他，把 roomy 撤掉，房间让给用户自己分配。
 */
export function toggleSidebar(force) {
  if (!dom.shellEl) return;
  const collapsed = force !== undefined ? force : !dom.shellEl.classList.contains("collapsed");
  dom.shellEl.classList.toggle("collapsed", collapsed);
  // 用户动过一次手，就记住是他的人——自动让位逻辑不再插手
  dom.shellEl.dataset.sidebarManual = collapsed ? "1" : "1";
  if (!collapsed) dom.shellEl.classList.remove("roomy", "no-rail");
  try { localStorage.setItem("eleckoi:sidebar-collapsed", collapsed ? "1" : "0"); } catch { /* 隐身模式 */ }
}

/** 恢复上次的侧栏状态。 */
function restoreSidebar() {
  let saved = null;
  try { saved = localStorage.getItem("eleckoi:sidebar-collapsed"); } catch { /* ignore */ }
  if (saved === "1") toggleSidebar(true);
}

// ── 抽屉 ──────────────────────────────────────────────

/**
 * 打开一个抽屉（同时关掉其它）。
 *
 * 懒加载：抽屉第一次打开时才拉数据，避免开局把五个抽屉全请求一遍。
 *
 * 打开时顺手把左栏收窄（.roomy）——抽屉是 overlay，但左栏占的 268px
 * 是实打实的宽度。聊天区本来就被左右夹着，再被抽屉盖掉一截就更窄了。
 * 用户随时能点 ‹ 把左栏放回来。
 *
 * @param {"settings"|"variables"|"presets"|"tools"|"migration"} name
 * @param {{ reload?: boolean }} [opts]
 */
export async function openDrawer(name, opts = {}) {
  const el = DRAWERS[name];
  if (!el) return;

  if (openDrawerName === name && !opts.reload) {
    closeDrawer();
    return;
  }

  // 关掉其它
  for (const [key, node] of Object.entries(DRAWERS)) {
    if (key !== name) node?.classList.add("hidden");
  }
  el.classList.remove("hidden");
  openDrawerName = name;

  // 展开右栏列：聊天区不被盖，面板从右缘滑出（grid 列宽变化即动画）
  document.querySelector("main")?.classList.add("ctx-open");
  try { localStorage.setItem("eleckoi:ctx-open", name); } catch { /* ignore */ }

  // 懒加载
  try {
    if (name === "settings") {
      const { loadSettings } = await import("./settings.js");
      await loadSettings();
    } else if (name === "variables") {
      const { loadVariables } = await import("./variables.js");
      await loadVariables();
    } else if (name === "character") {
      const { renderCharContext } = await import("./characters.js");
      await renderCharContext();
    } else if (name === "presets") {
      const { loadPresets } = await import("./presets.js");
      await loadPresets();
    } else if (name === "tools") {
      const { loadTools } = await import("./tools.js");
      await loadTools();
    } else if (name === "migration") {
      const { loadExports } = await import("./migration.js");
      await loadExports();
    }
  } catch (e) {
    toast(`加载失败: ${friendlyError(e)}`, "error");
  }
}

export function closeDrawer() {
  for (const node of Object.values(DRAWERS)) node?.classList.add("hidden");
  openDrawerName = null;
  document.querySelector("main")?.classList.remove("ctx-open");
  try { localStorage.removeItem("eleckoi:ctx-open"); } catch { /* ignore */ }
}

export function currentDrawer() {
  return openDrawerName;
}

// ── 点角色卡 = 开聊 ───────────────────────────────────

/**
 * 点角色卡的默认行为。
 *
 * 这是 U1 的核心决定：**点卡即开聊**，编辑是次要动作。
 * 依据是 08 的横向调研——类酒馆产品的主界面都是聊天，
 * 点人物就进对话；编辑藏在二级操作里。
 *
 * 一个角色可能有多条对话（多存档）：
 *   - 0 条  → 直接新建
 *   - 1 条  → 直接打开
 *   - 多条  → 弹选择器，最近更新的排前面
 */
export async function openCharacterChat(characterId) {
  if (!characterId) return;
  try {
    const convs = extractArray(await apiFetch("conversations")).filter(c => c.characterId === characterId);

    if (convs.length === 0) {
      await startNewConversation(characterId);
      return;
    }
    if (convs.length === 1) {
      const { openConversation } = await import("./chat.js");
      await openConversation(convs[0].id);
      return;
    }
    showConvPicker(characterId, convs);
  } catch (e) {
    toast(`打开失败: ${friendlyError(e)}`, "error");
  }
}

/** 给某角色直接开一条新对话（跳过选角色那一步）。 */
export async function startNewConversation(characterId, persona = {}) {
  try {
    const conv = await apiFetch("conversations", {
      method: "POST",
      body: JSON.stringify({ characterId, ...persona })
    });
    const { openConversation, loadConversations } = await import("./chat.js");
    await loadConversations();
    await openConversation(conv.id);
    return conv;
  } catch (e) {
    toast(`创建失败: ${friendlyError(e)}`, "error");
    return null;
  }
}

export async function showConvPicker(characterId, convs) {
  if (!convs || convs.length) {
    // 由调用方给列表；没给就自己去拉
  }
  return showPickerFor(characterId, convs);
}

/** 给某角色弹多存档选择器（左栏导航进来时用）。 */
export async function pickCharacter(characterId) {
  try {
    const all = extractArray(await apiFetch("conversations"));
    const mine = all.filter(c => c.characterId === characterId);
    if (mine.length === 0) { await startNewConversation(characterId); return; }
    if (mine.length === 1) {
      const { openConversation } = await import("./chat.js");
      await openConversation(mine[0].id);
      return;
    }
    await showPickerFor(characterId, mine);
  } catch (e) {
    toast(`打开失败: ${friendlyError(e)}`, "error");
  }
}

async function showPickerFor(characterId, convs) {
  const listEl = document.getElementById("conv-picker-list");
  const titleEl = document.getElementById("conv-picker-title");
  if (!listEl || !dom.convPickerEl) return;

  let name = "";
  try {
    const card = await apiFetch(`characters/${characterId}`);
    name = card?.name || "";
  } catch { /* 名字拿不到就用 id */ }

  titleEl.textContent = name ? `与「${name}」的对话` : "选择对话";
  state.pickerCharacterId = characterId;

  const sorted = [...convs].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  listEl.innerHTML = sorted.map(c => `
    <div class="picker-item" data-id="${c.id}">
      <div class="picker-title">${escapeHtml(c.title || "（无标题）")}</div>
      <div class="picker-meta">${c.messageCount || 0} 条 · ${new Date(c.updatedAt || Date.now()).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</div>
    </div>
  `).join("");

  listEl.querySelectorAll(".picker-item").forEach(item => {
    item.addEventListener("click", async () => {
      dom.convPickerEl.classList.add("hidden");
      const { openConversation } = await import("./chat.js");
      await openConversation(item.dataset.id);
    });
  });

  dom.convPickerEl.classList.remove("hidden");
}

export function closeConvPicker() {
  dom.convPickerEl?.classList.add("hidden");
  state.pickerCharacterId = null;
}

// ── 装配 ──────────────────────────────────────────────

/** 绑定一屏交互。幂等。 */
export function bindShell() {
  if (dom.shellEl?.dataset.bound === "1") return;
  if (dom.shellEl) dom.shellEl.dataset.bound = "1";

  restoreSidebar();

  dom.sidebarCollapseBtn?.addEventListener("click", () => toggleSidebar());
  dom.sidebarExpandBtn?.addEventListener("click", () => toggleSidebar(false));

  // 顶栏 ⋯ → 抽屉
  document.getElementById("app-more-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = document.getElementById("app-more-menu");
    if (menu) menu.hidden = !menu.hidden;
  });

  document.getElementById("app-more-menu")?.querySelectorAll("button[data-drawer]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.getElementById("app-more-menu").hidden = true;
      openDrawer(btn.dataset.drawer);
    });
  });

  // 点别处收起顶栏菜单
  document.addEventListener("click", (e) => {
    const menu = document.getElementById("app-more-menu");
    const btn = document.getElementById("app-more-btn");
    if (menu && !menu.hidden && !menu.contains(e.target) && e.target !== btn) menu.hidden = true;
  });

  // 抽屉关闭按钮 + Esc
  document.querySelectorAll(".drawer-close").forEach(btn => {
    btn.addEventListener("click", closeDrawer);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (openDrawerName) closeDrawer();
  });

  // 恢复上次打开的右栏面板：刷新后接着上次的位置继续改
  try {
    const saved = localStorage.getItem("eleckoi:ctx-open");
    if (saved && DRAWERS[saved]) openDrawer(saved, { reload: true });
  } catch { /* ignore */ }

  // 多存档选择器
  document.getElementById("conv-picker-close")?.addEventListener("click", closeConvPicker);
  document.getElementById("conv-picker-cancel")?.addEventListener("click", closeConvPicker);
  document.getElementById("conv-picker-new")?.addEventListener("click", async () => {
    const id = state.pickerCharacterId;
    closeConvPicker();
    if (id) await startNewConversation(id);
  });
  dom.convPickerEl?.addEventListener("click", (e) => {
    if (e.target === dom.convPickerEl) closeConvPicker();
  });

  // ── 接收左栏（functionPanel）的导航意图 ──
  onNavigation(async (msg) => {
    if (msg.t === "open-conv" && msg.id) {
      const { openConversation } = await import("./chat.js");
      await openConversation(msg.id);
    } else if (msg.t === "new-char" && msg.id) {
      await startNewConversation(msg.id);
    } else if (msg.t === "pick-char" && msg.id) {
      await pickCharacter(msg.id);
    } else if (msg.t === "import-char") {
      // rail 的导入按钮：触发隐藏 file-input，change 已由 main.js 绑好 handleImport
      dom.fileInput?.click();
    } else if (msg.t === "new-conv") {
      const { createConversation } = await import("./chat.js");
      await createConversation();
    }
  });

  // 左栏不在场时，主区得有自己的兜底侧栏——否则从 App 卡片直接进来
  // 会没有任何导航可用。左栏在场则收起，把宽度全让给聊天。
  refreshSidebarVisibility();
  setInterval(refreshSidebarVisibility, 5000);
}

/**
 * 按左栏是否在场，决定主区兜底侧栏显不显示。
 * 用户手动展开过就不插手——房间归他分。
 */
function refreshSidebarVisibility() {
  if (!dom.shellEl) return;
  const manual = dom.shellEl.dataset.sidebarManual === "1";
  if (manual) return;
  const alive = railAlive();
  dom.shellEl.classList.toggle("no-rail", alive);
}
