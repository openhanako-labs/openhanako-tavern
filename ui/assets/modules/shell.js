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
import { onNavigation, askRailRefresh, setActiveConv } from "./nav-bus.js";

/** 当前打开的抽屉名；null = 都关着。 */
let openDrawerName = null;

/**
 * 「设置」这一格收着哪几个抽屉。
 *
 * 左轨合并（预设 / 正则 / 工具 / 迁移 → 设置）：四项各占一格是在用
 * 一等位置放三等入口。但**抽屉本身一个没动**——openDrawer 照旧按
 * 名字开，少的只是一个入口。顶栏 ⋯ 菜单里那八个也原样还在。
 */
const CFG_DRAWERS = ["presets", "regex", "tools", "migration"];

/**
 * 黑板列开着吗。
 *
 * 世界不是抽屉了：它常驻在聊天左边（卡里的形状），
 * 默认收起、由顶栏入口与「世界 N 格」那颗按钮开关。
 */
export function boardColumnOpen() {
  return !!document.querySelector("main")?.classList.contains("board-open");
}

export function toggleBoardColumn(force) {
  const main = document.querySelector("main");
  if (!main) return false;
  const open = typeof force === "boolean" ? force : !main.classList.contains("board-open");
  main.classList.toggle("board-open", open);
  try {
    if (open) localStorage.setItem("eleckoi:board-open", "1");
    else localStorage.removeItem("eleckoi:board-open");
  } catch { /* 隐私模式下写不了，不影响这一屏 */ }
  syncTabs();
  // 展开时顺手拉一次：格子数据本来就在开局与每轮生成后重拉，
  // 这里是“刚点开就看见旧值”那一瞬的兜底。
  if (open) import("./board.js").then((m) => m.loadBoard()).catch(() => {});
  return open;
}

/**
 * PANEL_TITLES 与 syncPanelTitle 已随抬头条一起删——抬头条和抽屉自带的
 * drawer-head 是同一句标题说两遍。抽屉自己的头（标题 + ✕）就是认路标记。
 */

/**
 * 高亮跟着当前面板走。
 *
 * 选择器从「#ctx-tabs .ctx-tab, #topnav .topnav-item」改成「#apprail .rail-item」：
 * 2026-09-27 重设计把两套导航合成了一套，#ctx-tabs 与 .topnav-item 已不存在。
 * 换言之——这里原本要找两份、现在只有一份，**数量少了是目的，不是遗漏**。
 */
function syncTabs() {
  const boardOn = boardColumnOpen();
  document.querySelectorAll("#apprail .rail-item").forEach((btn) => {
    const key = btn.dataset.drawer || (btn.id === "topnav-chat" ? "chat" : null);
    let on = false;
    // 「对话」= 右栏没开面板。黑板列开不开不影响它——聊天区一直在。
    if (key === "chat") on = !openDrawerName;
    // 「世界」也不看 openDrawerName：黑板列与右栏是**两列**，可以同时开着
    //（开一场对话会自动站出角色面板，那时世界列常常还开着）。
    else if (key === "board") on = boardOn;
    // 「设置」是四个低频入口的合集：里面任意一个开着，它就亮。
    else if (btn.id === "cfg-open") on = CFG_DRAWERS.includes(openDrawerName);
    else on = !!openDrawerName && key === openDrawerName;
    btn.classList.toggle("on", on);
  });
  syncRailBadges();
}

/**
 * 左轨角标：世界有几格。
 *
 * 数据源与顶栏那颗「世界 N 格」按钮**同一个**（state.boardWorld + state.boardChat）——
 * 两处显示同一个事实，就必须读同一个来源，否则迟早一个说 3 一个说 0。
 *
 * 三条：
 *   ① 认不出来（boardChat 还不是数组）→ 整颗不渲染。挂「0」会被读成
 *      「这一场真的没有格子」，而真相是「还没拉到」。
 *   ② 0 格也不渲染 —— 一个永远写着 0 的徽标是噪音。
 *   ③ 幂等：重复调用只是重写同一颗，不叠加。
 */
function syncRailBadges() {
  const btn = document.querySelector('#apprail .rail-item[data-drawer="board"]');
  if (!btn) return;
  const known = Array.isArray(state.boardChat);
  const cells = (state.boardWorld?.length || 0) + (state.boardChat?.length || 0);
  let badge = btn.querySelector(".rail-badge");
  if (!known || cells === 0) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("i");
    badge.className = "rail-badge";
    btn.appendChild(badge);
  }
  badge.textContent = String(cells);
}

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
 * @param {"character"|"settings"|"board"|"variables"|"presets"|"regex"|"gallery"|"tools"|"migration"|"codex"} name
 * @param {{ reload?: boolean }} [opts]
 */
export async function openDrawer(name, opts = {}) {
  // 世界不是抽屉了：它常驻在聊天左边（卡里的形状）。
  // 保留 'board' 这个 key，是为了让顶栏与 ⋯ 菜单里原有的入口照旧能用。
  if (name === "board") {
    toggleBoardColumn();
    return;
  }

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
  syncTabs();

  // 展开右栏列：聊天区不被盖，面板从右缘滑出（grid 列宽变化即动画）
  document.querySelector("main")?.classList.add("ctx-open");
  try { localStorage.setItem("eleckoi:ctx-open", name); } catch { /* ignore */ }

  // 懒加载
  try {
    if (name === "settings") {
      const { loadSettings } = await import("./settings.js");
      await loadSettings();
    } else if (name === "director") {
      const { loadDirectors } = await import("./director.js");
      await loadDirectors();
    } else if (name === "variables") {
      const { loadVariables } = await import("./variables.js");
      await loadVariables();
    } else if (name === "character") {
      const { renderCharContext } = await import("./characters.js");
      await renderCharContext();
    } else if (name === "presets") {
      const { loadPresets } = await import("./presets.js");
      await loadPresets();
    } else if (name === "regex") {
      const { loadRegexRules } = await import("./regex.js");
      await loadRegexRules();
    } else if (name === "gallery") {
      const { loadGallery, bindGallery } = await import("./gallery.js");
      bindGallery();
      await loadGallery();
    } else if (name === "tools") {
      const { loadTools } = await import("./tools.js");
      await loadTools();
    } else if (name === "migration") {
      const { loadExports } = await import("./migration.js");
      await loadExports();
    } else if (name === "codex") {
      const { bindCodex, loadCodex } = await import("./codex.js");
      bindCodex();
      await loadCodex();
    } else if (name === "ops") {
      const { bindOps, loadOps } = await import("./ops.js");
      bindOps();
      await loadOps();
    }
  } catch (e) {
    toast(`加载失败: ${friendlyError(e)}`, "error");
  }
}

export function closeDrawer() {
  for (const node of Object.values(DRAWERS)) node?.classList.add("hidden");
  openDrawerName = null;
  syncTabs();
  document.querySelector("main")?.classList.remove("ctx-open");
  try { localStorage.removeItem("eleckoi:ctx-open"); } catch { /* ignore */ }
}

export function currentDrawer() {
  return openDrawerName;
}

/**
 * 「设置」浮层。
 *
 * 位置实时算，而不是 CSS 里定死：左轨会被收起来（--rail-w 从 66 变 46），
 * 按钮的坐标是活的。先显示再量高度——hidden 时 offsetHeight 是 0。
 */
function toggleCfgMenu() {
  const menu = document.getElementById("cfg-menu");
  const btn = document.getElementById("cfg-open");
  if (!menu || !btn) return;
  if (!menu.hidden) { closeCfgMenu(); return; }
  menu.hidden = false;
  const r = btn.getBoundingClientRect();
  // 底部留出菜单自身的高度，别让它从窗口下沿掉出去
  menu.style.top = `${Math.min(r.top, window.innerHeight - menu.offsetHeight - 12)}px`;
  menu.style.left = `${r.right + 8}px`;
  btn.setAttribute("aria-expanded", "true");
}

function closeCfgMenu() {
  const menu = document.getElementById("cfg-menu");
  if (menu) menu.hidden = true;
  document.getElementById("cfg-open")?.setAttribute("aria-expanded", "false");
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
    // 左栏「最近会话」同步刷新——新建后列表不更新是月曦夜点出的状态不同步
    // （操作 A：点头像开新场，主界面更新了但左栏没刷）。
    askRailRefresh();
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

  // 首屏就把高亮算一次。
  //
  // 以前没人叫它：只有 openDrawer / toggleBoardColumn / 开聊时才会跑，
  // 而首屏默认状态（右栏没开、黑板列关着）恰好就是“对话高亮”，
  // 于是看上去像正常——直到导航搬到左轨，这一条空得刺眼。
  syncTabs();

  // 早先这里绑过#sidebar-collapse / #sidebar-expand 两个按钮——
  // 页内侧栏删了之后它们就不存在了，只剩下 dom.js 里两个 null 与这里两行死引用。
  // Ctrl/Cmd+B 快捷键还在（见 main.js），那是现在唯一的收/展方式。

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

  // 左轨入口：点当前那个 = 收起（与 ⋯ 菜单一致）。
  // 摸法上，再点一次回到“只有对话”。
  document.querySelectorAll("#apprail button[data-drawer]").forEach(btn => {
    btn.addEventListener("click", () => openDrawer(btn.dataset.drawer));
  });
  document.getElementById("topnav-chat")?.addEventListener("click", () => closeDrawer());

  // 「设置」：不直接开抽屉，先弹一列（四项低频配置）。
  // 菜单不能待在 nav 里——那是 overflow-y:auto 的列，绝对定位会被裁掉；
  // 也没有可靠的定位祖先，所以走 fixed、坐标由 JS 算。
  document.getElementById("cfg-open")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleCfgMenu();
  });
  document.querySelectorAll("#cfg-menu [data-cfg-go]").forEach(btn => {
    btn.addEventListener("click", () => {
      closeCfgMenu();
      openDrawer(btn.dataset.cfgGo);
    });
  });
  document.addEventListener("click", (e) => {
    const menu = document.getElementById("cfg-menu");
    if (menu && !menu.hidden && !menu.contains(e.target) && !e.target.closest("#cfg-open")) closeCfgMenu();
  });

  // 收起键。只改一个变量：--rail-w 本来就是外壳的列宽，
  // 而 .shell 上挂着 grid-template-columns 的 transition，动画是白送的。
  const foldBtn = document.getElementById("rail-fold");
  const applyFold = (folded) => {
    dom.shellEl?.classList.toggle("rail-folded", folded);
    if (foldBtn) {
      foldBtn.setAttribute("aria-expanded", String(!folded));
      foldBtn.title = folded ? "展开导航" : "收起导航";
    }
    try { localStorage.setItem("eleckoi:rail-folded", folded ? "1" : "0"); } catch { /* 隐私模式写不了 */ }
  };
  foldBtn?.addEventListener("click", () => {
    applyFold(!dom.shellEl?.classList.contains("rail-folded"));
  });
  // 记住上次的选择：收起是「窄屏 / 想专心读」的长期偏好，不是一次性动作。
  try { if (localStorage.getItem("eleckoi:rail-folded") === "1") applyFold(true); } catch { /* ignore */ }

  // 玩家消息靠左 / 靠右。
  //
  // 存 localStorage 而不是单开一页设置：它是一条改一次就不再动的视觉
  // 偏好，为它多一层入口不划算。默认靠右（现状），靠左时才由 CSS 补
  // 一个头像——右边还知道是自己打的（输入框在右下），搬到左边就没这
  // 个隐含提示了。
  const applyYouSide = (left) => {
    document.querySelector(".messages")?.classList.toggle("you-left", left);
    const label = document.getElementById("you-side-label");
    if (label) label.textContent = left ? "玩家消息靠左" : "玩家消息靠右";
    try { localStorage.setItem("eleckoi:you-left", left ? "1" : "0"); } catch { /* 隐私模式 */ }
  };
  document.getElementById("you-side-toggle")?.addEventListener("click", () => {
    applyYouSide(!document.querySelector(".messages")?.classList.contains("you-left"));
  });
  try { if (localStorage.getItem("eleckoi:you-left") === "1") applyYouSide(true); } catch { /* ignore */ }

  // 标题行那颗「世界 N 格」：既是读数也是开关
  document.getElementById("board-toggle")?.addEventListener("click", () => toggleBoardColumn());

  // （右栏标签条的绑定已删：四个标签和左轨重复，2026-09-27 一并去了。
  //   收起右栏现在有面板抬头右上角那个 ✕，左轨同名入口再点一次也能收。）

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
    // 浮层比抽屉浅一层，先收它——不然一次 Esc 关掉两层反而是惊吓。
    if (!document.getElementById("cfg-menu")?.hidden) { closeCfgMenu(); return; }
    if (openDrawerName) closeDrawer();
  });

  // 恢复上次打开的右栏面板：刷新后接着上次的位置继续改
  try {
    // 黑板列是独立开关（它不在右栏里）
    if (localStorage.getItem("eleckoi:board-open") === "1") toggleBoardColumn(true);
    const saved = localStorage.getItem("eleckoi:ctx-open");
    if (saved && DRAWERS[saved]) {
      openDrawer(saved, { reload: true }).catch((e) => {
        // 之前是 silent ignore——恢复失败时右栏半死还不吭声
        console.error("[ctx] restore failed:", e);
        toast(`右栏恢复失败: ${friendlyError(e)}`, "error");
      });
    }
  } catch (e) {
    console.error("[ctx] restore read failed:", e);
  }

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
      // 可见出口：这条链从 rail 跨 iframe 过来，断在哪一跳都要露脸——
      // 之前无 catch，链路断在半路时页面一声不吭，最难查
      try {
        const { openConversation } = await import("./chat.js");
        await openConversation(msg.id);
      } catch (e) {
        console.error("[nav] open-conv failed:", e);
        toast(`打开对话失败: ${friendlyError(e)}`, "error");
      }
    } else if (msg.t === "new-conv-for" && msg.id) {
      // 旧名 new-char 同时被当“新建角色”和“给这个角色开新场”用，名字会骗人。
      await startNewConversation(msg.id);
    } else if (msg.t === "pick-char" && msg.id) {
      await pickCharacter(msg.id);
    } else if (msg.t === "import-char") {
      // rail 的导入按钮：触发隐藏 file-input，change 已由 main.js 绑好 handleImport
      dom.fileInput?.click();
    } else if (msg.t === "new-conv") {
      const { createConversation } = await import("./chat.js");
      await createConversation();
    } else if (msg.t === "new-char") {
      // rail 的「+ 角色」：不带 id 的 new-char 就是“新建角色”。
      // 它以前落到分支链末尾——点了没反应，还一声不吭。
      const { openCharacterEditor } = await import("./characters.js");
      await openCharacterEditor();
    } else if (msg.t === "gen-open") {
      // 左栏的「✧ AI 生成」：生成台在主视图，弹窗由那边开
      const { openGen } = await import("./gen.js");
      openGen();
    } else if (msg.t === "conv-deleted" && msg.id) {
      // 左栏删掉了当前正看的那场：回空态，别留着一个已不存在的对话
      const { closeDeletedConversation } = await import("./chat.js");
      await closeDeletedConversation(msg.id);
    } else if (msg.t === "rail-refresh") {
      // 左栏要求刷新它自己的列表，主区不动（主区有自己的 loadCharacters）
    } else {
      // 可见出口：分支链末尾没有 else 时，任何没接住的导航意图都是无声失败。
      // 这条链跳 iframe，吞掉最难查——所以宁可吵，也不许静默。
      console.warn("[nav] 未处理的导航意图:", msg);
      toast(`未处理的导航意图: ${msg.t}`, "error");
    }
  });

  // 左轨**常驻**，不再因宿主 rail 在场而让位。
  //
  // 曾经这里调 refreshSidebarVisibility()，宿主 rail 一发心跳就给 .shell
  // 挂 no-rail —— 结果从宿主打开时左轨整个消失。而左轨是**全 App 唯一的
  // 抽屉入口**（九个面板全在这条上），砍它等于把设定库/公式/世界/变量
  // 全锁了。
  //
  // 两者职责本不重叠：宿主 rail 管「选谁聊」，App 左轨管「配置这个 App」。
  // 用户仍可点收起键手动折（rail-fold），那是他自己的选择。
}
