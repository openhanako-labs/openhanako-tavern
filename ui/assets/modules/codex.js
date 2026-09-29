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

const TABS = ["persons", "places", "factions", "relations", "powers"];
const TAB_LABEL = {
  persons: "人物", places: "地点", factions: "势力",
  relations: "关系", powers: "体系"
};

let currentTab = "persons";
let all = { persons: [], places: [], factions: [], relations: [], powers: [] };
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

  // 「+ 记一条」只对人 Tab 显示；关系/体系 Tab 不用它。
  if (appendBtn) appendBtn.classList.toggle("hidden", currentTab !== "persons");

  const list = all[currentTab] || [];
  if (n) n.textContent = list.length ? `${list.length} 条` : "";

  if (list.length === 0) {
    box.innerHTML = emptyHtmlFor(currentTab);
    return;
  }

  // 关系按 kind、体系按 system 排序（名称型）；其它三张表按 name。
  const sorted = (currentTab === "relations" || currentTab === "powers")
    ? list.slice().sort((a, b) => {
        const k = currentTab === "relations" ? "kind" : "system";
        const r = String(a?.[k] || "").localeCompare(String(b?.[k] || ""));
        return r !== 0 ? r : String(a?.id || "").localeCompare(String(b?.id || ""));
      })
    : list.slice().sort((a, b) =>
        String(a?.name || "").localeCompare(String(b?.name || ""))
      );

  box.innerHTML = sorted.map(renderItem).join("");

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
    factions: "还没记势力。势力是轻表：只有名字 / 简介 / 标签。",
    relations: "还没记关系。关系边是 A —kind→ B，支持人 / 地点 / 势力任意两端（前缀 p_ / pl_ / f_）。",
    powers: "还没记力量。一行 = 「某人某体系某轴的一个数值」，雷达图的轴就从这里长出来。"
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
  } else if (tab === "relations") {
    // 关系行：A —kind→ B · 强度；方向用字符体现。
    const dir = item.direction === "directed" ? "→" : item.direction === "reverse" ? "←" : "—";
    const str = typeof item.strength === "number"
      ? `<span class="codex-rel-str ${item.strength >= 0 ? "codex-rel-str-pos" : "codex-rel-str-neg"}" title="强度 ${item.strength}">${item.strength}</span>`
      : `<span class="codex-rel-str" data-sign="none" title="强度未知">—</span>`;
    meta = `<div class="codex-rel-row">
      <span class="codex-rel-endpoint codex-rel-from">${escapeHtml(item.from || "（空）")}</span>
      <span class="codex-rel-kind-wrap"><span class="codex-rel-dir">${dir}</span><span class="codex-rel-kind">${escapeHtml(item.kind || "未定关系")}</span></span>
      <span class="codex-rel-endpoint codex-rel-to">${escapeHtml(item.to || "（空）")}</span>
      ${str}
    </div>
    ${item.note ? `<div class="codex-desc">${escapeHtml(item.note)}</div>` : ""}`;
  } else if (tab === "powers") {
    // 体系行：体系 · 轴 · 数值 / 上限 · 人物
    const val = item.value === null || item.value === undefined ? "—" : String(item.value);
    const max = item.max === null || item.max === undefined ? "—" : String(item.max);
    meta = `<div class="codex-pow-row">
      <span class="codex-pow-system">${escapeHtml(item.system || "（未命名）")}</span>
      <span class="codex-pow-axis">${escapeHtml(item.axis || "（未定轴）")}</span>
      <span class="codex-pow-val">${escapeHtml(val)}<span class="codex-pow-max"> / ${escapeHtml(max)}</span></span>
      ${item.personId ? `<span class="codex-pow-person" title="人物 id">${escapeHtml(item.personId)}</span>` : ""}
    </div>
    ${item.note ? `<div class="codex-desc">${escapeHtml(item.note)}</div>` : ""}`;
  } else {
    const desc = item.description ? `<div class="codex-desc">${escapeHtml(item.description)}</div>` : "";
    meta = desc;
  }

  const lifeBadge = item.lifespan === "chat"
    ? `<span class="codex-life codex-life-chat">这场</span>`
    : `<span class="codex-life codex-life-world">世界级</span>`;

  // 关系与体系没有 name，hd 里拿 kind / system 或 id 尾号顶。人物/地点/势力照旧。
  const hdText = (tab === "relations")
    ? (item.kind || "未定关系")
    : (tab === "powers")
      ? `${item.system || "（未命名）"} · ${item.axis || "（未定轴）"}`
      : name;

  return `<div class="codex-item" data-id="${escapeHtml(item.id)}">
    <div class="codex-hd">
      <span class="codex-name">${escapeHtml(hdText)}</span>
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
      : tab === "factions"
        ? { lifespan: "world", description: "", tags: [] }
        : tab === "relations"
          ? { lifespan: "world", from: "", to: "", kind: "", direction: "undirected", strength: null, note: "" }
          : { lifespan: "world", personId: "", system: "", axis: "", value: null, max: null, note: "" };
  editing = { id: null, tab, draft: tab === "persons" || tab === "places" || tab === "factions"
    ? { name: "", ...draft }
    : draft };
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
    modalBody.classList.remove("codex-mode-person", "codex-mode-place", "codex-mode-faction", "codex-mode-relation", "codex-mode-power");
    modalBody.classList.add(
      tab === "persons" ? "codex-mode-person"
      : tab === "places" ? "codex-mode-place"
      : tab === "factions" ? "codex-mode-faction"
      : tab === "relations" ? "codex-mode-relation"
      : "codex-mode-power"
    );
  }

  const isPerson = tab === "persons";
  const isPlace = tab === "places";
  const isFaction = tab === "factions";
  const isRelation = tab === "relations";
  const isPower = tab === "powers";

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
  if (isRelation) {
    $("codex-rel-from").value = draft.from || "";
    $("codex-rel-to").value = draft.to || "";
    $("codex-rel-kind").value = draft.kind || "";
    $("codex-rel-direction").value = draft.direction || "undirected";
    $("codex-rel-strength").value = typeof draft.strength === "number" ? String(draft.strength) : "";
    $("codex-rel-note").value = draft.note || "";
  }
  if (isPower) {
    $("codex-pow-person").value = draft.personId || "";
    $("codex-pow-system").value = draft.system || "";
    $("codex-pow-axis").value = draft.axis || "";
    $("codex-pow-value").value = (draft.value === null || draft.value === undefined) ? "" : String(draft.value);
    $("codex-pow-max").value = (draft.max === null || draft.max === undefined) ? "" : String(draft.max);
    $("codex-pow-note").value = draft.note || "";
  }

  $("codex-del").hidden = !id;

  modal.classList.remove("hidden");
}

function readEditor() {
  const tab = editing.tab;
  // 关系与体系没有 name 字段；其它三张表需要。名字为必填。
  const base = { lifespan: $("codex-lifespan").value || "world" };
  if (tab === "persons" || tab === "places" || tab === "factions") {
    base.name = $("codex-name").value.trim();
    base.tags = $("codex-tags").value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    if (!base.name) throw new Error("名字不能为空");
  }
  if (tab === "persons") {
    const affRaw = $("codex-affinity").value;
    const aff = affRaw === "" ? null : Number(affRaw);
    return {
      ...base,
      characterId: $("codex-character-id").value.trim() || null,
      aliases: $("codex-aliases").value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
      firstMet: (() => {
        const convId = $("codex-first-met-conv").value.trim();
        if (!convId) return null;
        const old = editing.draft?.firstMet;
        return { convId, at: typeof old?.at === "string" ? old.at : new Date().toISOString() };
      })(),
      attitude: $("codex-attitude").value.trim(),
      status: $("codex-status").value.trim(),
      affinity: (aff !== null && Number.isFinite(aff))
        ? Math.min(100, Math.max(-100, Math.round(aff)))
        : null
    };
  }
  if (tab === "places") {
    return {
      ...base,
      parentId: $("codex-parent").value.trim() || null,
      description: $("codex-description").value || "",
      situation: $("codex-situation").value || "",
      tendency: $("codex-tendency").value.trim()
    };
  }
  if (tab === "factions") {
    return { ...base, description: $("codex-faction-desc").value || "" };
  }
  if (tab === "relations") {
    const strRaw = $("codex-rel-strength").value;
    const strength = strRaw === "" ? null : Number(strRaw);
    return {
      ...base,
      from: $("codex-rel-from").value.trim(),
      to: $("codex-rel-to").value.trim(),
      kind: $("codex-rel-kind").value.trim(),
      direction: $("codex-rel-direction").value || "undirected",
      strength: (strength !== null && Number.isFinite(strength))
        ? Math.min(100, Math.max(-100, Math.round(strength)))
        : null,
      note: $("codex-rel-note").value || ""
    };
  }
  // powers
  const num = (v) => (v === "" || v === null || v === undefined) ? null : Number(v);
  const value = num($("codex-pow-value").value);
  const max = num($("codex-pow-max").value);
  return {
    ...base,
    personId: $("codex-pow-person").value.trim() || null,
    system: $("codex-pow-system").value.trim(),
    axis: $("codex-pow-axis").value.trim(),
    value: Number.isFinite(value) ? value : null,
    max: Number.isFinite(max) ? max : null,
    note: $("codex-pow-note").value || ""
  };
}
export async function saveCodex() {
  if (!editing) return;
  const tab = editing.tab;   // 先记下：下面 closeEditor() 会把 editing 置 null
  let body;
  try { body = readEditor(); }
  catch (e) { toast(e.message, "error"); return; }

  const convId = state.currentConv?.id || null;
  try {
    if (editing.id) {
      const res = await apiFetch(`codex/${tab}/${encodeURIComponent(editing.id)}`, {
        method: "PUT",
        body: JSON.stringify({ ...body, conversationId: convId })
      });
      unwrap(res);
      toast("已保存", "success");
    } else {
      const res = await apiFetch(`codex/${tab}`, {
        method: "POST",
        body: JSON.stringify({ ...body, conversationId: convId })
      });
      const created = unwrap(res) || {};
      toast("已保存", "success");
    }
    closeEditor();
    await loadOne(tab);
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

  // 标题：关系看 kind、体系看 system·axis；其它看 name
  const titleSuffix = detail.tab === "relations"
    ? one.kind || "未定关系"
    : detail.tab === "powers"
      ? `${one.system || "（未命名）"} · ${one.axis || "（未定轴）"}`
      : one.name || "（未命名）";
  $("codex-detail-title").textContent = `${TAB_LABEL[detail.tab]}：${titleSuffix}`;
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

    // 关系：当前人物的出入边，一行一条
    const personId = one.id;
    const relEdges = (all.relations || []).filter(r => r.from === personId || r.to === personId);
    if (relEdges.length) {
      const rows = relEdges.map(r => {
        const isOut = r.from === personId;
        const other = isOut ? r.to : r.from;
        const dir = r.direction === "directed" ? (isOut ? "→" : "←")
          : r.direction === "reverse" ? (isOut ? "←" : "→")
            : "—";
        const str = typeof r.strength === "number" ? String(r.strength) : "—";
        return `<div class="codex-rel-edge"><span class="codex-rel-edge-dir">${dir}</span><span class="codex-rel-edge-endpoint">${escapeHtml(other)}</span><span class="codex-rel-edge-kind">${escapeHtml(r.kind || "未定关系")}</span><span class="codex-rel-edge-str">${escapeHtml(str)}</span></div>`;
      }).join("");
      lines.push(`<div class="codex-section"><div class="codex-section-hd">关系（${relEdges.length} 条）</div>${rows}</div>`);
    }

    // 力量：按体系分组，每个体系一张 SVG 雷达
    const personPowers = (all.powers || []).filter(p => p.personId === personId);
    if (personPowers.length) {
      const groups = new Map();
      for (const p of personPowers) {
        const key = p.system || "（未命名）";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      }
      const blockHtml = [...groups.entries()].map(([sys, axes]) => {
        const radar = renderRadar(axes.map(a => ({ name: a.axis, value: a.value, max: a.max })), {
          title: sys, size: 200
        });
        const axisRows = axes.map(a => {
          const v = (a.value === null || a.value === undefined) ? "—" : String(a.value);
          const m = (a.max === null || a.max === undefined) ? "—" : String(a.max);
          return `<div class="codex-pow-axis"><span>${escapeHtml(a.axis)}</span><span class="codex-pow-axis-v">${escapeHtml(v)}</span><span class="codex-pow-axis-max">/ ${escapeHtml(m)}</span></div>`;
        }).join("");
        return `<div class="codex-power-block">
          <div class="codex-power-hd">${escapeHtml(sys)}</div>
          <div class="codex-power-body">${radar}<div class="codex-power-axes">${axisRows}</div></div>
        </div>`;
      }).join("");
      lines.push(`<div class="codex-section"><div class="codex-section-hd">力量（${personPowers.length} 条）</div>${blockHtml}</div>`);
    }

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
  } else if (detail.tab === "relations") {
    const dir = one.direction === "directed" ? "从 → 到"
      : one.direction === "reverse" ? "到 → 从"
        : "无向";
    lines.push(row("从", one.from || "—"));
    lines.push(row("到", one.to || "—"));
    lines.push(row("方向", dir));
    lines.push(row("类型", one.kind || "—"));
    lines.push(row("强度", typeof one.strength === "number" ? String(one.strength) : "—（未知）"));
    if (one.note) lines.push(rowHtml("备注", one.note));
  } else if (detail.tab === "powers") {
    lines.push(row("体系", one.system || "—"));
    lines.push(row("轴", one.axis || "—"));
    lines.push(row("数值", (one.value === null || one.value === undefined) ? "—（未知）" : String(one.value)));
    lines.push(row("上限", (one.max === null || one.max === undefined) ? "—" : String(one.max)));
    lines.push(row("人物", one.personId || "—"));
    if (one.note) lines.push(rowHtml("备注", one.note));
  } else {
    lines.push(rowHtml("简介", one.description));
    if (Array.isArray(one.tags) && one.tags.length) lines.push(row("标签", one.tags.join(" / ")));
  }

  body.innerHTML = `<div class="codex-detail">${lines.join("")}</div>`;

  // 只对人 Tab 显「+ 记一条」；只对人 Tab 显「在图谱中查看」
  const appendBtn = $("codex-detail-append");
  if (appendBtn) appendBtn.hidden = detail.tab !== "persons";
  const graphBtn = $("codex-detail-graph");
  if (graphBtn) graphBtn.hidden = detail.tab !== "persons";
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
    await loadOne("relations");
    await loadOne("powers");
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
    const tab = editing.tab;   // 先记下：closeEditor() 会把 editing 置 null
    closeEditor();
    await deleteOne(id);
    // tab 可能已经被切走；这里再拉一次当前 tab 保稳
    if (tab !== currentTab) {
      currentTab = tab;
      await loadOne(currentTab);
      renderCodexList();
    }
  });

  // 详情：编辑 / 追加 / 删除 / 关闭 / 图谱
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
  $("codex-detail-graph")?.addEventListener("click", () => {
    if (!detail || detail.tab !== "persons") return;
    openGraph(detail.id);
  });

  // 图谱主区视图
  $("codex-graph-btn")?.addEventListener("click", () => openGraph(null));
  $("codex-graph-close")?.addEventListener("click", closeGraph);
}
// ── SVG 雷达（缺轴虚线圈 + 多边形不闭合；纯 SVG、无外部依赖） ──
//
// 三条红线：
//   · value === null 的轴：画虚线圈 + 「—」，且不进多边形顶点（不闭合）
//   · 颜色全部走 CSS 变量（currentColor / var(--*)），无十六进制字面量
//   · 缺 axis 名字的轴跳过——axis 空了整条就没意义

function renderRadar(axes, opts = {}) {
  const size = Number(opts.size) || 150;
  const title = String(opts.title || "");
  const cx = size / 2;
  const cy = size / 2;
  const r = (size / 2) - 18;
  const list = (axes || []).filter(a => a && a.name);
  const total = list.length;
  const svgNS = "http://www.w3.org/2000/svg";

  const svg = `<svg class="codex-radar" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" xmlns="${svgNS}" aria-label="${escapeHtml(title || "雷达")}">`;

  // 背景圈（三档：1/3, 2/3, 3/3）
  svg += `<circle cx="${cx}" cy="${cy}" r="${r}" class="codex-radar-ring"/>`;
  svg += `<circle cx="${cx}" cy="${cy}" r="${(r * 2 / 3).toFixed(1)}" class="codex-radar-ring"/>`;
  svg += `<circle cx="${cx}" cy="${cy}" r="${(r / 3).toFixed(1)}" class="codex-radar-ring"/>`;

  if (total === 0) {
    svg += `<text x="${cx}" y="${cy}" class="codex-radar-empty" text-anchor="middle" dominant-baseline="middle">（无轴）</text>`;
    svg += `</svg>`;
    return svg;
  }

  // 轴：缺值画虚线圈 + 「—」
  const filled = [];
  for (let i = 0; i < total; i++) {
    const angle = -Math.PI / 2 + (i / total) * Math.PI * 2;
    const nx = cx + r * Math.cos(angle);
    const ny = cy + r * Math.sin(angle);

    svg += `<line x1="${cx}" y1="${cy}" x2="${nx.toFixed(2)}" y2="${ny.toFixed(2)}" class="codex-radar-axis"/>`;

    const a = list[i];
    const hasVal = typeof a.value === "number" && Number.isFinite(a.value);
    if (!hasVal) {
      // 缺值：虚线圈 + 「—」
      svg += `<circle cx="${nx.toFixed(2)}" cy="${ny.toFixed(2)}" r="9" class="codex-radar-missing"/>`;
      svg += `<text x="${nx.toFixed(2)}" y="${ny.toFixed(2)}" class="codex-radar-missing-label" text-anchor="middle" dominant-baseline="central">—</text>`;
    } else {
      filled.push({ angle, value: a.value, name: a.name });
    }

    // 轴名标签
    const lx = cx + (r + 10) * Math.cos(angle);
    const ly = cy + (r + 10) * Math.sin(angle);
    svg += `<text x="${lx.toFixed(2)}" y="${ly.toFixed(2)}" class="codex-radar-label" text-anchor="middle" dominant-baseline="central">${escapeHtml(a.name)}</text>`;
  }

  // 多边形：仅用有值的轴；不满一圈就用 polyline 不闭合
  if (filled.length >= 1) {
    const scale = (typeof opts.max === "number" && opts.max > 0) ? opts.max : 1;
    const pts = filled.map(f => {
      const ratio = Math.max(0, Math.min(1, (f.value || 0) / scale));
      const px = cx + r * ratio * Math.cos(f.angle);
      const py = cy + r * ratio * Math.sin(f.angle);
      return `${px.toFixed(2)},${py.toFixed(2)}`;
    });
    if (filled.length >= 3) {
      // 只有当有值的轴 >= 总轴数时才闭合；否则走 polyline 不闭合
      const closeTag = filled.length >= total ? " polygon" : " polyline";
      const tag = `codex-radar-${closeTag.trim()}`;
      svg += `<${tag === "codex-radar-polygon" ? "polygon" : "polyline"} points="${pts.join(" ")}" class="codex-radar-shape"/>`;
    }
    for (const p of pts) {
      const [x, y] = p.split(",");
      svg += `<circle cx="${x}" cy="${y}" r="3" class="codex-radar-dot"/>`;
    }
  }

  svg += `</svg>`;
  return svg;
}

// ── 图谱主区视图（静态环形布局，无向边灰、有向边带箭头） ──

function openGraph(focusPersonId) {
  const { svg, stats } = renderGraph(focusPersonId);
  const box = $("codex-graph-svg");
  const statsEl = $("codex-graph-stats");
  if (box) box.innerHTML = svg;
  if (statsEl) statsEl.textContent = stats;
  const modal = $("codex-graph-modal");
  if (modal) modal.classList.remove("hidden");
  // 节点点击 → 打开该人物的详情
  if (box) {
    box.querySelectorAll("[data-node-id]").forEach(el => {
      el.style.cursor = "pointer";
      el.addEventListener("click", () => {
        const id = el.dataset.nodeId;
        const type = el.dataset.nodeType;
        if (type === "person") {
          closeGraph();
          currentTab = "persons";
          openDetail(id);
        }
      });
    });
  }
}

export function closeGraph() {
  $("codex-graph-modal")?.classList.add("hidden");
}

function renderGraph(focusPersonId) {
  const persons = all.persons || [];
  const places = all.places || [];
  const factions = all.factions || [];
  const relations = all.relations || [];

  // 把 relations 表里的 id 引用映射回具体的 codex 对象。
  // 支持两种写法：带前缀（p_ / pl_ / f_）与无前缀（纯 UUID）。
  // 前缀是用户标注意图的线索；无前缀就直接按实际所在的表判类型。
  const strip = (s) => String(s || "").replace(/^(p_|pl_|f_)/, "");
  const resolveRef = (id) => {
    if (!id) return null;
    const raw = strip(id);
    if (id.startsWith("p_")) {
      const p = persons.find(x => x.id === raw);
      return p ? { type: "person", obj: p } : null;
    }
    if (id.startsWith("pl_")) {
      const p = places.find(x => x.id === raw);
      return p ? { type: "place", obj: p } : null;
    }
    if (id.startsWith("f_")) {
      const f = factions.find(x => x.id === raw);
      return f ? { type: "faction", obj: f } : null;
    }
    // 无前缀：直接按各表查
    const p = persons.find(x => x.id === raw);
    if (p) return { type: "person", obj: p };
    const pl = places.find(x => x.id === raw);
    if (pl) return { type: "place", obj: pl };
    const f = factions.find(x => x.id === raw);
    if (f) return { type: "faction", obj: f };
    return null;
  };  // 收集出现在任一条边上的实体
  const seen = new Map();
  for (const r of relations) {
    for (const id of [r.from, r.to]) {
      if (!id || seen.has(id)) continue;
      const info = resolveRef(id);
      if (info.obj) seen.set(id, info);
    }
  }
  // 也收孤立的人——图谱里也画出来，不然点不到
  if (!focusPersonId) {
    for (const p of persons) if (!seen.has(p.id)) seen.set(p.id, { type: "person", obj: p });
  } else {
    const focus = persons.find(x => x.id === focusPersonId);
    if (focus && !seen.has(focus.id)) seen.set(focus.id, { type: "person", obj: focus });
  }

  const nodes = [...seen.values()].filter(x => x.obj);

  const W = 900, H = 520;
  const cx = W / 2, cy = H / 2 + 20;
  const R = Math.min(W, H) * 0.36;
  const n = nodes.length;

  // 环形布局
  const posMap = new Map();
  for (let i = 0; i < n; i++) {
    const id = nodes[i].obj.id;
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    posMap.set(id, { x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle) });
  }

  const svgNS = "http://www.w3.org/2000/svg";
  let svg = `<svg class="codex-graph-svg-inner" viewBox="0 0 ${W} ${H}" xmlns="${svgNS}">`;

  // 箭头 marker
  svg += `<defs>
    <marker id="codex-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" class="codex-graph-arrow-fill"/>
    </marker>
  </defs>`;

  // 边
  for (const r of relations) {
    const from = posMap.get(r.from);
    const to = posMap.get(r.to);
    if (!from || !to) continue;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d;
    const x1 = from.x + ux * 22;
    const y1 = from.y + uy * 22;
    const x2 = to.x - ux * 22;
    const y2 = to.y - uy * 22;

    const s = typeof r.strength === "number" ? Math.abs(r.strength) : 0;
    const w = 1.2 + Math.min(6, s / 20);
    const isDirected = r.direction !== "undirected";
    const strokeClass = isDirected ? "codex-graph-edge codex-graph-edge-directed" : "codex-graph-edge codex-graph-edge-undirected";
    const marker = isDirected ? ' marker-end="url(#codex-graph-arrow)"' : "";
    svg += `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke-width="${w.toFixed(2)}" class="codex-graph-edge" data-directed="${isDirected ? 1 : 0}"${marker} data-rel-id="${escapeHtml(r.id)}"/>`;
    if (r.kind) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      svg += `<text x="${mx.toFixed(2)}" y="${my.toFixed(2)}" class="codex-graph-edge-label" text-anchor="middle" dominant-baseline="central">${escapeHtml(r.kind)}</text>`;
    }
  }

  // 节点
  for (const info of nodes) {
    const p = posMap.get(info.obj.id);
    if (!p) continue;
    const obj = info.obj;
    const name = obj.name || "（未命名）";
    const focus = info.type === "person" && obj.id === focusPersonId;
    // (shapeClass 已迁移到 data-type 属性选择器上，这里不再需要类名)\n

    let shape;
    if (info.type === "faction") {
      const s = 22;
      shape = `<rect x="${(p.x - s / 2).toFixed(2)}" y="${(p.y - s / 2).toFixed(2)}" width="${s}" height="${s}" class="codex-graph-node" data-type="${info.type}"${focusAttr} data-node-id="${escapeHtml(obj.id)}" data-node-type="${info.type}"/>`;
    } else if (info.type === "place") {
      const s = 22;
      const h = s * 0.87;
      shape = `<polygon points="${p.x.toFixed(2)},${(p.y - h / 2).toFixed(2)} ${(p.x - s / 2).toFixed(2)},${(p.y + h / 2).toFixed(2)} ${(p.x + s / 2).toFixed(2)},${(p.y + h / 2).toFixed(2)}" class="codex-graph-node" data-type="${info.type}"${focusAttr} data-node-id="${escapeHtml(obj.id)}" data-node-type="${info.type}"/>`;
    } else {
      const focusAttr = focus ? " data-focus=1" : "";
      shape = `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="11" class="codex-graph-node" data-type="${info.type}"${focusAttr} data-node-id="${escapeHtml(obj.id)}" data-node-type="${info.type}"/>`;
    }
    svg += shape;
    svg += `<text x="${p.x.toFixed(2)}" y="${(p.y + 28).toFixed(2)}" class="codex-graph-node-label" data-focus="${focus ? 1 : 0}" text-anchor="middle">${escapeHtml(name)}</text>`;
  }

  svg += `</svg>`;
  const stats = `${persons.length} 人 · ${factions.length} 势力 · ${places.length} 地 · ${relations.length} 关系`;
  return { svg, stats };
}
