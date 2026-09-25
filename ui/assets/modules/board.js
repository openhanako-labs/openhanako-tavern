// board.js — 世界（黑板）界面
//
// 黑板 = 这个世界此刻的样子。一格带三个**正交**标签：
//   活多久   世界级（跨对话） / 这场（跟随对话）
//   谁看得见 公开 / 只有某个角色 / 只有你
//   何时醒   一直在 / 被提到才醒（关键词）
//
// 界面只做三件事：看全、开关、改。三个标签在列表里各占一个 chip——
// 不折叠、不折进二级。黑板的全部价值就是「一眼看全此刻的世界」，
// 折叠会把这件事弄丢。
//
// 与「设定库」的分工：设定库是静态资料（一段被关键词触发的文本），
// 黑板是会变的状态（谁在哪、身上有什么、瞒着什么）。两者不在同一个
// 引擎里，界面也不共用——混着放，用户会分不清改哪个才有用。
//
// 后端：lib/board/routes.js。

import { apiFetch, toast, confirmDialog, escapeHtml, extractArray, friendlyError } from "./core.js";
import { dom, showEditForm } from "./dom.js";
import { state } from "./state.js";

const LIFESPAN_LABEL = { world: "世界级", chat: "这场" };

/** 角色 id → 名字。私密格显示成 id 等于没显示。 */
let charNames = null;

async function ensureCharNames() {
  if (charNames) return charNames;
  charNames = new Map();
  try {
    for (const c of extractArray(await apiFetch("characters"))) {
      if (c?.id) charNames.set(c.id, c.name || "（无名）");
    }
  } catch { /* 名字拿不到就退回显示 id */ }
  return charNames;
}

/** 角色增删后调一次，下次进面板重新拉名字。 */
export function invalidateBoardCache() {
  charNames = null;
}

/** 一次拉全：世界级 + 本场。 */
export async function loadBoard() {
  const listEl = dom.boardListEl;
  if (!listEl) return;

  try {
    const convId = state.currentConv?.id || "";
    const qs = convId ? `?conversationId=${encodeURIComponent(convId)}` : "";
    const res = await apiFetch(`board/cells${qs}`);
    const data = res?.data || res || {};

    state.boardWorld = Array.isArray(data.world) ? data.world : [];
    state.boardChat = Array.isArray(data.chat) ? data.chat : [];

    await ensureCharNames();
    renderBoard();
  } catch (e) {
    console.error("[Board] load failed:", e);
    listEl.innerHTML = `<div class="empty">加载失败<br><span class="hint">${escapeHtml(friendlyError(e))}</span></div>`;
    if (dom.boardNoteEl) dom.boardNoteEl.textContent = "";
    toast("加载世界失败: " + friendlyError(e), "error");
  }
}

/**
 * 可见性 → 一个 chip。
 *
 * 引擎对不认识的可见性一律判不可见（fail closed）。界面如实把原值亮出来，
 * 不装作正常——一条被判死的格子如果显示成「公开」，用户永远查不出为什么它不生效。
 */
function visibilityChip(cell) {
  const v = cell.visible;
  if (!v || v === "public") return { text: "公开", cls: "" };
  if (v === "user") return { text: "只有你", cls: "private" };
  if (typeof v === "string" && v.startsWith("char:")) {
    const id = v.slice(5);
    const name = charNames?.get(id);
    return { text: name ? `🔒 ${name}` : `🔒 ${id.slice(0, 8)}`, cls: "private" };
  }
  return { text: `⚠ ${v}`, cls: "private" };
}

export function renderBoard() {
  const listEl = dom.boardListEl;
  if (!listEl) return;

  const world = state.boardWorld || [];
  const chat = state.boardChat || [];
  const cells = [...world, ...chat];

  if (dom.boardCountEl) dom.boardCountEl.textContent = cells.length ? `${cells.length} 格` : "";

  if (dom.boardNoteEl) {
    dom.boardNoteEl.textContent = state.currentConv
      ? `世界级 ${world.length} 格 · 本场 ${chat.length} 格`
      : "还没打开对话：现在只有世界级的格子能改。";
  }

  if (cells.length === 0) {
    listEl.innerHTML = '<div class="empty">还没有格子<br><span class="hint">一条设定、一个地点、一件瞒着的事，都可以是一格</span></div>';
    return;
  }

  listEl.innerHTML = cells.map(cell => {
    const life = LIFESPAN_LABEL[cell.lifespan] || String(cell.lifespan || "这场");
    const vis = visibilityChip(cell);
    const act = cell.activation === "constant"
      ? "常驻"
      : (Array.isArray(cell.keywords) && cell.keywords.length
        ? `关键词 ${cell.keywords.join(" / ")}`
        : "关键词（未设）");

    return `<div class="board-cell${cell.enabled === false ? " off" : ""}" data-id="${escapeHtml(cell.id)}">
      <div class="bc-head">
        <span class="bc-title">${escapeHtml(cell.title || "（无标题）")}</span>
      </div>
      ${cell.body ? `<div class="bc-body">${escapeHtml(cell.body)}</div>` : ""}
      <div class="chip-row">
        <span class="chip">${escapeHtml(life)}</span>
        <span class="chip ${vis.cls}">${escapeHtml(vis.text)}</span>
        <span class="chip">${escapeHtml(act)}</span>
      </div>
      <div class="row-acts">
        <button class="mini" data-act="toggle">${cell.enabled === false ? "启用" : "关掉"}</button>
        <button class="mini" data-act="edit">编辑</button>
        <button class="mini danger" data-act="delete">删除</button>
      </div>
    </div>`;
  }).join("");

  listEl.querySelectorAll(".board-cell").forEach(node => {
    const id = node.dataset.id;
    node.querySelector('[data-act="toggle"]')?.addEventListener("click", () => toggleBoardCell(id));
    node.querySelector('[data-act="edit"]')?.addEventListener("click", () => openBoardCellEditor(id));
    node.querySelector('[data-act="delete"]')?.addEventListener("click", () => deleteBoardCell(id));
  });
}

function findCell(id) {
  return [...(state.boardWorld || []), ...(state.boardChat || [])].find(c => c.id === id) || null;
}

export async function toggleBoardCell(id) {
  const cell = findCell(id);
  if (!cell) return;
  try {
    await apiFetch(`board/cells/${encodeURIComponent(id)}/toggle`, {
      method: "PUT",
      body: JSON.stringify({ enabled: cell.enabled === false, conversationId: state.currentConv?.id || null })
    });
    await loadBoard();
  } catch (e) {
    toast("切换失败: " + friendlyError(e), "error");
  }
}

/** 打开编辑器；id 为空 → 新建。 */
export async function openBoardCellEditor(id) {
  try {
    const cell = id ? findCell(id) : null;
    state.currentBoardCell = cell || {
      id: null, title: "", body: "",
      lifespan: "chat", visible: "public", activation: "constant",
      keywords: [], order: 100, enabled: true
    };
    state.currentForm = "board";
    await fillBoardForm(state.currentBoardCell);
    showEditForm("board");   // 不显示自己那张表单，弹窗就是个空壳
    dom.modalEl?.classList.remove("hidden");
  } catch (e) {
    toast("打开失败: " + friendlyError(e), "error");
  }
}

async function fillBoardForm(cell) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ""; };

  set("bc-id", cell.id || "");
  set("bc-title", cell.title || "");
  set("bc-body", cell.body || "");
  set("bc-lifespan", cell.lifespan || "chat");
  set("bc-activation", cell.activation || "constant");
  set("bc-keywords", Array.isArray(cell.keywords) ? cell.keywords.join(", ") : "");
  set("bc-order", Number.isFinite(Number(cell.order)) ? Number(cell.order) : 100);
  const en = document.getElementById("bc-enabled");
  if (en) en.checked = cell.enabled !== false;

  await ensureCharNames();
  const charSel = document.getElementById("bc-visible-char");
  if (charSel) {
    const opts = [...(charNames || new Map()).entries()]
      .map(([cid, name]) => `<option value="${escapeHtml(cid)}">${escapeHtml(name)}</option>`)
      .join("");
    charSel.innerHTML = opts || '<option value="">（还没有角色卡）</option>';
  }

  const v = cell.visible || "public";
  if (v === "user") {
    set("bc-visible-scope", "user");
  } else if (typeof v === "string" && v.startsWith("char:")) {
    set("bc-visible-scope", "char");
    if (charSel) charSel.value = v.slice(5);
  } else {
    set("bc-visible-scope", "public");
  }

  syncBoardFields();
}

/** 可见性 / 激活一变，对应的补充字段跟着显隐。 */
export function syncBoardFields() {
  const scope = document.getElementById("bc-visible-scope")?.value || "public";
  document.getElementById("bc-visible-char-field")?.classList.toggle("hidden", scope !== "char");

  const act = document.getElementById("bc-activation")?.value || "constant";
  document.getElementById("bc-keywords-field")?.classList.toggle("hidden", act !== "keyword");
}

export async function saveBoardCell() {
  const cell = state.currentBoardCell;
  if (!cell) return;
  const val = (id) => document.getElementById(id)?.value ?? "";

  const title = val("bc-title").trim();
  if (!title) { toast("标题不能为空", "error"); return; }

  const body = val("bc-body").trim();
  if (!body) { toast("内容不能为空", "error"); return; }

  const lifespan = val("bc-lifespan") || "chat";
  const activation = val("bc-activation") || "constant";

  const scope = val("bc-visible-scope") || "public";
  let visible = "public";
  if (scope === "user") {
    visible = "user";
  } else if (scope === "char") {
    const cid = val("bc-visible-char");
    if (!cid) { toast("先选一个角色", "error"); return; }
    visible = `char:${cid}`;
  }

  const keywords = val("bc-keywords").split(/[,，]/).map(s => s.trim()).filter(Boolean);
  if (activation === "keyword" && keywords.length === 0) {
    toast("选了「被提到才醒」就得给至少一个关键词——否则它永远不上场", "error");
    return;
  }

  const conversationId = state.currentConv?.id || null;
  if (lifespan === "chat" && !conversationId) {
    toast("对话级的格子要挂在一条对话上：先打开一个对话", "error");
    return;
  }

  const payload = {
    title, body, lifespan, visible, activation, keywords,
    order: Number(val("bc-order")) || 100,
    enabled: document.getElementById("bc-enabled")?.checked !== false,
    conversationId
  };

  try {
    if (cell.id) {
      await apiFetch(`board/cells/${encodeURIComponent(cell.id)}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await apiFetch("board/cells", { method: "POST", body: JSON.stringify(payload) });
    }

    state.currentBoardCell = null;
    state.currentForm = null;
    dom.modalEl?.classList.add("hidden");
    await loadBoard();
    toast("已保存", "success");
  } catch (e) {
    toast("保存失败: " + friendlyError(e), "error");
  }
}

export async function deleteBoardCell(id) {
  const cell = findCell(id);
  const ok = await confirmDialog(`删掉「${cell?.title || "这一格"}」？`);
  if (!ok) return;

  try {
    const convId = state.currentConv?.id || "";
    const qs = convId ? `?conversationId=${encodeURIComponent(convId)}` : "";
    await apiFetch(`board/cells/${encodeURIComponent(id)}${qs}`, { method: "DELETE" });
    await loadBoard();
    toast("已删除", "success");
  } catch (e) {
    toast("删除失败: " + friendlyError(e), "error");
  }
}

/** 绑定抽屉内部按钮。幂等（main.js 的 init 会调一次）。 */
export function bindBoard() {
  document.getElementById("create-board-cell-btn")?.addEventListener("click", () => openBoardCellEditor(null));
  document.getElementById("refresh-board-btn")?.addEventListener("click", loadBoard);
  document.getElementById("bc-visible-scope")?.addEventListener("change", syncBoardFields);
  document.getElementById("bc-activation")?.addEventListener("change", syncBoardFields);
}
