// command.js — 命令面板（Ctrl/⌘ + K）与滚到底
//
// 为什么命令面板是必需的不是加菜：
//   左轨把九个入口搬成了图标 + 字。图标认得住的就那么几个，
//   「想不起『正则』是哪个图标」的那一下依然会发生——面板就是那个出口。
//   同时它也是九个入口之外的快路径：打「设定」直接到设定库，
//   不用先在左轨上找。
//
// 为什么和「滚到底」放同一个文件：
//   两者都是「键盘与浮层」这一族——一个用键盘去别处，一个用键盘回原处。
//   再切一个文件只多一次 import，不多信息。

import { openDrawer, closeDrawer } from "./shell.js";
import { openBgModal } from "./appearance.js";
import { openDisplayModal } from "./display.js";
import { state } from "./state.js";

/** 面板里的一条去处。 */
const ITEMS = [
  { id: "chat",        label: "对话",       sub: "回到聊天",     alias: "chat duihua liao",   run: () => closeDrawer() },
  { id: "character",   label: "角色",       sub: "右栏面板",     alias: "character juese role", run: () => openDrawer("character") },
  { id: "settings",    label: "设定库",     sub: "右栏面板",     alias: "settings shezhi book",  run: () => openDrawer("settings") },
  { id: "board",       label: "世界",       sub: "黑板列",       alias: "board shijie world",   run: () => openDrawer("board") },
  { id: "variables",   label: "变量",       sub: "右栏面板",     alias: "vars bianliang",       run: () => openDrawer("variables") },
  { id: "presets",     label: "提示词预设", sub: "右栏面板 · 设一次就不动", alias: "preset yushe", run: () => openDrawer("presets") },
  { id: "regex",       label: "正则规则",   sub: "右栏面板 · 设一次就不动", alias: "regex zhengze", run: () => openDrawer("regex") },
  { id: "codex",       label: "图鉴",       sub: "人物 / 地点 / 势力",       alias: "codex tujian atlas", run: () => openDrawer("codex") },
  { id: "gallery",     label: "图库",       sub: "本场 / 全部两级", alias: "gallery tuku image picture", run: () => openDrawer("gallery") },
  { id: "tools",       label: "工具",       sub: "右栏面板 · 设一次就不动", alias: "tools gongju", run: () => openDrawer("tools") },
  { id: "migration",   label: "迁移",       sub: "右栏面板 · 设一次就不动", alias: "migration qianyi", run: () => openDrawer("migration") },
  { id: "add-illus",   label: "补一张场景图", sub: "给当前这一场",  alias: "illustration butu scene", run: clickBySelector('[data-act="illustrate"]', "#more-menu") },
  { id: "display",     label: "文字与字体", sub: "字号 · 正文衬线",   alias: "display font ziti wenzi size daxiao", run: () => openDisplayModal() },
  { id: "bg",          label: "背景",       sub: "换一张底图",    alias: "background beijing bg", run: () => openBgModal() },
  { id: "library",     label: "角色库",       sub: "全部角色 · 搜索 / 标签 / 翻页", alias: "library jueseku role all", run: () => import("./library.js").then(m => m.openLibrary()) },
  { id: "userprofile", label: "用户人设",     sub: "全局 · 名字 / 人设 / 头像",   alias: "user persona renshе zhi touxiang", run: () => import("./user-profile.js").then(m => m.openUserProfile()) },
  { id: "models",      label: "模型分选",     sub: "按用途覆盖",                  alias: "models moxing fenxuan", run: () => import("./models.js").then(m => m.openModels()) },
  { id: "memory",      label: "记忆面板",     sub: "短期轮数 / 总结字数",         alias: "memory jiyi", run: () => import("./memory.js").then(m => m.openMemory()) },
  { id: "tts",         label: "语音朗读",     sub: "引擎 / 声音表",               alias: "tts yuyin langdu", run: () => import("./tts.js").then(m => m.openTts()) },
  { id: "image",       label: "出图引擎",     sub: "宿主供应商 / ComfyUI",        alias: "image chutu engine", run: () => import("./image.js").then(m => m.openImage()) },
  { id: "scene",       label: "场景插图设置", sub: "三个开关",                    alias: "scene changjing inset", run: () => import("./scene.js").then(m => m.openScene()) },
  { id: "import-char", label: "导入角色卡",   sub: ".json / ST 卡",               alias: "import daoru char", run: () => document.getElementById("file-input")?.click() },
  { id: "new-conv",    label: "新建对话",     sub: "挑角色开一场",                alias: "new xinduihua conv", run: () => import("./chat.js").then(m => m.createConversation()) },
  { id: "reload",      label: "刷新界面",   sub: "改了配置之后",   alias: "reload shuaxin refresh", run: clickBySelector("#reload-link", "#app-more-menu") }
];

let bound = false;
let filtered = ITEMS;
let cursor = 0;

const $ = (id) => document.getElementById(id);

/**
 * 点一个藏在菜单里的东西。
 *
 * 「补一张场景图」与「刷新界面」都在 ⋯ 菜单里——菜单是 hidden 的，
 * 但元素本身在 DOM 里，`.click()` 照样派发。先确保菜单打开，
 * 免得点了之后菜单还关着（那样看起来像什么都没发生）。
 */
function clickBySelector(sel, menuSel) {
  return () => {
    const el = document.querySelector(sel);
    if (!el) return false;
    if (menuSel) {
      const menu = document.querySelector(menuSel);
      if (menu && menu.hidden) {
        document.getElementById(menu.id === "more-menu" ? "chat-more-btn" : "app-more-btn")?.click();
      }
    }
    el.click();
    return true;
  };
}

/** 匹配：子串命中标签，或命中别名（英文/拼音首字母那类）。 */
function matches(item, q) {
  if (!q) return true;
  const s = q.toLowerCase();
  return item.label.includes(q)
    || item.label.toLowerCase().includes(s)
    || (item.alias || "").includes(s)
    || item.sub.includes(q);
}

/**
 * 从界面上把那颗图标借过来。
 *
 * 为什么不在这里再写一份 SVG：同一个去处就该长同一张脸。
 * 面板里画了 A、左轨上画了 B，人就学不会“这颗图标 = 那个面板”。
 * 借还有个好处：以后改左轨的图标，面板跟着变，不会两边走散。
 */
function iconFor(id) {
  const sel = id === "chat" ? "#topnav-chat .ri"
    : id === "bg" ? "#bg-open .ri"
      : id === "display" ? "#display-open .ri"
      : `#apprail .rail-item[data-drawer="${id}"] .ri`;
  const src = document.querySelector(sel);
  if (src && src.tagName.toLowerCase() === "svg") {
    // 去掉内联的 width/height，交给 .cmd-item .ri 的 CSS 统一尺寸
    return src.outerHTML.replace(/\s(width|height)="[^"]*"/g, "");
  }
  // 不在左轨上的两条（补场景图 / 刷新界面）：给一个不抢眼的圆点，不编图标
  return '<svg class="ri" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="2.4"/></svg>';
}

function renderList() {
  const list = $("cmd-list");
  if (!list) return;
  if (filtered.length === 0) {
    list.innerHTML = '<div class="cmd-empty">没有这一条。<br>面板能搜：入口、角色（开聊）、对话（打开）、设置弹窗。</div>';
    return;
  }
  list.innerHTML = filtered.map((it, i) =>
    `<button type="button" class="cmd-item" data-i="${i}" ${i === cursor ? 'aria-selected="true"' : ""}>
      ${iconFor(it.id)}<span>${it.label}</span><span class="cn-sub">${it.sub}</span>
    </button>`).join("");
  list.querySelectorAll(".cmd-item").forEach(btn => {
    btn.addEventListener("click", () => runItem(Number(btn.dataset.i)));
    btn.addEventListener("mousemove", () => {
      const i = Number(btn.dataset.i);
      if (i !== cursor) { cursor = i; paintCursor(); }
    });
  });
}

/** 只改选中态，不重画整个列表——重画会把鼠标底下那个按钮换掉。 */
function paintCursor() {
  $("cmd-list")?.querySelectorAll(".cmd-item").forEach((btn, i) => {
    btn.setAttribute("aria-selected", i === cursor ? "true" : "false");
  });
}

/**
 * 动态条目：角色与对话。
 *
 * 面板从「找面板」长成「找任何东西」——搜角色名直接开聊，搜对话标题直接打开。
 * 数据用 state 里现成的（init 时已拉），不为面板单独跑请求。
 */
function dynamicItems() {
  const out = [];
  for (const c of (state.charList || []).slice(0, 60)) {
    out.push({
      id: `char:${c.id}`,
      label: c.name || "（未命名）",
      sub: "角色 · 开聊",
      alias: "char kaichiao juese",
      run: () => import("./shell.js").then(m => m.startNewConversation(c.id))
    });
  }
  for (const cv of (state.convList || []).slice(0, 20)) {
    out.push({
      id: `conv:${cv.id}`,
      label: cv.title || "（无标题）",
      sub: "对话 · 打开",
      alias: "conv duihua open",
      run: () => import("./chat.js").then(m => m.openConversation(cv.id))
    });
  }
  return out;
}
function allItems() { return [...ITEMS, ...dynamicItems()]; }

function runItem(i) {
  const it = filtered[i];
  closePalette();
  if (!it) return;
  try { it.run(); } catch (e) { console.error("[cmd] 跑不动:", e); }
}

export function openPalette() {
  const m = $("cmd-modal");
  if (!m) return;
  filtered = allItems();
  cursor = 0;
  const input = $("cmd-input");
  if (input) input.value = "";
  renderList();
  m.classList.remove("hidden");
  // 打开就能打字——否则每次都要先点一下输入框，那就不叫快捷了
  input?.focus();
}

export function closePalette() {
  $("cmd-modal")?.classList.add("hidden");
}

export function paletteOpen() {
  return !$("cmd-modal")?.classList.contains("hidden");
}

/** 绑定。幂等。 */
export function bindCommand() {
  if (bound) return;
  bound = true;

  $("cmd-open")?.addEventListener("click", openPalette);
  $("cmd-modal")?.addEventListener("click", (e) => { if (e.target.id === "cmd-modal") closePalette(); });

  const input = $("cmd-input");
  input?.addEventListener("input", () => {
    const q = input.value.trim();
    filtered = allItems().filter(it => matches(it, q));
    cursor = 0;
    renderList();
  });

  // 键盘全在输入框上处理：面板打开时焦点一定在它里面
  input?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      cursor = filtered.length ? (cursor + 1) % filtered.length : 0;
      paintCursor();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      cursor = filtered.length ? (cursor - 1 + filtered.length) % filtered.length : 0;
      paintCursor();
    } else if (e.key === "Enter") {
      e.preventDefault();
      runItem(cursor);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    }
  });

  // 全局快捷键
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    // Ctrl/⌘ + K：开面板；已经开着就关掉（同一个键来回）
    if (mod && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      paletteOpen() ? closePalette() : openPalette();
      return;
    }
    // Esc：先关浮层，再关面板。分层退，不是一起关。
    if (e.key === "Escape" && paletteOpen()) {
      e.preventDefault();
      closePalette();
    }
  });
}

// ── 滚到底 ──────────────────────────────────────────────
//
// 长对话里往回翻之后，回底部要一路滚——这是每天都会遇到的一次小卡顿。
// 只在"没到底"时出现，到底就消失：一个常在的按钮会变成噪音。

export function bindScrollBottom() {
  const box = $("messages-container");
  const btn = $("scroll-bottom");
  if (!box || !btn) return;

  const nearBottom = () => (box.scrollHeight - box.scrollTop - box.clientHeight) < 80;
  const sync = () => btn.classList.toggle("show", !nearBottom() && box.scrollHeight > box.clientHeight + 40);

  box.addEventListener("scroll", sync, { passive: true });
  // 消息是别处渲染进来的，尺寸变了要重算——不然新消息进来按钮状态是旧的
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(sync).observe(box);
  }
  btn.addEventListener("click", () => {
    box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
  });
  sync();
}
