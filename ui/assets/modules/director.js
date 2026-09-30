// director.js — 剧情公式（「导演」层）
//
// 名字：Mozi 说的「配方」是那个容器（世界观 + 角色卡 + 设定图 + 剧情公式），
// 这里是容器里的一件。跟 Hana 的 Recipe 更不是一回事（那是卡片模板）。
//
// 它是**状态约束**，不是剧本：规定「满足什么条件时必须发生什么性质的事」，
// 不规定「具体发生什么」。所以这一页里没有分镜表可填，只有状态定义和规则。
//
// 编辑直接用 JSON——配方本来就是 JSON，包一层表单反而把
// `state` / `rules` 那点结构藏起来，用户改不动真正要紧的东西。
//
// 进度**不在这里**：它存在这一场对话的 variables 里（键 `__dir`）。
// 这个界面只读地把它显示出来——要改就改对话，不然会和引擎写回的值互相盖。

import { state } from "./state.js";
// vendored 单文件，零依赖。路径相对 modules/ 往回两级。
import { createJSONEditor, Mode } from "../../vendor/vanilla-jsoneditor.js";
import { apiFetch, escapeHtml, toast, confirmDialog, extractArray, unwrap, friendlyError } from "./core.js";

let list = [];
let editing = null;   // { id: string|null, draft: object }

const $ = (id) => document.getElementById(id);

/** 这一场绑的公式 id 列表。旧对话只有 directorId（单值）也能读。 */
function boundIds() {
  const conv = state.currentConv;
  if (!conv) return [];
  if (Array.isArray(conv.directorIds) && conv.directorIds.length) {
    return conv.directorIds.map(x => String(x || "")).filter(Boolean);
  }
  const one = String(conv.directorId || "").trim();
  return one ? [one] : [];
}

/** 兼容旧调用点：第一条绑定的 id（没有就空串）。 */
function boundId() {
  return boundIds()[0] || "";
}

/**
 * 这一场某条公式的进度。
 *
 * 认两种形状（与 lib/director/binding.js 的 dirStateOf 同一套判据）：
 *   · 新：`{ "uuid-a": { 张力: 3 } }` —— 取 raw[id]
 *   · 旧：`{ 张力: 3 }`              —— 扁平，整份都是那唯一一条的
 * 判据是**值是不是对象**，不是「有没有这个键」。
 */
function dirStateOf(raw, id) {
  if (!raw || typeof raw !== "object") return {};
  const own = raw[String(id)];
  if (own && typeof own === "object" && !Array.isArray(own)) return own;
  const vals = Object.values(raw);
  if (vals.length > 0 && vals.every(v => v === null || typeof v !== "object")) return raw;
  return {};
}

/** 把这一场的进度读成一行字。读的是对话自己的 variables，不是全局。 */
function progressOf(entity) {
  const raw = dirStateOf(state.currentConv?.variables?.__dir, entity?.id);
  if (!raw || typeof raw !== "object") return "";
  const parts = [];
  for (const [name, spec] of Object.entries(entity?.state || {})) {
    const v = raw[name];
    if (v === undefined) continue;
    if (typeof spec?.init === "boolean") {
      if (v) parts.push(name);
    } else {
      const max = Number.isFinite(Number(spec?.max)) ? "/" + Number(spec.max) : "";
      parts.push(`${name} ${Number(v) || 0}${max}`);
    }
  }
  return parts.join(" · ");
}

export async function loadDirectors() {
  try {
    list = extractArray(await apiFetch("directors"));
    renderDirectors();
    renderEditor();
  } catch (e) {
    toast("加载配方失败：" + friendlyError(e), "error");
  }
}

export function renderDirectors() {
  const box = $("directors-list");
  if (!box) return;
  const n = $("directors-count");
  if (n) n.textContent = list.length ? `${list.length} 份` : "";

  const boundList = boundIds();
  const boundBox = $("director-bound");
  if (boundBox) {
    if (!state.currentConv) {
      boundBox.innerHTML = `<div class="dir-line dir-k">先开一场对话，公式要绑在场上</div>`;
    } else if (boundList.length === 0) {
      boundBox.innerHTML = `<div class="dir-line dir-k">这一场还没绑公式</div>`;
    } else {
      /*
       * 多条时逐条列出来（带序号）。
       * 序号不是装饰：它对应注入顺序（order），
       * 也告诉你“哪条排在前面”。
       */
      const lines = boundList.map((id, i) => {
        const one = list.find(d => String(d.id) === id);
        if (!one) return `<div class="dir-line dir-k">第 ${i + 1} 条：公式已不在</div>`;
        const prog = progressOf(one);
        const off = one.enabled === false;
        return `<div class="dir-line"><span class="dir-k">${i + 1}.</span>「${escapeHtml(one.name)}"${off ? "（已关）" : ""}</div>`
          + (prog ? `<div class="dir-line dir-prog">${escapeHtml(prog)}</div>`
                  : `<div class="dir-line dir-prog">还没推进过——发出第一条消息就有读数了</div>`);
      });
      boundBox.innerHTML = lines.join("");
    }
  }

  if (!list.length) {
    box.innerHTML = `<div class="empty">还没有配方。<br><span class="hint">配方 = 一组状态约束：规定「满足什么条件时必须发生什么性质的事」，不规定具体发生什么。</span></div>`;
    return;
  }

  // 列表按 order 排序显示——列表的顺序就是注入顺序，所见即所得
  const ordered = list.slice().sort((a, b) => {
    const ao = Number.isFinite(Number(a.order)) ? Number(a.order) : 1;
    const bo = Number.isFinite(Number(b.order)) ? Number(b.order) : 1;
    return ao - bo;
  });

  box.innerHTML = ordered.map((d) => {
    const idx = boundList.indexOf(String(d.id));
    const on = idx >= 0;
    const off = d.enabled === false;
    const rules = Array.isArray(d.rules) ? d.rules : [];
    const briefs = rules.filter(r => String(r?.brief || "").trim()).length;
    const vars = Object.keys(d.state || {}).length;
    const pri = Number.isFinite(Number(d.priority)) ? Number(d.priority) : 100;
    const tags = Array.isArray(d.tags) ? d.tags : [];

    /*
     * 行结构照基准 5 样张「丙」：开关 + 名字 + 一行读数 + 操作。
     *
     * 开关做在行首而不是藏在编辑器里：引擎真的读 enabled
     * （pipeline 里 `if (entity.enabled === false) return ""`），
     * “这条公式这局用不用”是个高频动作，不该躲两层。
     *
     * 序号 / 顺序 / 优先级 / 标签（四件的后三件，2026-09-28 补上）：
     *   · 序号 = 绑定顺序（本场第几条），只在绑着的时候画
     *   · 顺序 = order，列表已按它排，行上再写一次让用户看得见
     *   · 优先级 = priority，**只在非默认（100）时才画**——照设定库的规矩
     *   · 标签 = tags，纯本地组织，不进引擎
     */
    const priBadge = pri !== 100
      ? `<span class="dir-pri${pri >= 300 ? " core" : ""}">${pri >= 300 ? "核心" : pri >= 200 ? "常用" : "低"}</span>`
      : "";
    const tagHtml = tags.length
      ? tags.map(t => `<span class="dir-tag">${escapeHtml(t)}</span>`).join("")
      : "";

    return `<div class="dir-item${on ? " on" : ""}${off ? " off" : ""}" data-id="${escapeHtml(d.id)}">
      <span class="dir-sw" role="switch" aria-checked="${off ? "false" : "true"}" data-act="toggle" data-id="${escapeHtml(d.id)}" title="${off ? "启用" : "停用"}"></span>
      <div class="dir-main">
        <div class="dir-name">${escapeHtml(d.name || "未命名公式")}${on ? `<span class="dir-bound-tag">${boundList.length > 1 ? `${idx + 1}` : "本场在用"}</span>` : ""}${priBadge}</div>
        <div class="dir-meta">顺序 ${Number.isFinite(Number(d.order)) ? Number(d.order) : 1} · ${vars} 个状态 · ${rules.length} 条规则${briefs ? ` · ${briefs} 条约束` : ""}</div>
        ${tagHtml ? `<div class="dir-tags">${tagHtml}</div>` : ""}
      </div>
      <div class="dir-acts">
        <button class="mini" data-act="bind" data-id="${escapeHtml(d.id)}">${on ? "解绑" : "绑到这一场"}</button>
        <button class="mini" data-act="edit" data-id="${escapeHtml(d.id)}">编辑</button>
      </div>
    </div>`;
  }).join("");

  /*
   * 事件委托：列表每次重绘都换掉整片 DOM，逐个绑等于每次都要重绑一遍。
   * 绑一次、认 data-act——这个模式在本项目里已经用过很多次，
   * 唯一容易错的地方是忘了判「绑过没有」，于是监听器越积越多。
   */
  if (!box.dataset.bound) {
    box.dataset.bound = "1";
    box.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      e.stopPropagation();
      handleDirectorAction(btn.dataset.act, btn.dataset.id);
    });
  }
}

/** 列表上的动作分派（事件委托）。 */
export async function handleDirectorAction(action, id) {
  if (action === "bind") return bindDirector(id);
  if (action === "edit") return openDirectorEditor(id);
  if (action === "toggle") return toggleDirector(id);
  if (action === "del") return deleteDirector(id);
}

export function newDirector() {
  editing = {
    id: null,
    draft: {
      name: "新公式",
      enabled: true,
      order: 1,
      priority: 100,
      tags: [],
      state: {
        tension: { init: 1, min: 0, max: 10 },
        turn: { init: 0 }
      },
      rules: [
        { when: "always", effect: "tension += 1" },
        { when: "always", effect: "turn += 1" },
        { when: "tension >= 7", effect: "tension -= 3", brief: "必须出现一次正面冲突" },
        { when: "tension >= 10", effect: "tension = 2", brief: "触发一次不可逆事件" }
      ],
      freeform: "本轮发生什么由你决定——不要按清单走，只遵守上面的约束。"
    }
  };
  renderEditor();
  // 编辑器现在在弹窗里（基准 5 · 样张「丙」），不再需要滚到抽屉底部
}

export function openDirectorEditor(id) {
  const one = list.find(d => String(d.id) === String(id));
  if (!one) return;
  editing = { id: one.id, draft: { ...one } };
  renderEditor();
}

export function closeDirectorEditor() {
  editing = null;
  renderEditor();
}

/** 删掉当前正在编辑的那一条（弹窗底部的「删除」）。 */
export async function deleteEditingDirector() {
  if (!editing?.id) return;
  await deleteDirector(editing.id);
}

function renderEditor() {
  const modal = $("director-editor-modal");
  if (!modal) return;

  // 没在编辑 → 弹窗收起。编辑器搬到弹窗后，这个函数只负责开/关与填内容。
  if (!editing) {
    modal.classList.add("hidden");
    destroyEditor();
    return;
  }

  const d = editing.draft;
  const title = $("director-editor-title");
  if (title) title.textContent = editing.id ? "编辑公式" : "新建公式";

  const nameEl = $("dir-name");
  if (nameEl) nameEl.value = d.name || "";

  // 「四件」的后三件：顺序 / 优先级 / 标签
  const orderEl = $("dir-order");
  if (orderEl) orderEl.value = String(Number.isFinite(Number(d.order)) ? Number(d.order) : 1);
  const priEl = $("dir-priority");
  if (priEl) priEl.value = String(Number.isFinite(Number(d.priority)) ? Number(d.priority) : 100);
  const tagsEl = $("dir-tags");
  if (tagsEl) tagsEl.value = Array.isArray(d.tags) ? d.tags.join(", ") : "";

  // 节奏四选项（S3）：从 draft 读到 chips
  const pacing = Array.isArray(d.pacing) ? d.pacing : [];
  document.querySelectorAll(".dir-pacing-chip").forEach(chip => {
    const key = chip.dataset.pacing;
    chip.classList.toggle("on", pacing.includes(key));
  });

  // 删除/试算只在已存的条目上有意义（新配方还没 id）
  const del = $("dir-del");
  const sim = $("dir-sim");
  if (del) del.classList.toggle("hidden", !editing.id);
  if (sim) sim.classList.toggle("hidden", !editing.id);

  modal.classList.remove("hidden");

  mountEditor({
    state: d.state || {},
    rules: Array.isArray(d.rules) ? d.rules : [],
    freeform: d.freeform || ""
  });

  // 打开就查一次：不查的话，一份旧配方要等你动一下键盘才看到它已经坏了
  runCheck();
}

/*
 * 边写边校验。
 *
 * 为什么不等着按保存：规则的错有两类，一类看得见（保存被顶回来，你会去改），
 * 一类看不见（`when` 里拼错一个字母 → 那条规则从此不命中 → 而运行期不报）。
 * 第二类只有在**写的时候**当场告诉你才有用——等到一场对话跑完几十轮
 * 才发现「那条约束怎么从来没生效」，回头已经找不到是哪次改坏的。
 *
 * 防抖 420ms：打字时每个字符都发一次请求没必要，但也不能等到失焦——
 * 那时候你已经写下一段了。
 */
let jsonEditor = null;

/** 把编辑器连根拔掉。重画编辑器面板时先清——不清就是监听器越叠越多。 */
function destroyEditor() {
  try { jsonEditor?.destroy(); } catch { /* 已经没了 */ }
  jsonEditor = null;
}

/**
 * 装上编辑器。
 *
 * 用 vanilla-jsoneditor（vendored 单文件、零依赖）而不是自己写 textarea：
 * 它自带**树/文本两种模式**、折叠、数组项增删、撤销重做、以及实时 JSON 报错。
 * 这几样每一样自己写都是几百行，而在这里一分钱不花（1.2MB 本地文件）。
 *
 * 菜单栏留着——模式切换、撤销、排序都在那儿。navigationBar 关掉：
 * 那条面包屑是给深层嵌套的文档用的，一份配方没那个深度。
 */
function mountEditor(initial) {
  destroyEditor();
  const host = $("dir-editor-host");
  if (!host || typeof createJSONEditor !== "function") return;
  jsonEditor = createJSONEditor({
    target: host,
    props: {
      content: { json: initial },
      mode: Mode.tree,
      navigationBar: false,
      onChange: () => scheduleCheck()
    }
  });
}

/**
 * 读编辑器当前内容。
 *
 * 文本模式下 get() 给的是 { text }，**不替你 parse**——所以坏 JSON 会在这里抛，
 * 由调用方接住并说清坏在哪。这也正是我们要的行为：
 * 编辑器允许你写到一半，但我们得知道「现在还不是合法 JSON」。
 */
function currentDraft() {
  if (!jsonEditor) return null;
  const c = jsonEditor.get();
  if (!c) return null;
  if ("json" in c) return c.json;
  if (typeof c.text === "string") return JSON.parse(c.text);
  return null;
}

let checkTimer = null;

function scheduleCheck() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(runCheck, 420);
}

async function runCheck() {
  const box = $("dir-check");
  if (!box || !editing) return;

  // 能本地判的先本地判——JSON 坏没坏不必绕一趟网络
  let draft;
  try {
    draft = currentDraft();
  } catch (e) {
    box.className = "dir-check bad";
    box.innerHTML = `<div class="dir-prob">JSON 解析不了：${escapeHtml(e.message)}</div>`;
    return;
  }

  try {
    const res = await apiFetch("directors/validate", {
      method: "POST",
      body: JSON.stringify({
        state: draft?.state,
        rules: draft?.rules,
        freeform: draft?.freeform,
        // 有这一场的真实进度就用它预演——比拿初值算准得多
        previewState: dirStateOf(state.currentConv?.variables?.__dir, editing?.id) || undefined
      })
    });
    renderCheck(unwrap(res) || {});
  } catch (e) {
    box.className = "dir-check bad";
    box.innerHTML = `<div class="dir-prob">校验没跑起来：${escapeHtml(friendlyError(e))}</div>`;
  }
}

function renderCheck(d) {
  const box = $("dir-check");
  if (!box) return;
  const probs = Array.isArray(d.problems) ? d.problems : [];

  if (probs.length) {
    box.className = "dir-check bad";
    box.innerHTML = `<div class="dir-check-h">还跑不起来</div>`
      + probs.map(p => `<div class="dir-prob">${escapeHtml(p)}</div>`).join("");
    return;
  }

  const bits = [`${d.ruleCount} 条规则`];
  if (d.briefCount) bits.push(`${d.briefCount} 条约束`);
  if (d.summary) bits.push(d.summary);
  box.className = "dir-check good";
  box.innerHTML = `<div class="dir-check-h">✓ 能跑 · ${escapeHtml(bits.join(" · "))}</div>`
    + (d.block ? `<details><summary>这一轮会注入什么</summary><pre>${escapeHtml(d.block)}</pre></details>` : "");
}

/** 读编辑器里的内容。JSON 坏掉时给出**位置**，不是一句「格式错误」。 */
function readEditor() {
  const name = ($("dir-name")?.value || "").trim() || "未命名公式";

  // 「四件」的后三件。数值非法时退回默认——不让一个空输入框变成 NaN
  const orderRaw = Number($("dir-order")?.value);
  const order = Number.isFinite(orderRaw) && orderRaw >= 1 ? Math.floor(orderRaw) : 1;
  const priRaw = Number($("dir-priority")?.value);
  const priority = Number.isFinite(priRaw) ? Math.floor(priRaw) : 100;
  const tags = String($("dir-tags")?.value || "")
    .split(/[,，]/)
    .map(s => s.trim())
    .filter(Boolean);

  // 节奏四选项（S3）：从 chips 读到数组
  const pacing = [...document.querySelectorAll(".dir-pacing-chip.on")]
    .map(chip => chip.dataset.pacing)
    .filter(Boolean);

  let parsed;
  try {
    parsed = currentDraft();
  } catch (e) {
    throw new Error("JSON 解析不了：" + e.message);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("顶层该是一个对象，形如 { \"state\": {...}, \"rules\": [...] }");
  }
  return {
    name,
    order,
    priority,
    tags,
    pacing,
    state: parsed.state && typeof parsed.state === "object" ? parsed.state : {},
    rules: Array.isArray(parsed.rules) ? parsed.rules : [],
    freeform: typeof parsed.freeform === "string" ? parsed.freeform : ""
  };
}

export async function saveDirector() {
  if (!editing) return;
  let body;
  try { body = readEditor(); }
  catch (e) { toast(e.message, "error"); return; }

  try {
    if (editing.id) {
      await apiFetch(`directors/${encodeURIComponent(editing.id)}`, { method: "PUT", body: JSON.stringify(body) });
    } else {
      const created = unwrap(await apiFetch("directors", { method: "POST", body: JSON.stringify(body) }));
      editing = { id: created?.id || null, draft: created || body };
    }
    toast("已保存", "success");
    await loadDirectors();
    renderEditor();
  } catch (e) {
    // 校验不过时后端把问题列在话里，原样给用户看——别把它压成「保存失败」
    toast("保存失败：" + friendlyError(e), "error");
  }
}

export async function deleteDirector(id) {
  if (!id) return;
  const ok = await confirmDialog("删掉这份配方？绑着它的对话会退回没有配方的状态——进度还在，只是不再被推。");
  if (!ok) return;
  try {
    await apiFetch(`directors/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (String(editing?.id) === String(id)) editing = null;
    toast("已删除", "success");
    await loadDirectors();
  } catch (e) {
    toast("删除失败：" + friendlyError(e), "error");
  }
}

export async function toggleDirector(id) {
  const one = list.find(d => String(d.id) === String(id));
  if (!one) return;
  try {
    await apiFetch(`directors/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: one.enabled === false })
    });
    await loadDirectors();
  } catch (e) {
    toast("改不了：" + friendlyError(e), "error");
  }
}

export async function bindDirector(id) {
  const conv = state.currentConv;
  if (!conv) { toast("先开一场对话——公式是绑在场上的", "error"); return; }

  const key = String(id);
  const cur = boundIds();
  // 已绑 → 解绑；未绑 → 追加到末尾（新绑的排最后，order 仍说了算）
  const next = cur.includes(key) ? cur.filter(x => x !== key) : [...cur, key];

  try {
    const saved = unwrap(await apiFetch(`conversations/${encodeURIComponent(conv.id)}/directors`, {
      method: "PATCH",
      body: JSON.stringify({ directorIds: next })
    }));
    // 用后端回来的结果更新内存——别自己拼，免得与写侧归一不一致
    conv.directorIds = Array.isArray(saved?.directorIds) ? saved.directorIds : next;
    conv.directorId = String(saved?.directorId ?? (next[0] || ""));
    toast(next.includes(key) ? "已绑到这一场" : "已解绑", "success");
    renderDirectors();
  } catch (e) {
    toast("绑定失败：" + friendlyError(e), "error");
  }
}

/** 试算：拿这一场现在的进度跑一轮，看会发生什么。不落盘、不碰对话。 */
export async function simulateDirector() {
  if (!editing?.id) return;
  const out = $("dir-sim-out");
  if (!out) return;

  let body;
  try { body = readEditor(); }
  catch (e) { toast(e.message, "error"); return; }

  try {
    const conv = state.currentConv;
    const res = await apiFetch(`directors/${encodeURIComponent(editing.id)}/simulate`, {
      method: "POST",
      body: JSON.stringify({
        // 取**这一条**的进度（多条时 __dir 是按公式分家的）
        state: dirStateOf(conv?.variables?.__dir, editing.id) || undefined,
        text: ""
      })
    });
    const d = unwrap(res) || {};
    out.classList.remove("hidden");
    out.innerHTML = `
      <div class="dir-k">试算（不落盘）</div>
      <pre>${escapeHtml(d.block || "")}</pre>
      <div class="hint">结算后：${escapeHtml(JSON.stringify(d.next || {}))}</div>`;
  } catch (e) {
    toast("试算失败：" + friendlyError(e), "error");
  }
}
