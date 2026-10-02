// presets.js — 提示词预设抽屉（P2 的界面出口）
//
// 后端 lib/presets/* 早就有了（块组装 / CRUD / 幂等导入 / preview），
// 但一直没有界面——又一个"能力没有出口"。这个模块把它接出来。
//
// 2026-09-27 改造（乙的布局 + 丙的方法 + 全屏）：
//   · 抽屉：4 行卡片（名字+标记 / 描述 / 计数+采样 / hover 出的操作），
//     三态（骨架 / 空 / 错）；当前项 accent 左线代替 --surface 底
//   · 编辑：全屏弹窗盖住整个 App 视口；左 420px 定宽管结构，右边全给 prompt
//   · 分区：系统区（拼进 systemPrompt）与插话区（按 depth 插消息流）分区显示
//   · 实时：块属性一变右侧立刻重算；被关闭 / 取不到内容的块留一行灰字说明
//   · 只读预览：列表"预览"按钮复用编辑弹窗的只读模式，避免两套重复实现
//   · 后端不改：POST /presets/:id/preview 早就有了，只是把它藏在了一个按钮后面

import { apiFetch, confirmDialog, escapeHtml, extractArray, friendlyError, toast, unwrap } from "./core.js";
import { dom } from "./dom.js";
import { state } from "./state.js";

// ── 来源：显示名 + 一句人话说明（用于块行的 pe-meta 与展开详情）
const SOURCE_LABEL = {
  literal: "固定文本",
  main: "主提示",
  description: "角色描述",
  personality: "性格",
  scenario: "场景",
  examples: "对话示例",
  system_prompt: "卡内系统提示",
  post_history_instructions: "后置指令",
  lore: "世界书",
  persona: "用户人设",
  author_note: "作者注释"
};

const SOURCE_NOTE = {
  literal: "直接写死的内容（展开详情后可编辑）",
  main: "预设级 system；卡里有系统提示时被它顶掉",
  description: "取自卡的 description",
  personality: "取自卡的 personality",
  scenario: "取自卡的 scenario",
  examples: "取自卡的 mes_example",
  system_prompt: "取自卡的 system_prompt",
  post_history_instructions: "取自卡的 post_history_instructions",
  lore: "注入的设定条目（按关键词激活）",
  persona: "取自对话的 persona",
  author_note: "取自对话的 author_note"
};

const SOURCE_OPTIONS = Object.keys(SOURCE_LABEL);
const POSITION_OPTIONS = [
  { value: "system", label: "系统区（进 systemPrompt）" },
  { value: "in_chat", label: "插话区（按 depth 插消息流）" }
];

// ══════════════════════════════════════════════════════════════════
// 抽屉：加载、渲染、动作
// ══════════════════════════════════════════════════════════════════

export async function loadPresets() {
  if (!dom.presetListEl) return;
  // 加载态：骨架条占位三行——先出个主体，数据到了就地换。
  dom.presetListEl.innerHTML = renderSkel();
  if (dom.presetNoteEl) dom.presetNoteEl.textContent = "";
  try {
    const list = extractArray(await apiFetch("presets"));
    state.presetList = list;
    renderPresets(list);
  } catch (e) {
    // 错误态：分清是哪方的错。这里基本只可能是服务不通。
    dom.presetListEl.innerHTML = `<div class="preset-err">
      <div class="preset-err-title">预设列表拉不下来</div>
      <div class="preset-err-body">${escapeHtml(friendlyError(e))}<br>刷新页面重试，或检查服务是否正常运行。</div>
    </div>`;
  }
}

function renderSkel() {
  const row = `<div class="preset-skel">
    <div class="preset-skel-row w60"></div>
    <div class="preset-skel-row w80"></div>
    <div class="preset-skel-row w40"></div>
  </div>`;
  return row + row + row;
}

export function renderPresets(list) {
  if (!dom.presetListEl) return;

  // 计数：从工具条挪到 body 顶部（工具条是动作位，计数是状态，两块不混）
  if (dom.presetCountEl) {
    dom.presetCountEl.textContent = list.length > 0 ? `${list.length} 套预设` : "";
  }

  // 空态：解释 + 动作。内置"默认"通常永远在，所以这个抽屉打开十之八九有东西。
  if (list.length === 0) {
    dom.presetListEl.innerHTML = `<div class="preset-empty">
      <div class="preset-empty-title">还没有预设</div>
      <div class="preset-empty-hint">预设是「怎么把角色卡信息拼成 prompt」的一套规则。<br>先建一套，再挂到对话上——同一个角色，不同场可以用不同的预设。</div>
      <div class="preset-empty-actions">
        <button type="button" class="btn btn-primary btn-sm" data-act="new">+ 新建一套</button>
      </div>
    </div>`;
    dom.presetListEl.querySelector('[data-act="new"]')?.addEventListener("click", () => openPresetEditor(null));
    return;
  }

  // 预设跟随对话：卡片上要看得出当前挂的是哪一套
  const activeId = state.currentConv?.presetId || null;
  const hasConv = !!state.currentConv;

  if (dom.presetNoteEl) {
    dom.presetNoteEl.textContent = hasConv
      ? "点「这一场用它」把预设挂到当前对话上——只影响这一场。"
      : "还没打开对话：预设挂在对话上，先开一场再选。";
  }

  // 4 行卡片：名字+标记 / 描述 / 计数+采样 / hover 出的操作
  // 分隔线代替盒子；当前项 accent 左线代替底色（--surface 比米底亮，一排盒子贴上去像"贴白纸"）。
  dom.presetListEl.innerHTML = list.map(p => {
    const isActive = activeId === p.id;
    const enabledCount = (p.blocks || []).filter(b => b.enabled !== false).length;
    const totalCount = (p.blocks || []).length;
    return `
    <div class="preset-card-v2 ${p.builtin ? "builtin" : ""}${isActive ? " active" : ""}" data-id="${p.id}">
      <div class="r1">
        <span class="nm">${escapeHtml(p.name || "（无名称）")}</span>
        ${isActive ? '<span class="flag cur">这一场在用</span>' : ""}
        ${p.builtin ? '<span class="flag bi">内置</span>' : ""}
      </div>
      ${p.description ? `<div class="r2">${escapeHtml(p.description)}</div>` : ""}
      <div class="r3">
        <span><b>${enabledCount}/${totalCount}</b> 块</span>
        <span>温度 ${p.sampling?.temperature ?? "—"}</span>
        <span>${p.sampling?.maxTokens ?? "—"} tokens</span>
      </div>
      <div class="r4">
        <button type="button" class="mini p" data-act="use" ${hasConv ? "" : "disabled"}>${isActive ? "这一场不再用" : "这一场用它"}</button>
        <button type="button" class="mini" data-act="edit">编辑</button>
        <button type="button" class="mini" data-act="preview">预览</button>
        <button type="button" class="mini" data-act="duplicate">复制</button>
        ${p.builtin ? "" : '<button type="button" class="mini danger" data-act="delete">删除</button>'}
      </div>
    </div>`;
  }).join("");

  // 事件委托：卡片内按钮
  dom.presetListEl.querySelectorAll(".preset-card-v2").forEach(card => {
    card.querySelectorAll("button[data-act]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        const id = card.dataset.id;
        if (act === "use") setConversationPreset(activeId === id ? null : id);
        else if (act === "edit") openPresetEditor(id);
        else if (act === "preview") previewPreset(id);
        else if (act === "duplicate") duplicatePreset(id);
        else if (act === "delete") deletePreset(id);
      });
    });
  });
}

// ══════════════════════════════════════════════════════════════════
// 对话挂钩、复制、删除
// ══════════════════════════════════════════════════════════════════

/**
 * 把一套预设挂到**当前对话**上（或传 null 取消）。
 *
 * 挂的是对话而不是全局——同一个角色，一场用「日常」、一场用「战斗描写」
 * 是常事；全局的话每开一场都要回去改一次，而改的还会影响别的场。
 */
export async function setConversationPreset(presetId) {
  const conv = state.currentConv;
  if (!conv) { toast("先打开一个对话", "error"); return; }
  try {
    const res = unwrap(await apiFetch(`conversations/${encodeURIComponent(conv.id)}/preset`, {
      method: "PUT",
      body: JSON.stringify({ presetId })
    }));
    state.currentConv.presetId = res?.presetId ?? null;
    renderPresets(state.presetList || []);
    toast(presetId ? "这一场改用这套预设" : "这一场不再用预设", "success");
  } catch (e) {
    toast(`设置失败: ${friendlyError(e)}`, "error");
  }
}

export async function duplicatePreset(id) {
  try {
    await apiFetch(`presets/${encodeURIComponent(id)}/duplicate`, { method: "POST", body: JSON.stringify({}) });
    toast("已复制", "success");
    await loadPresets();
  } catch (e) {
    toast(`复制失败: ${friendlyError(e)}`, "error");
  }
}

export async function deletePreset(id) {
  if (!(await confirmDialog("删除这套预设？"))) return;
  try {
    await apiFetch(`presets/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast("已删除", "success");
    await loadPresets();
  } catch (e) {
    toast(`删除失败: ${friendlyError(e)}`, "error");
  }
}

// ══════════════════════════════════════════════════════════════════
// 编辑弹窗（全屏）
// ══════════════════════════════════════════════════════════════════

/**
 * 打开编辑弹窗。
 *
 * @param {string|null} id  预设 id；null = 新建
 * @param {{readonly?: boolean}} opts  只读模式（列表"预览"按钮用）
 */
export async function openPresetEditor(id, opts = {}) {
  const readonly = !!opts.readonly;

  let preset = null;
  if (id) {
    try {
      preset = unwrap(await apiFetch(`presets/${encodeURIComponent(id)}`));
    } catch (e) { toast("加载失败", "error"); return; }
  }

  state.currentPreset = preset;
  state._peReadonly = readonly;

  const isNew = !preset;
  const p = preset || {
    id: null,
    name: "",
    description: "",
    builtin: false,
    blocks: [
      { id: `b_${Date.now()}`, source: "main", position: "system", enabled: true, order: 0 }
    ],
    sampling: { temperature: 0.8, maxTokens: 1000 }
  };

  // 只读模式：隐藏保存按钮 + 显示只读标记
  const saveBtn = document.getElementById("pe-save");
  if (saveBtn) saveBtn.style.display = readonly ? "none" : "";
  const badge = document.getElementById("pe-readonly-badge");
  if (badge) badge.classList.toggle("hidden", !readonly);

  document.getElementById("preset-editor-title").textContent =
    readonly ? `预览 · ${p.name || "（新预设）"}` :
    (isNew ? "新建预设" : `编辑 · ${p.name || "（未命名）"}`);

  // 字段
  document.getElementById("pe-id").value = p.id || "";
  const nameInput = document.getElementById("pe-name");
  nameInput.value = p.name || "";
  // 内置预设不允许改名（后端会拒绝），只读模式也不允许
  nameInput.disabled = readonly || !!p.builtin;
  const descInput = document.getElementById("pe-description");
  descInput.value = p.description || "";
  descInput.disabled = readonly;
  const tempInput = document.getElementById("pe-temperature");
  tempInput.value = p.sampling?.temperature ?? 0.8;
  tempInput.disabled = readonly;
  const maxInput = document.getElementById("pe-max-tokens");
  maxInput.value = p.sampling?.maxTokens ?? 1000;
  maxInput.disabled = readonly;

  renderPresetBlocks(p);

  // 拉上下文（当前对话的角色卡）：拿不到就 {}，对应块会显示"未设置——跳过"
  state._pePreviewCtx = await loadPreviewContext();
  updateLivePreview();

  document.getElementById("preset-editor-modal").classList.remove("hidden");
}

export function closePresetEditor() {
  document.getElementById("preset-editor-modal")?.classList.add("hidden");
  state.currentPreset = null;
  state._peReadonly = false;
  state._pePreviewCtx = null;
}

/**
 * 拿预览用上下文：当前对话的角色卡 + persona / authorNote。
 * 拿不到（没开对话、卡不存在）就返回 {}——本地算时对应块会显示"未设置——跳过"。
 */
async function loadPreviewContext() {
  try {
    const conv = state.currentConv;
    if (!conv) return {};
    const card = await apiFetch(`characters/${encodeURIComponent(conv.characterId)}`);
    return {
      character: card || null,
      persona: conv.persona || "",
      authorNote: conv.author_note || conv.authorNote || "",
      mainPrompt: ""
    };
  } catch {
    return {};
  }
}

// ══════════════════════════════════════════════════════════════════
// 块渲染（分区）+ 编辑交互
// ══════════════════════════════════════════════════════════════════

function renderPresetBlocks(preset) {
  const wrap = document.getElementById("pe-blocks");
  if (!wrap) return;

  const blocks = preset.blocks || [];
  // 按 order 排后再按 position 分组：zone 内的相对顺序 = 全局 order 的顺序
  const sorted = [...blocks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const sys = sorted.filter(b => (b.position || "system") === "system");
  const chat = sorted.filter(b => (b.position || "system") === "in_chat");

  const readonly = !!state._peReadonly;

  // 监听器不堆叠：每轮渲染换一个 AbortController，旧 signal 整体作废后再重挂。
  // （#pe-blocks 是持久容器，innerHTML 只换子节点——过去每次渲染都 addEventListener，
  //   监听按渲染次数叠层，toggle/expand 出现「点一下等于点 N 下」的奇偶失灵。）
  wrap._peAC?.abort();
  const ac = new AbortController();
  wrap._peAC = ac;

  // 第二参传的是块的 position 真值（"system"/"in_chat"），不是显示键——
  // addBlock / moveBlockInZone 拿它跟 position 字段比对，传显示键会全体失配：
  // 加块不可见、上下移静默返回（2026-10-02 修，2d06a05 引入）。
  wrap.innerHTML = `
    ${renderZone(sys, "system", "系统区", "拼成一段 systemPrompt", readonly)}
    ${renderZone(chat, "in_chat", "插话区", "按 depth 插消息流", readonly)}
  `;

  bindBlockEvents(wrap, preset, blocks, readonly, ac.signal);
}

function renderZone(blocks, zone, title, subtitle, readonly) {
  const isEmpty = blocks.length === 0;
  // zone 是 position 真值；样式类才是显示键，两套不能混用（.pe-zone.sys/.chat）。
  const cls = zone === "in_chat" ? "chat" : "sys";
  const note = isEmpty
    ? (zone === "in_chat"
        ? "这里的块<b>不进 systemPrompt</b>，而是按 depth 插在对话倒数第 N 层——<b>插在第几层，模型看到它的位置就不同</b>。现在这套一个都没用。"
        : "这里没有块。系统区的块会按顺序拼进 systemPrompt。")
    : "";
  const rows = blocks.map(b => renderRow(b, zone, readonly)).join("");
  const addLabel = zone === "in_chat" ? "＋ 加一个插话块" : "＋ 加一个系统块";
  return `
    <div class="pe-zone ${cls}" data-zone="${zone}">
      <div class="pe-zone-hd">
        <span class="zt">${title}</span>
        <span class="zr">${subtitle} · ${blocks.length} 块</span>
      </div>
      ${note ? `<div class="pe-zone-note">${note}</div>` : ""}
      <div class="pe-zone-inner">
        ${rows}
        ${readonly ? "" : `<button type="button" class="pe-add" data-act="add" data-zone="${zone}">${addLabel}</button>`}
      </div>
    </div>`;
}

function renderRow(b, zone, readonly) {
  const srcLabel = SOURCE_LABEL[b.source] || b.source;
  const srcNote = SOURCE_NOTE[b.source] || "";
  const inChat = b.position === "in_chat";
  const depth = inChat ? (Number.isInteger(b.depth) ? b.depth : 4) : null;
  const enabled = b.enabled !== false;
  const isLiteral = b.source === "literal";

  return `
    <div class="pe-row ${enabled ? "" : "off"}" data-bid="${b.id}" data-zone="${zone}">
      <span class="pe-toggle ${enabled ? "on" : ""}" data-act="toggle" data-bid="${b.id}" ${readonly ? "disabled" : ""} title="启用 / 停用"></span>
      <span class="pe-col" data-act="expand" data-bid="${b.id}">
        <span class="pe-name-line">
          <span class="pe-src-label">${escapeHtml(srcLabel)}</span>
          ${inChat ? `<span class="pe-tag">depth ${depth}</span>` : ""}
        </span>
        <span class="pe-meta">${escapeHtml(srcNote)}</span>
      </span>
      ${readonly ? "" : `
      <span class="pe-ops">
        <button type="button" class="pe-op" data-act="up" data-bid="${b.id}" title="上移">↑</button>
        <button type="button" class="pe-op" data-act="down" data-bid="${b.id}" title="下移">↓</button>
        <button type="button" class="pe-op" data-act="expand" data-bid="${b.id}" title="详情">⚙</button>
        <button type="button" class="pe-op danger" data-act="delete" data-bid="${b.id}" title="删除">🗑</button>
      </span>`}
      <div class="pe-detail">
        <div class="pe-field">
          <label>来源</label>
          <select data-act="src" data-bid="${b.id}" ${readonly ? "disabled" : ""}>
            ${SOURCE_OPTIONS.map(s => `<option value="${s}"${s === b.source ? " selected" : ""}>${escapeHtml(SOURCE_LABEL[s] || s)}</option>`).join("")}
          </select>
        </div>
        <div class="pe-field">
          <label>位置</label>
          <select data-act="pos" data-bid="${b.id}" ${readonly ? "disabled" : ""}>
            ${POSITION_OPTIONS.map(o => `<option value="${o.value}"${o.value === (b.position || "system") ? " selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}
          </select>
        </div>
        ${inChat ? `
        <div class="pe-field">
          <label>Depth（倒数第几层）</label>
          <input type="number" data-act="depth" data-bid="${b.id}" min="0" step="1" value="${depth}" ${readonly ? "disabled" : ""}>
        </div>` : ""}
        ${isLiteral ? `
        <div class="pe-field full">
          <label>内容</label>
          <textarea data-act="content" data-bid="${b.id}" rows="3" ${readonly ? "disabled" : ""}>${escapeHtml(b.content || "")}</textarea>
        </div>` : ""}
      </div>
    </div>`;
}

// ══════════════════════════════════════════════════════════════════
// 块事件绑定（委托）
// ══════════════════════════════════════════════════════════════════

function bindBlockEvents(wrap, preset, blocks, readonly, signal) {
  // 只读模式下所有交互都禁用——但块详情仍然显示（用户要看结构）。
  if (readonly) return;

  wrap.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    const bid = el.dataset.bid;
    const b = bid ? blocks.find(x => x.id === bid) : null;

    if (act === "toggle") {
      if (!b) return;
      b.enabled = b.enabled === false;
      el.classList.toggle("on", b.enabled);
      el.closest(".pe-row").classList.toggle("off", !b.enabled);
      updateLivePreview();
    } else if (act === "up" || act === "down") {
      if (!b) return;
      const zone = el.closest(".pe-zone")?.dataset.zone;
      moveBlockInZone(blocks, b, zone, act === "up" ? -1 : 1);
      renderPresetBlocks(preset);
      updateLivePreview();
    } else if (act === "expand") {
      // 点 pe-col 或 ⚙ 展开/折叠详情
      el.closest(".pe-row")?.classList.toggle("pe-detail-open");
    } else if (act === "delete") {
      if (!b) return;
      const i = blocks.findIndex(x => x.id === bid);
      if (i >= 0) blocks.splice(i, 1);
      preset.blocks = blocks;
      renderPresetBlocks(preset);
      updateLivePreview();
    } else if (act === "add") {
      const zone = el.dataset.zone;
      addBlock(blocks, zone);
      preset.blocks = blocks;
      renderPresetBlocks(preset);
      updateLivePreview();
    }
  }, { signal });

  wrap.addEventListener("change", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    const bid = el.dataset.bid;
    const b = bid ? blocks.find(x => x.id === bid) : null;
    if (!b) return;

    if (act === "src") {
      b.source = el.value;
      // 来源变化后详情结构可能变（literal 才显示 content）——全量重渲
      renderPresetBlocks(preset);
      updateLivePreview();
    } else if (act === "pos") {
      b.position = el.value;
      // position 变化后块要移到另一个 zone——全量重渲
      renderPresetBlocks(preset);
      updateLivePreview();
    } else if (act === "depth") {
      b.depth = Math.max(0, Number(el.value) || 0);
      const tag = el.closest(".pe-row").querySelector(".pe-tag");
      if (tag) tag.textContent = `depth ${b.depth}`;
      updateLivePreview();
    }
  }, { signal });

  // 内容输入（literal）：防抖重算，避免每个字符都刷一次
  let debounce = null;
  wrap.addEventListener("input", (e) => {
    const el = e.target.closest("[data-act='content']");
    if (!el) return;
    const b = blocks.find(x => x.id === el.dataset.bid);
    if (!b) return;
    b.content = el.value;
    clearTimeout(debounce);
    debounce = setTimeout(() => updateLivePreview(), 200);
  }, { signal });
}

// ══════════════════════════════════════════════════════════════════
// 块操作：移动、加、删
// ══════════════════════════════════════════════════════════════════

/**
 * zone 内上下移：跟该 zone 的相邻块交换 order 值。
 * order 是全局排序键，交换两个块的 order 就让它们的相对位置换过来；
 * 其他 zone 的 order 值不变，所以不影响别的区。
 */
function moveBlockInZone(blocks, b, zone, dir) {
  const zoneBlocks = blocks
    .filter(x => (x.position || "system") === zone)
    .sort((a, c) => (a.order ?? 0) - (c.order ?? 0));
  const pos = zoneBlocks.findIndex(x => x.id === b.id);
  if (pos < 0) return;
  const newPos = pos + dir;
  if (newPos < 0 || newPos >= zoneBlocks.length) return;
  const a = zoneBlocks[pos];
  const c = zoneBlocks[newPos];
  const tmp = a.order ?? 0;
  a.order = c.order ?? 0;
  c.order = tmp;
}

/**
 * 加一个新块：order = 该 zone 最大 order + 10。
 * 来源默认值：系统区给 literal（用户直接写内容），插话区给 author_note（有 depth 语义）。
 */
function addBlock(blocks, zone) {
  const maxOrder = blocks
    .filter(b => (b.position || "system") === zone)
    .reduce((m, b) => Math.max(m, b.order ?? 0), -10);
  const newBlock = {
    id: `b_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    source: zone === "chat" ? "author_note" : "literal",
    position: zone,
    enabled: true,
    order: maxOrder + 10
  };
  if (zone === "chat") newBlock.depth = 4;
  else newBlock.content = "";
  blocks.push(newBlock);
}

// ══════════════════════════════════════════════════════════════════
// 本地算预览（实时）+ API 校准
// ══════════════════════════════════════════════════════════════════

/**
 * 本地算 block 内容：跟后端 lib/presets/model.js 的 resolveBlockText 对齐。
 * 前端编辑时不能每次编辑都跑一趟 API，所以把这套逻辑在前端也放一份。
 * （后端是唯一的真源；保存后会调 API 校准一次。）
 */
function localResolve(b, ctx) {
  const c = ctx?.character;
  switch (b.source) {
    case "literal": return b.content || "";
    case "main": return c?.system_prompt && c.system_prompt_enabled !== false ? c.system_prompt : (ctx?.mainPrompt || "");
    case "description": return c?.description || "";
    case "personality": return c?.personality ? `性格：${c.personality}` : "";
    case "scenario": return c?.scenario ? `场景：${c.scenario}` : "";
    case "examples": return c?.mes_example || "";
    case "system_prompt": return c?.system_prompt || "";
    case "post_history_instructions": return c?.post_history_instructions || "";
    case "lore": return ctx?.loreText || "";
    case "persona": return ctx?.persona || "";
    case "author_note": return ctx?.authorNote || "";
    default: return "";
  }
}

function localCompose(preset, ctx) {
  const blocks = [...(preset.blocks || [])];
  blocks.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const systemParts = [];
  const inChatBlocks = [];
  const detail = [];
  let sysChars = 0;

  for (const b of blocks) {
    const text = localResolve(b, ctx);
    const chars = String(text || "").length;
    const enabled = b.enabled !== false;
    const skipped = !enabled || !String(text || "").trim();
    const position = b.position || "system";

    detail.push({ id: b.id, source: b.source, position, enabled, order: b.order ?? 0, chars, skipped });

    if (skipped) continue;
    if (position === "in_chat") {
      inChatBlocks.push({ id: b.id, text: String(text), depth: Number.isInteger(b.depth) ? b.depth : 4 });
    } else {
      const prefix = b.source === "lore" ? "## 世界设定\n" : "";
      systemParts.push(prefix + String(text));
      sysChars += prefix.length + chars;
    }
  }

  return { systemPrompt: systemParts.join("\n\n"), inChatBlocks, detail, sysChars };
}

/**
 * 更新右侧预览：块属性变化时立刻重算。
 *
 * 关键：被跳过 / 已关闭的块在 prompt 里留一行灰字说明——
 * 否则用户会以为它生效了。这是"看得见的诚实"：prompt 里少了什么，
 * 就明确标出为什么少，而不是让用户对着空行猜。
 */
function updateLivePreview() {
  const preset = state.currentPreset;
  if (!preset) return;

  const ctx = state._pePreviewCtx || {};
  const { detail, sysChars, inChatBlocks } = localCompose(preset, ctx);

  const pre = document.getElementById("pe-preview");
  const count = document.getElementById("pe-preview-count");
  if (!pre) return;
  if (count) count.textContent = `${sysChars} 字`;

  const sysDetail = detail.filter(d => d.position === "system");
  const parts = [];

  for (const d of sysDetail) {
    const srcLabel = SOURCE_LABEL[d.source] || d.source;
    const isLore = d.source === "lore";
    const isMain = d.source === "main";
    const head = isLore ? "## 世界设定" : (isMain ? "## 主提示" : srcLabel);
    if (!d.enabled) {
      parts.push(`<span class="pe-h">${escapeHtml(srcLabel)}</span>\n<span class="pe-gap">（已关闭 · 不进 prompt）</span>`);
    } else if (d.chars === 0) {
      parts.push(`<span class="pe-h">${escapeHtml(srcLabel)}</span>\n<span class="pe-gap">（未设置——跳过）</span>`);
    } else {
      const b = preset.blocks.find(x => x.id === d.id);
      const text = localResolve(b, ctx);
      parts.push(`<span class="pe-h">${escapeHtml(head)}</span>\n${escapeHtml(text)}`);
    }
  }

  // 系统区之后，如果有插话区块，附一段说明——它们在 prompt 里没有位置，
  // 但要让用户知道它们被插到消息流里，而不是丢了。
  if (inChatBlocks.length > 0) {
    parts.push(`<span class="pe-live-note">───── 下面是插话区的块（不进 systemPrompt，按 depth 插在消息流里）─────</span>`);
    for (const ib of inChatBlocks) {
      const b = preset.blocks.find(x => x.id === ib.id);
      const srcLabel = SOURCE_LABEL[b?.source] || b?.source || "（未知）";
      parts.push(`<span class="pe-h">▸ ${escapeHtml(srcLabel)} · depth ${ib.depth}</span>\n${escapeHtml(ib.text)}`);
    }
  }

  pre.innerHTML = parts.length > 0 ? parts.join("\n\n") : `<span class="pe-gap">（还没有启用的块）</span>`;
}

// ══════════════════════════════════════════════════════════════════
// 保存 + 校准
// ══════════════════════════════════════════════════════════════════

export async function savePreset() {
  const preset = state.currentPreset;
  if (!preset) return;

  const payload = {
    name: document.getElementById("pe-name").value.trim(),
    description: document.getElementById("pe-description").value.trim(),
    blocks: preset.blocks || [],
    sampling: {
      temperature: Number(document.getElementById("pe-temperature").value) || 0.8,
      maxTokens: Number(document.getElementById("pe-max-tokens").value) || 1000
    }
  };

  if (!payload.name) { toast("请填名称", "error"); return; }

  try {
    let id = document.getElementById("pe-id").value;
    if (id) {
      await apiFetch(`presets/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      const created = unwrap(await apiFetch("presets", { method: "POST", body: JSON.stringify(payload) }));
      id = created?.id;
      document.getElementById("pe-id").value = id || "";
    }
    toast("已保存", "success");

    // 保存后：用真 API 校准一次预览（后端可能有一些本地算不到的细节）
    if (id) {
      try {
        const res = unwrap(await apiFetch(`presets/${encodeURIComponent(id)}/preview`, {
          method: "POST",
          body: JSON.stringify(state._pePreviewCtx || {})
        }));
        const pre = document.getElementById("pe-preview");
        if (pre && res.systemPrompt) {
          pre.innerHTML = `<span class="pe-live-note">（后端校准 · 与本地预览可能有细微差异）</span>\n${escapeHtml(res.systemPrompt) || "<span class=\"pe-gap\">（空）</span>"}`;
        }
      } catch (e) {
        console.warn("[Preset] 校准失败，保留本地预览:", e);
      }
    }

    await loadPresets();
  } catch (e) {
    toast(`保存失败: ${friendlyError(e)}`, "error");
  }
}

// ══════════════════════════════════════════════════════════════════
// 预览（复用编辑弹窗的只读模式）
// ══════════════════════════════════════════════════════════════════

/**
 * 列表"预览"按钮：打开编辑弹窗的只读模式。
 *
 * 之前有独立的 preview-modal，但既然编辑弹窗已经能看 prompt，
 * 就复用它——避免两套重复实现（"预览"和"编辑看 prompt"是同一件事）。
 */
export async function previewPreset(id) {
  await openPresetEditor(id, { readonly: true });
}

// ══════════════════════════════════════════════════════════════════
// 导入（POST /presets/import 一直是幂等的，此前只是没有出口）
// ══════════════════════════════════════════════════════════════════

/**
 * 吃一个 .json 文件：裸数组、{ presets: [...] }、或单套预设对象都认。
 *
 * 后端按 id 幂等覆盖（同 id = update，否则 create），并强制 builtin:false，
 * 所以同一个文件反复导不会堆出一串，也动不了内置预设。非法条目被
 * validatePreset 逐条拒绝并进结果明细，不拖垮整批。
 */
export async function importPresetFile(files) {
  const file = files?.[0];
  if (!file) return;

  let list;
  try {
    const parsed = JSON.parse(await file.text());
    if (Array.isArray(parsed)) list = parsed;
    else if (Array.isArray(parsed?.presets)) list = parsed.presets;
    else if (parsed && typeof parsed === "object" && parsed.name) list = [parsed];
    else throw new Error("文件里没有预设——要 [ … ]、{ presets: [ … ] } 或单套预设对象");
  } catch (e) {
    toast(`导入失败: ${e?.message || e}`, "error");
    return;
  }
  if (list.length === 0) { toast("文件里没有预设", "error"); return; }

  const names = list.map(p => p?.name || "（未命名）").slice(0, 5).join("、");
  const more = list.length > 5 ? ` …等 ${list.length} 套` : "";
  const go = await confirmDialog({
    title: `导入 ${list.length} 套预设？`,
    body: `${names}${more}\n\n同 ID 的已有预设会被覆盖；内置预设不受影响。`
  });
  if (!go) return;

  try {
    const res = extractArray(await apiFetch("presets/import", {
      method: "POST",
      body: JSON.stringify({ presets: list })
    }));
    const okList = res.filter(r => r.ok);
    const bad = res.filter(r => !r.ok);
    const created = okList.filter(r => r.mode === "create").length;
    const updated = okList.filter(r => r.mode === "update").length;
    if (okList.length > 0) toast(`导入完成：新增 ${created}、覆盖 ${updated}`, "success");
    if (bad.length > 0) {
      const first = bad[0]?.name || "第一条";
      toast(`${bad.length} 套没导进来（先从「${first}」看起）：${bad[0]?.error || "未知错误"}`, "error");
    }
    await loadPresets();
  } catch (e) {
    toast(`导入失败: ${friendlyError(e)}`, "error");
  }
}

// ══════════════════════════════════════════════════════════════════
// 装配
// ══════════════════════════════════════════════════════════════════

export function bindPresets() {
  document.getElementById("preset-new-btn")?.addEventListener("click", () => openPresetEditor(null));
  document.getElementById("preset-import-btn")?.addEventListener("click", () => {
    document.getElementById("preset-import-input")?.click();
  });
  document.getElementById("preset-import-input")?.addEventListener("change", (e) => {
    if (e.target.files?.length) importPresetFile(e.target.files);
    e.target.value = ""; // 清掉，同一个文件才能连续导第二次
  });
  document.getElementById("preset-duplicate-btn")?.addEventListener("click", async () => {
    const list = state.presetList || [];
    const first = list.find(p => !p.builtin) || list[0];
    if (!first) { toast("没有可复制的预设", "error"); return; }
    await duplicatePreset(first.id);
  });
  // 注意：#preset-refresh-btn 已删（打开抽屉和增删改后本来就会自动重载，按钮成了冗余）

  document.getElementById("pe-cancel")?.addEventListener("click", closePresetEditor);
  document.getElementById("pe-save")?.addEventListener("click", savePreset);
  document.getElementById("preset-editor-close")?.addEventListener("click", closePresetEditor);
}
