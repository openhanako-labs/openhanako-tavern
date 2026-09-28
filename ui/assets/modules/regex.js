// regex.js — 正则规则界面（2026-09-28 重做）
//
// 仓储注释里那句话是这一页存在的理由：
//   「一条写错的正则能让角色说出完全不属于自己的话，而且没人会立刻发现。」
// 所以这一页不是填表页——**当场能看效果**才是主体，右侧「试一下」
// 是主角，不是附件。而且它必须**本地跑**（不点按钮），因为"点了才知道错"
// 的规则永远等不到反馈。
//
// 三个作用面必须分开讲清楚，用户最容易在这里误会：
//   prompt  发请求前：改的是给模型看的，改完就发
//   display 显示时：改的是你在气泡里看到的，不动发给模型的内容
//   stored  存储时：改的是写进对话文件的那份，落盘即改后
//
// 后端：lib/regex/routes.js（CRUD + 批量导入 + 试跑）。

import { apiFetch, toast, confirmDialog, escapeHtml, extractArray, friendlyError } from "./core.js";
import { dom } from "./dom.js";
import { state } from "./state.js";

const SCOPE_LABEL = { global: "全部对话", character: "某角色", preset: "某预设" };
const SCOPE_SHORT = { global: "全部对话", character: "某角色卡", preset: "某套预设" };
const SURFACE_LABEL = { prompt: "发请求前", display: "显示前", stored: "存入前" };
const SURFACE_KEY = { prompt: "prompt", display: "display", stored: "stored" };

/** 作用域下拉的候选（角色 / 预设）。私密格那套「显示成 id 等于没显示」同理。 */
let scopeNames = null;

export function invalidateRegexCache() {
  scopeNames = null;
}

async function ensureScopeNames() {
  if (scopeNames) return scopeNames;
  const characters = new Map();
  const presets = new Map();
  try {
    for (const c of extractArray(await apiFetch("characters"))) {
      if (c?.id) characters.set(c.id, c.name || "（无名）");
    }
  } catch { /* 拿不到就退回显示 id */ }
  try {
    for (const p of extractArray(await apiFetch("presets"))) {
      if (p?.id) presets.set(p.id, p.name || "（无名）");
    }
  } catch { /* 同上 */ }
  scopeNames = { characters, presets };
  return scopeNames;
}

/**
 * 载入规则列表。三态：
 *   · 第一次进入（或点重试）→ 骨架条
 *   · 空 → 说明 + 示例 + 动作
 *   · 错 → 说清是"读不到"、不是"你的规则坏了"
 */
export async function loadRegexRules() {
  const listEl = dom.regexListEl;
  if (!listEl) return;
  listEl.innerHTML = renderSkeleton();
  try {
    const list = extractArray(await apiFetch("regex-rules"));
    state.regexList = list;
    await ensureScopeNames();
    renderRegexRules();
  } catch (e) {
    console.error("[Regex] load failed:", e);
    listEl.innerHTML = renderError(e);
    toast("读不到规则: " + friendlyError(e), "error");
  }
}

/** 加载骨架 */
function renderSkeleton() {
  return `<div class="regex-skel">
    <div class="skel-bar w2"></div>
    <div class="skel-bar w1"></div>
    <div class="skel-bar w4"></div>
    <div class="skel-bar w3"></div>
  </div>`;
}

/**
 * 错误态。这里不能只写"加载失败"——用户会以为是自己的规则坏了。
 * 说清是"读不到"、给出文件名（rules.json）、给个重试。
 */
function renderError(e) {
  return `<div class="regex-err">
    <div class="re-title">读不到规则</div>
    <div class="re-desc">App 后端没响应，不是你的规则坏了。</div>
    <div class="re-file">regex/rules.json</div>
    <div class="re-act" role="button" tabindex="0" data-act="retry">重试</div>
  </div>`;
}

/**
 * 空态。不要只写"暂无规则"——那是把面板空着、让人自己去猜。
 * 给一句"正则是什么"、两个动作按钮、三条常见用法示例。
 */
function renderEmpty() {
  return `<div class="regex-empty">
    <div class="re-title">还没有规则</div>
    <div class="re-desc">
      正则规则是<b>发给模型之前 / 显示之前 / 存入之前</b>对文本做的一次替换。
      它比看起来危险：一条写错的能让角色说出完全不属于自己的话，
      而且没人会立刻发现——所以编辑弹窗里有个实时预览。
    </div>
    <div class="re-acts">
      <button class="primary" data-act="new">新建规则</button>
      <button data-act="import">从 ST 导入</button>
    </div>
    <div class="re-examples">
      <div class="re-ex-label">三条常见用法</div>
      <div class="re-ex-item">
        <div class="re-ex-name">删括号心理描写</div>
        <div class="re-ex-code">/（[^）]*）/g → 空</div>
      </div>
      <div class="re-ex-item">
        <div class="re-ex-name">把 &lt;br&gt; 换成空行</div>
        <div class="re-ex-code">/&lt;br&gt;/g → \n\n</div>
      </div>
      <div class="re-ex-item">
        <div class="re-ex-name">某词只显示成别的</div>
        <div class="re-ex-code">/薇拉/g → 你（只勾「显示前」）</div>
      </div>
    </div>
  </div>`;
}

export function renderRegexRules() {
  const listEl = dom.regexListEl;
  if (!listEl) return;

  const list = state.regexList || [];
  const on = list.filter(r => r.disabled !== true).length;

  if (dom.regexCountEl) {
    dom.regexCountEl.textContent = list.length
      ? `${on}/${list.length} 启用 · 从上到下按「顺序」跑`
      : "";
  }

  if (list.length === 0) {
    listEl.innerHTML = renderEmpty();
    listEl.querySelector('[data-act="new"]')?.addEventListener("click", () => openRegexEditor(null));
    listEl.querySelector('[data-act="import"]')?.addEventListener("click", () => importRegexClick());
    return;
  }

  listEl.innerHTML = list.map(rule => renderRuleRow(rule)).join("");

  listEl.querySelectorAll(".regex-row").forEach(node => {
    const id = node.dataset.id;
    node.querySelector('[data-act="toggle"]')?.addEventListener("click", () => toggleRegexRule(id));
    node.querySelector('[data-act="edit"]')?.addEventListener("click", () => openRegexEditor(id));
    node.querySelector('[data-act="copy"]')?.addEventListener("click", () => copyRegexRule(id));
    node.querySelector('[data-act="delete"]')?.addEventListener("click", () => deleteRegexRule(id));
  });
}

/**
 * 规则行：四行结构。
 *   行 1 名字 + 顺序徽标 + 停用标记
 *   行 2 pattern / flags → replacement（等宽）
 *   行 3 作用面徽章（prompt 橙 / display 绿 / stored 蓝）+ 作用域徽章（中性灰）
 *   行 4 hover 出的操作
 */
function renderRuleRow(rule) {
  const scope = rule.scope || "global";
  const scopeId = rule.scopeId;
  let scopeName = scope === "global" ? "全部对话" : "";
  if (scopeId && scopeNames) {
    scopeName = (scope === "character" ? scopeNames.characters : scopeNames.presets).get(scopeId)
      || SCOPE_SHORT[scope] || SCOPE_LABEL[scope] || "";
  } else if (!scopeName) {
    scopeName = SCOPE_SHORT[scope] || SCOPE_LABEL[scope] || "";
  }

  const surfaces = (Array.isArray(rule.surfaces) && rule.surfaces.length ? rule.surfaces : ["prompt"]);
  const off = rule.disabled === true;

  const pat = rule.pattern || "";
  const flags = rule.flags || "g";
  const rep = rule.replacement ?? "";

  return `<div class="regex-row${off ? " is-disabled" : ""}" data-id="${escapeHtml(rule.id)}">
    <div class="rr-head">
      <span class="rr-name">${escapeHtml(rule.name || "（无名）")}</span>
      <span class="rr-order">#${Number(rule.order) || 0}</span>
      ${off ? '<span class="rr-disabled-tag">已停用</span>' : ""}
    </div>
    <div class="rr-code">
      <code class="rr-pat">/${escapeHtml(pat)}/${escapeHtml(flags)}</code>
      <span class="rr-arrow">→</span>
      <code class="rr-rep${rep ? "" : " empty"}">${rep ? escapeHtml(rep) : "（删掉）"}</code>
    </div>
    <div class="rr-chips">
      ${surfaces.map(s => `<span class="chip s-${escapeHtml(s)}">${escapeHtml(SURFACE_LABEL[s] || s)}</span>`).join("")}
      <span class="chip scope scope-${escapeHtml(scope)}">${escapeHtml(scopeName)}</span>
    </div>
    <div class="rr-acts">
      <button class="mini" data-act="toggle">${off ? "启用" : "停用"}</button>
      <button class="mini" data-act="edit">编辑</button>
      <button class="mini" data-act="copy">复制</button>
      <button class="mini danger" data-act="delete">删除</button>
    </div>
  </div>`;
}

function findRule(id) {
  return (state.regexList || []).find(r => r.id === id) || null;
}

/** 开关。PATCH 收的是 enabled（正的语义），仓储内部存 disabled。 */
export async function toggleRegexRule(id) {
  const rule = findRule(id);
  if (!rule) return;
  try {
    await apiFetch(`regex-rules/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: rule.disabled === true })
    });
    await loadRegexRules();
  } catch (e) {
    toast("切换失败: " + friendlyError(e), "error");
  }
}

/**
 * 复制：把规则复制成一条新规则（去 id、名字加「（副本）」），
 * 让用户能"改一个已经调好的"——而不是从空白开始。
 */
export async function copyRegexRule(id) {
  const rule = findRule(id);
  if (!rule) return;
  const { id: _id, ...rest } = rule;
  try {
    await apiFetch("regex-rules", {
      method: "POST",
      body: JSON.stringify({
        ...rest,
        name: (rule.name || "规则") + "（副本）",
        order: (Number(rule.order) || 0) + 10
      })
    });
    toast("已复制", "success");
    await loadRegexRules();
  } catch (e) {
    toast("复制失败: " + friendlyError(e), "error");
  }
}

export async function deleteRegexRule(id) {
  const rule = findRule(id);
  // 同 deleteBoardCell：找不到就别先问一句「删掉『这一条』？」
  //——名字本来就是从找不到的对象上取的，只会拿出兜底词。
  if (!rule) {
    toast("这条规则已经不在了，已经帮你刷新", "error");
    await loadRegexRules();
    return;
  }
  const ok = await confirmDialog(`删掉规则「${rule.name || "这一条"}」？`);
  if (!ok) return;
  try {
    await apiFetch(`regex-rules/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadRegexRules();
    toast("已删除", "success");
  } catch (e) {
    toast("删除失败: " + friendlyError(e), "error");
  }
}

/* ── 导入：吃 SillyTavern 的 RegexScript 形态 ─────────── */

export function importRegexClick() {
  document.getElementById("import-regex-input")?.click();
}

export async function handleImportRegexFile(e) {
  const file = e?.target?.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed?.data) ? parsed.data : null);
    if (!items) throw new Error("文件格式不对：需要一个数组，或 { data: [...] }");
    await apiFetch("regex-rules/import", {
      method: "POST",
      body: JSON.stringify({ items })
    });
    toast(`已导入 ${items.length} 条规则`, "success");
    await loadRegexRules();
  } catch (err) {
    toast("导入失败: " + friendlyError(err), "error");
  } finally {
    if (e?.target) e.target.value = "";
  }
}

/* ── 编辑弹窗 ────────────────────────────────────────── */

export async function openRegexEditor(id) {
  try {
    const rule = id ? findRule(id) : null;
    state.currentRegexRule = rule || {
      id: null, name: "", pattern: "", replacement: "", flags: "g",
      scope: "global", scopeId: null, surfaces: ["prompt"],
      order: 0, disabled: false
    };
    await fillRegexForm(state.currentRegexRule);
    // 标题：新建 vs 编辑
    document.getElementById("regex-modal-title")?.textContent
      ? (document.getElementById("regex-modal-title").textContent = rule ? "编辑规则" : "新建规则")
      : null;
    // 用独立的 regex-modal，不走共用 #modal
    document.getElementById("regex-modal")?.classList.remove("hidden");
    // 弹窗一开就跑一次试跑
    updateRegexPreview();
  } catch (e) {
    toast("打开失败: " + friendlyError(e), "error");
  }
}

export function closeRegexEditor() {
  document.getElementById("regex-modal")?.classList.add("hidden");
  state.currentRegexRule = null;
}

async function fillRegexForm(rule) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ""; };

  set("rf-id", rule.id || "");
  set("rf-name", rule.name || "");
  set("rf-pattern", rule.pattern || "");
  set("rf-replacement", rule.replacement ?? "");
  set("rf-flags", rule.flags || "g");
  set("rf-order", Number.isFinite(Number(rule.order)) ? Number(rule.order) : 0);

  // 作用域 radio
  const scope = rule.scope || "global";
  for (const r of document.querySelectorAll('input[name="rf-scope-radio"]')) {
    r.checked = r.value === scope;
  }
  await syncRegexFields(rule.scopeId || null);

  // 作用面复选
  const surfaces = Array.isArray(rule.surfaces) && rule.surfaces.length ? rule.surfaces : ["prompt"];
  for (const s of ["prompt", "display", "stored"]) {
    const el = document.getElementById(`rf-surface-${s}`);
    if (el) el.checked = surfaces.includes(s);
  }
}

/** 作用域：选「某角色 / 某预设」时才填第二个下拉。 */
export async function syncRegexFields(preselectId = null) {
  const scopeEl = document.querySelector('input[name="rf-scope-radio"]:checked');
  const scope = scopeEl?.value || "global";
  const needId = scope === "character" || scope === "preset";
  document.getElementById("rf-scope-id-field")?.classList.toggle("hidden", !needId);
  if (!needId) return;

  const sel = document.getElementById("rf-scope-id");
  if (!sel) return;

  await ensureScopeNames();
  const map = scope === "character" ? scopeNames.characters : scopeNames.presets;
  const none = scope === "character" ? "（还没有角色卡）" : "（还没有预设）";
  const opts = [...map.entries()].map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join("");
  sel.innerHTML = opts || `<option value="">${none}</option>`;
  if (preselectId) sel.value = preselectId;
}

export async function saveRegexRule() {
  const rule = state.currentRegexRule;
  if (!rule) return;
  const val = (id) => document.getElementById(id)?.value ?? "";

  const name = val("rf-name").trim();
  if (!name) { toast("名称不能为空", "error"); return; }

  const pattern = val("rf-pattern").trim();
  if (!pattern) { toast("查找正则为空——空正则会匹配任何位置，不能发出去", "error"); return; }

  // 编译一次：坏正则在界面上就报错，不让后端兜底
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, val("rf-flags") || "g");
  } catch (e) {
    toast("正则无效: " + e.message, "error");
    return;
  }

  const scopeEl = document.querySelector('input[name="rf-scope-radio"]:checked');
  const scope = scopeEl?.value || "global";
  const scopeId = scope === "global" ? null : (val("rf-scope-id") || null);
  if (scope !== "global" && !scopeId) {
    toast("选了限定范围却没指定对象——这条规则永远不会生效", "error");
    return;
  }

  const surfaces = ["prompt", "display", "stored"]
    .filter(s => document.getElementById(`rf-surface-${s}`)?.checked);
  if (surfaces.length === 0) {
    toast("至少要勾一个作用面，否则这条规则什么也不做", "error");
    return;
  }

  const payload = {
    name,
    pattern,
    replacement: val("rf-replacement"),
    flags: val("rf-flags") || "g",
    scope,
    scopeId,
    surfaces,
    order: Number(val("rf-order")) || 0
  };

  try {
    if (rule.id) {
      await apiFetch(`regex-rules/${encodeURIComponent(rule.id)}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await apiFetch("regex-rules", { method: "POST", body: JSON.stringify(payload) });
    }
    state.currentRegexRule = null;
    closeRegexEditor();
    await loadRegexRules();
    toast("已保存", "success");
  } catch (e) {
    toast("保存失败: " + friendlyError(e), "error");
  }
}

/* ── 实时试跑（本地跑，不走后端） ─────────────────────── */

/**
 * 边改边重算：pattern / flags / replacement / 输入文本任一变化都触发。
 *
 * 命中处理：
 *   · 有替换文本 → 用 <mark>（.hit）包住替换结果
 *   · 无替换文本 → 把匹配到的原文加删除线淡化
 *
 * 防护：
 *   · g 标志缺失时补上（否则只替换第一处，用户以为规则坏了）
 *   · 匹配空串时 re.lastIndex++（否则会死循环）
 *   · 上限 500 次匹配（防误操作把浏览器卡死）
 */
export function updateRegexPreview() {
  const val = (id) => document.getElementById(id)?.value ?? "";
  const text = val("rf-test-input");
  const pattern = val("rf-pattern").trim();
  const replacement = val("rf-replacement");
  const flags = (val("rf-flags") || "g").replace(/g/, "");

  const out = document.getElementById("rf-test-output");
  const hit = document.getElementById("rf-test-hit");
  const err = document.getElementById("rf-test-error");
  if (!out) return;

  if (err) { err.classList.add("hidden"); err.innerHTML = ""; }
  if (hit) hit.innerHTML = "";

  if (!pattern) {
    out.innerHTML = '<span class="empty">（还没写匹配）</span>';
    return;
  }

  // 编译
  const fullFlags = flags + "g";
  let re;
  try {
    re = new RegExp(pattern, fullFlags);
  } catch (e) {
    if (err) {
      err.classList.remove("hidden");
      err.textContent = e.message;
    }
    out.innerHTML = '<span class="empty">（正则写错了——看下面的红框）</span>';
    return;
  }

  // 收集所有命中的位置（防死循环）
  // 存完整 match 数组——$1 $2 捕获组在里面（m[1] m[2]…），后面展开替换要用
  const marks = [];
  let m;
  let guard = 0;
  while ((m = re.exec(text)) !== null && guard++ < 500) {
    marks.push({ index: m.index, end: m.index + m[0].length, match: m });
    if (m[0] === "") re.lastIndex++;   // 匹配空串时必须前进
  }

  if (hit) {
    hit.innerHTML = marks.length
      ? `<span class="hit-count">命中 ${marks.length} 处</span>`
      : `<span class="hit-none">没有命中</span>`;
  }

  // 输出
  let html = "";
  let cur = 0;
  for (const mark of marks) {
    html += escapeHtml(text.slice(cur, mark.index));
    if (replacement) {
      // 有替换：展开 $1 $2 捕获组，把替换结果用 <mark> 包住
      html += `<span class="hit">${escapeHtml(expandReplacement(replacement, mark.match))}</span>`;
    } else {
      // 无替换：加删除线淡化
      html += `<span class="removed">${escapeHtml(mark.match[0])}</span>`;
    }
    cur = mark.end;
  }
  html += escapeHtml(text.slice(cur));

  if (marks.length === 0) {
    html = `<span class="empty">这段文本里没匹配到——换个例子试试</span>\n\n${html}`;
  }

  out.innerHTML = html;
}

/**
 * 展开 $1 $2 捕获组引用。
 * 简化版：只支持 $1..$9（多数用例够用；$10 以上要写 \$10）。
 * match 是 re.exec 返回的完整数组，match[1]..match[9] 就是捕获组。
 */
function expandReplacement(template, match) {
  if (!template.includes("$")) return template;
  return template.replace(/\$(\d+)/g, (whole, n) => {
    const idx = Number(n);
    if (idx < 1 || idx > 9) return whole;   // 越界：原样保留
    return match[idx] ?? "";   // 没捕获到就当空串（跟 replace 语义一致）
  });
}

/* ── 绑定 ─────────────────────────────────────────────── */

export function bindRegex() {
  // 抽屉工具条
  document.getElementById("create-regex-btn")?.addEventListener("click", () => openRegexEditor(null));
  document.getElementById("import-regex-btn")?.addEventListener("click", importRegexClick);
  document.getElementById("import-regex-input")?.addEventListener("change", handleImportRegexFile);

  // 编辑弹窗
  document.getElementById("regex-modal-close")?.addEventListener("click", closeRegexEditor);
  document.getElementById("regex-modal-cancel")?.addEventListener("click", closeRegexEditor);
  document.getElementById("regex-modal-save")?.addEventListener("click", saveRegexRule);

  // 实时预览：pattern / flags / replacement 变了就重算
  for (const id of ["rf-pattern", "rf-flags", "rf-replacement", "rf-test-input"]) {
    document.getElementById(id)?.addEventListener("input", updateRegexPreview);
  }

  // 作用域 radio 变了 → 同步下拉
  document.querySelectorAll('input[name="rf-scope-radio"]').forEach(r => {
    r.addEventListener("change", () => syncRegexFields(null));
  });
}
