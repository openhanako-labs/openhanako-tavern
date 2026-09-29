// codex.js — 图鉴（C1 一期）：人物 / 地点 / 势力
//
// 与「角色」的分工：角色是能上场扮演的卡（ST 兼容）；
// 图鉴是世界里存在的人——图鉴里 characterId 只是一行引用，不嵌套卡内容。
//
// 与「黑板」的分工：黑板是「此刻」，图鉴是「累计」——所以图鉴没有开关、
// 没有激活条件；只有 CRUD + 人物特有的「追加制记录」。
//
// 后端：lib/codex/routes.js。契约 { ok, data } / { ok:false, error }。

import { state } from "./state.js";
import { apiFetch, toast, confirmDialog, escapeHtml, extractArray, unwrap, friendlyError } from "./core.js";

const $ = (id) => document.getElementById(id);

const TABS = ["persons", "places", "factions"];
const TAB_LABEL = { persons: "人物", places: "地点", factions: "势力" };

let currentTab = "persons";
let all = { persons: [], places: [], factions: [] };
let editing = null;   // { id, tab, draft } | null
let detail = null;    // { id, tab } | null

// ── 入口 ─────────────────────────────────────────────

/** 打开抽屉时调用：加载全部三张表 + 绑定 tab / 事件。 */
export async function loadCodex() {
  bindCodex();
  await Promise.all(TABS.map(loadOne));
  renderCodexList();
  // 编辑器与详情弹窗的开关由 renderXxx 管，这里不主动开
  if (!editing) closeEditor();
  if (!detail) closeDetail();
}

/** 拉一张表。conversationId 只在有对话时才带——对话为空就只拿世界级。 */
async function loadOne(tab) {
  const qs = state.currentConv?.id
    ? `?conversationId=${encodeURIComponent(state.currentConv.id)}`
    : "";
  const res = await apiFetch(`codex/${tab}${qs}`);
  const data = unwrap(res) || {};
  const merged = Array.isArray(data.merged) ? data.merged : [];
  all[tab] = merged;
}

// ── 渲染 ─────────────────────────────────────────────

export function renderCodexList() {
  const box = $("codex-list");
  const n = $("codex-count");
  const appendBtn = $("codex-append-note-btn");
  if (!box) return;

  // tab 按钮的高亮
  document.querySelectorAll(".codex-tab").forEach(b => {
    b.classList.toggle("active", b.dataset.codexTab === currentTab);
  });

  // 「+ 记一条」只对人 Tab 显示
  if (appendBtn) appendBtn.classList.toggle("hidden", currentTab !== "persons");

  const list = all[currentTab] || [];
  if (n) n.textContent = list.length ? `${list.length} 条` : "";

  if (list.length === 0) {
    box.innerHTML = emptyHtmlFor(currentTab);
    return;
  }

  const items = list.slice().sort((a, b) =>
    String(a?.name || "").localeCompare(String(b?.name || ""))
  );

  box.innerHTML = items.map(renderItem).join("");

  // 事件委托（幂等）：编辑 / 删除 / 详情
  if (!box.dataset.bound) {
    box.dataset.bound = "1";
    box.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      e.stopPropagation();
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === "edit") openEditor(id);
      else if (act === "del") deleteOne(id);
      else if (act === "detail") openDetail(id);
    });
  }
}

function emptyHtmlFor(tab) {
  const hint = {
    persons: "还没记人。图鉴里的人可以是 NPC、提及的势力成员、也可以是主角——但只记录「世界里存在」，不做角色卡。",
    places: "还没记地点。地点有父级：京城 > 皇宫 > 御花园。",
    factions: "还没记势力。势力是轻表：只有名字 / 简介 / 标签。"
  }[tab] || "";
  return `<div class="empty">还没有${TAB_LABEL[tab]}。<br><span class="hint">${escapeHtml(hint)}</span></div>`;
}

/** 卡片：名字 + 标签 + 态度/状态/描述 + 好感条（人物） + 操作 */
function renderItem(item) {
  const tab = currentTab;
  const name = item.name || "（未命名）";
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const tagHtml = tags.length
    ? `<div class="codex-tags">${tags.map(t => `<span class="codex-tag">${escapeHtml(t)}</span>`).join("")}</div>`
    : "";

  let meta = "";
  if (tab === "persons") {
    const affinity = typeof item.affinity === "number" ? item.affinity : null;
    const affinityBar = affinity === null
      ? `<span class="codex-affinity codex-affinity-none" title="好感度未知">—</span>`
      : affinity >= 0
        ? `<span class="codex-affinity codex-affinity-pos" title="好感度 ${affinity}"><span class="codex-affinity-val">${affinity}</span></span>`
        : `<span class="codex-affinity codex-affinity-neg" title="好感度 ${affinity}"><span class="codex-affinity-val">${affinity}</span></span>`;
    const attitude = item.attitude ? `<span class="codex-chip codex-chip-attitude">${escapeHtml(item.attitude)}</span>` : "";
    const status = item.status ? `<span class="codex-chip codex-chip-status">${escapeHtml(item.status)}</span>` : "";
    const aliases = Array.isArray(item.aliases) ? item.aliases : [];
    const aliasHtml = aliases.length ? `<span class="codex-aliases">${escapeHtml("别称：" + aliases.join(" / "))}</span>` : "";
    const notesCount = Array.isArray(item.notes) ? item.notes.length : 0;
    meta = `<div class="codex-meta">${affinityBar} ${attitude} ${status}</div>
            ${aliasHtml ? `<div class="codex-alias-row">${aliasHtml}${notesCount ? ` · <span class="codex-notes-count">${notesCount} 条记录</span>` : ""}</div>` : ""}`;
  } else if (tab === "places") {
    const desc = item.description ? `<div class="codex-desc">${escapeHtml(item.description)}</div>` : "";
    const sit = item.situation ? `<div class="codex-situation">${escapeHtml(item.situation)}</div>` : "";
    const tendency = item.tendency ? `<span class="codex-chip codex-chip-tendency">${escapeHtml(item.tendency)}</span>` : "";
    meta = `${desc}${sit} ${tendency ? `<div class="codex-meta">${tendency}</div>` : ""}`;
  } else {
    const desc = item.description ? `<div class="codex-desc">${escapeHtml(item.description)}</div>` : "";
    meta = desc;
  }

  const lifeBadge = item.lifespan === "chat"
    ? `<span class="codex-life codex-life-chat">这场</span>`
    : `<span class="codex-life codex-life-world">世界级</span>`;

  return `<div class="codex-item" data-id="${escapeHtml(item.id)}">
    <div class="codex-hd">
      <span class="codex-name">${escapeHtml(name)}</span>
      ${lifeBadge}
    </div>
    ${tagHtml}
    ${meta}
    <div class="codex-acts">
      <button class="mini" data-act="detail" data-id="${escapeHtml(item.id)}">详情</button>
      <button class="mini" data-act="edit" data-id="${escapeHtml(item.id)}">编辑</button>
      <button class="mini codex-del" data-act="del" data-id="${escapeHtml(item.id)}">删除</button>
    </div>
  </div>`;
}

// ── 编辑器 ───────────────────────────────────────────

/** 新建：当前 Tab 决定建哪种。 */
export function newCodex() {
  const tab = currentTab;
  const draft = tab === "persons"
    ? { lifespan: "world", aliases: [], characterId: "", firstMet: null, attitude: "", status: "", affinity: null, tags: [] }
    : tab === "places"
      ? { lifespan: "world", parentId: "", description: "", situation: "", tendency: "" }
      : { lifespan: "world", description: "", tags: [] };
  editing = { id: null, tab, draft: { name: "", ...draft } };
  renderEditor();
}

/** 编辑已有条目。 */
export function openEditor(id) {
  const one = (all[currentTab] || []).find(x => String(x.id) === String(id));
  if (!one) return;
  editing = { id: one.id, tab: currentTab, draft: { ...one } };
  renderEditor();
}

export function closeEditor() {
  editing = null;
  $("codex-editor-modal")?.classList.add("hidden");
}

function renderEditor() {
  const modal = $("codex-editor-modal");
  if (!modal) return;

  if (!editing) {
    modal.classList.add("hidden");
    return;
  }

  const { tab, draft, id } = editing;
  const title = $("codex-editor-title");
  if (title) title.textContent = id ? `编辑${TAB_LABEL[tab]}` : `新建${TAB_LABEL[tab]}`;

  // 通用字段
  $("codex-name").value = draft.name || "";
  $("codex-lifespan").value = draft.lifespan || "world";
  $("codex-tags").value = Array.isArray(draft.tags) ? draft.tags.join(", ") : "";

  // 隐藏与显示：按 tab 给 modal 打一个 is-* 标签，CSS 根据它控字段。 
  // 不直接切 style.display —— 那样 CSS 就死在那里、wiring 会当死规则。
  const modalBody = modal.querySelector(".de-body");
  if (modalBody) {
    modalBody.classList.remove("codex-mode-person", "codex-mode-place", "codex-mode-faction");
    modalBody.classList.add(tab === "persons" ? "codex-mode-person"
      : tab === "places" ? "codex-mode-place"
      : "codex-mode-faction");
  }

  const isPerson = tab === "persons";
  const isPlace = tab === "places";
  const isFaction = tab === "factions";

  // 好感度：只在人 Tab 显示（id 选择器，不用 class）
  const affWrap = $("codex-field-affinity-wrap");
  if (affWrap) affWrap.style.display = isPerson ? "" : "none";

  if (isPerson) {
    $("codex-affinity").value = typeof draft.affinity === "number" ? String(draft.affinity) : "";
    $("codex-character-id").value = draft.characterId || "";
    $("codex-aliases").value = Array.isArray(draft.aliases) ? draft.aliases.join(", ") : "";
    $("codex-attitude").value = draft.attitude || "";
    $("codex-status").value = draft.status || "";
    $("codex-first-met-conv").value = typeof draft.firstMet?.convId === "string" ? draft.firstMet.convId : "";
  }
  if (isPlace) {
    $("codex-parent").value = draft.parentId || "";
    $("codex-description").value = draft.description || "";
    $("codex-situation").value = draft.situation || "";
    $("codex-tendency").value = draft.tendency || "";
  }
  if (isFaction) {
    $("codex-faction-desc").value = draft.description || "";
  }

  $("codex-del").hidden = !id;

  modal.classList.remove("hidden");
}

function readEditor() {
  const tab = editing.tab;
  const base = {
    name: ($("codex-name").value || "").trim(),
    lifespan: $("codex-lifespan").value || "world",
    tags: ($("codex-tags").value || "")
      .split(/[,，]/).map(s => s.trim()).filter(Boolean)
  };

  if (!base.name) throw new Error("名字不能为空");

  if (tab === "persons") {
    const affRaw = $("codex-affinity").value;
    const aff = affRaw === "" ? null : Number(affRaw);
    return {
      ...base,
      characterId: ($("codex-character-id").value || "").trim() || null,
      aliases: ($("codex-aliases").value || "")
        .split(/[,，]/).map(s => s.trim()).filter(Boolean),
      firstMet: (() => {
        const convId = ($("codex-first-met-conv").value || "").trim();
        if (!convId) return null;
        const old = editing.draft?.firstMet;
        return { convId, at: typeof old?.at === "string" ? old.at : new Date().toISOString() };
      })(),
      attitude: ($("codex-attitude").value || "").trim(),
      status: ($("codex-status").value || "").trim(),
      affinity: Number.isFinite(aff) && aff !== null
        ? Math.min(100, Math.max(-100, Math.round(aff)))
        : null
    };
  }
  if (tab === "places") {
    return {
      ...base,
      parentId: ($("codex-parent").value || "").trim() || null,
      description: $("codex-description").value || "",
      situation: $("codex-situation").value || "",
      tendency: ($("codex-tendency").value || "").trim()
    };
  }
  // factions
  return {
    ...base,
    description: $("codex-faction-desc").value || ""
  };
}

export async function saveCodex() {
  if (!editing) return;
  let body;
  try { body = readEditor(); }
  catch (e) { toast(e.message, "error"); return; }

  const convId = state.currentConv?.id || null;
  try {
    if (editing.id) {
      const res = await apiFetch(`codex/${editing.tab}/${encodeURIComponent(editing.id)}`, {
        method: "PUT",
        body: JSON.stringify({ ...body, conversationId: convId })
      });
      unwrap(res);
      toast("已保存", "success");
    } else {
      const res = await apiFetch(`codex/${editing.tab}`, {
        method: "POST",
        body: JSON.stringify({ ...body, conversationId: convId })
      });
      const created = unwrap(res) || {};
      editing.id = created.id || null;
      toast("已保存", "success");
    }
    closeEditor();
    await loadOne(editing.tab);
    renderCodexList();
  } catch (e) {
    toast("保存失败：" + friendlyError(e), "error");
  }
}

export async function deleteOne(id) {
  if (!id) return;
  const ok = await confirmDialog(`删掉这条${TAB_LABEL[currentTab]}？`);
  if (!ok) return;
  try {
    await apiFetch(`codex/${currentTab}/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({ conversationId: state.currentConv?.id || null })
    });
    if (detail?.id === id) closeDetail();
    toast("已删除", "success");
    await loadOne(currentTab);
    renderCodexList();
  } catch (e) {
    toast("删除失败：" + friendlyError(e), "error");
  }
}

// ── 详情（人物详情含追加制记录） ───────────────────

export function openDetail(id) {
  const one = (all[currentTab] || []).find(x => String(x.id) === String(id));
  if (!one) return;
  detail = { id: one.id, tab: currentTab };
  renderDetail();
  $("codex-detail-modal")?.classList.remove("hidden");
}

export function closeDetail() {
  detail = null;
  $("codex-detail-modal")?.classList.add("hidden");
}

function renderDetail() {
  if (!detail) return;
  const one = (all[detail.tab] || []).find(x => String(x.id) === String(detail.id));
  if (!one) { closeDetail(); return; }

  $("codex-detail-title").textContent = `${TAB_LABEL[detail.tab]}：${one.name || "（未命名）"}`;
  const body = $("codex-detail-body");
  if (!body) return;

  const lines = [];
  lines.push(row("寿命", one.lifespan === "chat" ? "这场" : "世界级"));

  if (detail.tab === "persons") {
    lines.push(row("角色卡 id", one.characterId || "—"));
    if (Array.isArray(one.aliases) && one.aliases.length) lines.push(row("称呼", one.aliases.join(" / ")));
    if (one.firstMet?.convId) lines.push(row("首次见面", `${one.firstMet.convId}${one.firstMet.at ? ` · ${one.firstMet.at.slice(0, 10)}` : ""}`));
    lines.push(row("态度", one.attitude || "—"));
    lines.push(row("状态", one.status || "—"));
    lines.push(row("好感度", typeof one.affinity === "number" ? String(one.affinity) : "—（未知）"));
    if (Array.isArray(one.tags) && one.tags.length) lines.push(row("标签", one.tags.join(" / ")));
    if (one.notes?.length) {
      const notesHtml = one.notes
        .slice()
        .sort((a, b) => String(a?.at || "").localeCompare(String(b?.at || "")))
        .map(n => `<div class="codex-note"><span class="codex-note-at">${escapeHtml(String(n.at || "").slice(0, 10))}</span>${n.convId ? `<span class="codex-note-conv">${escapeHtml(n.convId)}</span>` : ""}<span class="codex-note-text">${escapeHtml(n.text || "")}</span></div>`).join("");
      lines.push(`<div class="codex-notes"><div class="codex-notes-hd">记录（${one.notes.length} 条）</div>${notesHtml}</div>`);
    }
  } else if (detail.tab === "places") {
    lines.push(row("父级", one.parentId || "—"));
    lines.push(rowHtml("描述", one.description));
    lines.push(rowHtml("当前局势", one.situation));
    lines.push(row("走向倾向", one.tendency || "—"));
    if (Array.isArray(one.tags) && one.tags.length) lines.push(row("标签", one.tags.join(" / ")));
  } else {
    lines.push(rowHtml("简介", one.description));
    if (Array.isArray(one.tags) && one.tags.length) lines.push(row("标签", one.tags.join(" / ")));
  }

  body.innerHTML = `<div class="codex-detail">${lines.join("")}</div>`;

  // 「+ 记一条」只对人 Tab 显示
  const appendBtn = $("codex-detail-append");
  if (appendBtn) appendBtn.hidden = detail.tab !== "persons";
}

function row(k, v) {
  const safeV = v === null || v === undefined || v === "" ? "—" : String(v);
  return `<div class="codex-detail-row"><span class="codex-detail-k">${escapeHtml(k)}</span><span class="codex-detail-v">${escapeHtml(safeV)}</span></div>`;
}

/** 值可能是长文本，用 <br> 而不是 span——不然空格全被压平。 */
function rowHtml(k, v) {
  const safeV = v ? String(v).replace(/\n/g, "<br>") : "—";
  return `<div class="codex-detail-row"><span class="codex-detail-k">${escapeHtml(k)}</span><span class="codex-detail-v">${safeV}</span></div>`;
}

/** 追加一条记录：直接问用户「记什么」，不做二级弹窗。 */
export async function appendNote() {
  if (!detail || detail.tab !== "persons") return;
  const text = prompt("记什么？");
  if (text === null) return;
  const t = String(text).trim();
  if (!t) { toast("记录不能为空", "error"); return; }

  try {
    const res = await apiFetch(`codex/persons/${encodeURIComponent(detail.id)}/notes`, {
      method: "POST",
      body: JSON.stringify({
        text: t,
        conversationId: state.currentConv?.id || null
      })
    });
    unwrap(res);
    toast("已追加", "success");
    await loadOne("persons");
    if (detail?.tab === "persons") renderDetail();
    renderCodexList();
  } catch (e) {
    toast("追加失败：" + friendlyError(e), "error");
  }
}

// ── 事件绑定 ─────────────────────────────────────────

let bound = false;

export function bindCodex() {
  if (bound) return;
  bound = true;

  // tab 切换
  document.querySelectorAll(".codex-tab").forEach(b => {
    b.addEventListener("click", () => {
      const tab = b.dataset.codexTab;
      if (!tab || !TABS.includes(tab)) return;
      currentTab = tab;
      renderCodexList();
    });
  });

  // 新建 / 追加记录
  $("codex-new-btn")?.addEventListener("click", newCodex);
  $("codex-append-note-btn")?.addEventListener("click", appendNote);

  // 编辑器：取消 / 保存 / 关闭
  $("codex-cancel")?.addEventListener("click", closeEditor);
  $("codex-save")?.addEventListener("click", saveCodex);
  $("codex-editor-close")?.addEventListener("click", closeEditor);
  $("codex-del")?.addEventListener("click", async () => {
    if (!editing?.id) return;
    const id = editing.id;
    const tab = editing.tab;
    closeEditor();
    await deleteOne(id);
    // tab 可能已经被切走；这里再拉一次当前 tab 保稳
    if (tab !== currentTab) {
      currentTab = tab;
      await loadOne(currentTab);
      renderCodexList();
    }
  });

  // 详情：编辑 / 追加 / 删除 / 关闭
  $("codex-detail-close")?.addEventListener("click", closeDetail);
  $("codex-detail-edit")?.addEventListener("click", () => {
    if (!detail) return;
    const id = detail.id;
    const tab = detail.tab;
    closeDetail();
    currentTab = tab;
    openEditor(id);
    renderCodexList();
  });
  $("codex-detail-append")?.addEventListener("click", appendNote);
  $("codex-detail-delete")?.addEventListener("click", async () => {
    if (!detail) return;
    const id = detail.id;
    const tab = detail.tab;
    closeDetail();
    currentTab = tab;
    await deleteOne(id);
  });
}
