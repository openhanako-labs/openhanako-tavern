// variables.js — 变量界面逻辑
//
// 变量分两类：定义（叫什么、什么类型、默认值）与值（某对话/全局的实际内容）。
// 界面只编辑定义；值在对话里随对话走，这里提供「测试替换」预览当前生效值。
//
// 后端：lib/variables/routes.js。

import { apiFetch, toast, confirmDialog, escapeHtml, extractArray, friendlyError } from "./core.js";
import { dom, showEditForm } from "./dom.js";
import { state } from "./state.js";
import { emptyHtml, errHtml } from "./drawer-state.js";

const TYPES = ["string", "number", "boolean", "object", "array"];

/** 拉定义列表并渲染。 */
export async function loadVariables() {
  try {
    const res = await apiFetch("variables");
    const list = extractArray(res);
    state.variableList = list;
    renderVariables(list);
    // 值也要拉：抽屉一开，两边都得是最新的
    await loadConvValues();
  } catch (e) {
    console.error("[Variables] load failed:", e);
    // 错误态：分清是谁的错（不是“加载失败”四个字了事）
    if (dom.variablesListEl) {
      dom.variablesListEl.innerHTML = errHtml("没能读到变量", "连接宿主 App 服务失败：" + friendlyError(e) + "。这不是你的数据出了问题。");
    }
    toast("加载失败: " + friendlyError(e), "error");
  }
}

/** 渲染定义列表。 */
export function renderVariables(list) {
  if (!dom.variablesListEl) return;
  const arr = Array.isArray(list) ? list : [];

  if (dom.variablesCountEl) {
    dom.variablesCountEl.textContent = arr.length > 0 ? `${arr.length} 个` : "";
  }
  if (arr.length === 0) {
    // 空态写“没有的是什么” + 这个功能是干什么的（docs/spec-drawer.md 第四节）
    dom.variablesListEl.innerHTML = emptyHtml({
      ico: "{}",
      title: "还没有变量定义",
      desc: "定义决定叫什么、什么类型；值在下面「这一场」里，由对话里的 {{setvar}} 写进去。",
      action: "+ 新建一个",
      act: "new"
    });
    dom.variablesListEl.querySelector('[data-act="new"]')?.addEventListener("click", () => openVariableEditor(null));
    return;
  }

  dom.variablesListEl.innerHTML = arr.map(v => `<div class="var-card" data-id="${escapeHtml(v.id)}">
      <div class="var-head">
        <code class="vf-name">${escapeHtml(v.name)}</code>
        <span class="vf-type">${escapeHtml(v.type || "string")}</span>
      </div>
      <div class="vf-description">${escapeHtml(v.description || "")}</div>
      <div class="var-meta">
        <span class="scope">${escapeHtml(v.scope || "conversation")}</span>
        ${v.hidden ? '<span class="flag">对模型隐藏</span>' : ""}
      </div>
      <div class="var-actions">
        <button class="mini" data-act="edit">编辑</button>
        <button class="mini danger" data-act="delete">删除</button>
      </div>
    </div>`).join("");

  dom.variablesListEl.querySelectorAll(".var-card").forEach(card => {
    const id = card.dataset.id;
    card.querySelector('[data-act="edit"]')?.addEventListener("click", () => openVariableEditor(id));
    card.querySelector('[data-act="delete"]')?.addEventListener("click", () => deleteVariable(id));
  });
}

/**
 * 拉「这一场正在生效的值」。
 *
 * 为什么要单开一块：定义列表回答的是「叫什么、什么类型」，
 * 而我这一刻真正会读到的是**值**——回复里的 {{setvar}} 写的就是它。
 * 之前界面上没有任何地方能看到它，只能猜一个宏名往「测试替换」里敲。
 *
 * 只读：值由对话持有。要改就改对话里那一笔，
 * 不然会和宏写回的值互相盖（那正是当初把所有变量写收敛到一个回调的原因）。
 */
export async function loadConvValues() {
  if (!dom.convVarsListEl) return;
  const conv = state.currentConv;
  if (!conv) {
    renderConvValues(null);
    return;
  }
  try {
    const res = await apiFetch(`conversations/${conv.id}/variables`);
    const data = res?.data ?? res;
    renderConvValues(data?.variables ?? data ?? {});
  } catch (e) {
    dom.convVarsListEl.innerHTML =
      `<div class="empty">读不到这一场的值：${escapeHtml(friendlyError(e))}</div>`;
  }
}

/** 渲染「这一场」的值列表。空值说人话，且说清它从哪来。 */
export function renderConvValues(vars) {
  if (!dom.convVarsListEl) return;
  const obj = vars && typeof vars === "object" ? vars : null;
  const names = obj ? Object.keys(obj).sort() : [];

  if (dom.convVarsCountEl) {
    dom.convVarsCountEl.textContent = obj && names.length > 0 ? `${names.length} 个` : "";
  }
  // 存一份：下面的「测试替换」不填 JSON 时就拿这一场的值跑
  state.convVars = obj || {};

  if (!obj) {
    dom.convVarsListEl.innerHTML = '<div class="empty">（还没打开对话）</div>';
    return;
  }
  if (names.length === 0) {
    dom.convVarsListEl.innerHTML =
      '<div class="empty">这一场还没有取值<br><span class="hint">回复里的 {{setvar}} 写的就是这里</span></div>';
    return;
  }

  dom.convVarsListEl.innerHTML = names.map((n) => {
    const raw = obj[n];
    const full = typeof raw === "string" ? raw : JSON.stringify(raw);
    const text = String(full ?? "");
    const short = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    return `<div class="conv-var">
        <code class="vf-name">${escapeHtml(n)}</code>
        <span class="cv-val" title="${escapeHtml(text)}">${escapeHtml(short)}</span>
      </div>`;
  }).join("");
}

/** 打开编辑器；id 为空 → 新建。 */
export async function openVariableEditor(id) {
  try {
    if (id) {
      const res = await apiFetch(`variables/${encodeURIComponent(id)}`);
      state.currentVariable = res.data || res;
    } else {
      state.currentVariable = {
        id: null, name: "", type: "string", description: "",
        scope: "conversation", defaultValue: null, hidden: false
      };
    }
    state.currentForm = "variable";
    fillVariableForm(state.currentVariable);
    showEditForm("variable");   // 不显示自己那张表单，弹窗就是个空壳
    dom.modalEl?.classList.remove("hidden");
  } catch (e) {
    toast("打开失败: " + friendlyError(e), "error");
  }
}

function fillVariableForm(v) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ""; };
  set("vf-name", v.name || "");
  set("vf-type", v.type || "string");
  set("vf-description", v.description || "");
  set("vf-scope", v.scope || "conversation");
  set("vf-default", v.defaultValue == null ? "" : String(v.defaultValue));
  const hid = document.getElementById("vf-visible");
  if (hid) hid.checked = v.hidden === true;
}

/** 保存定义。 */
export async function saveVariable() {
  const v = state.currentVariable;
  if (!v) return;
  const val = (id) => document.getElementById(id)?.value ?? "";

  const name = val("vf-name").trim();
  if (!name) { toast("变量名不能为空", "error"); return; }
  if (!/^[A-Za-z_][\w]*$/.test(name)) {
    toast("变量名只能是字母/数字/下划线，且不以数字开头", "error");
    return;
  }

  const type = val("vf-type") || "string";
  let def = val("vf-default");
  if (def !== "") {
    // 按类型收窄，避免把 "3" 当数字还是字符串搞混
    if (type === "number") { const n = Number(def); if (!Number.isFinite(n)) { toast("默认值不是合法数字", "error"); return; } def = n; }
    else if (type === "boolean") def = (def === "true" || def === "1");
    else if (type === "object" || type === "array") {
      try { def = JSON.parse(def); } catch { toast("默认值不是合法 JSON", "error"); return; }
    }
  }

  const body = {
    name,
    type,
    description: val("vf-description"),
    scope: val("vf-scope") || "conversation",
    defaultValue: def,
    hidden: document.getElementById("vf-visible")?.checked === true
  };

  try {
    if (v.id) await apiFetch(`variables/${encodeURIComponent(v.id)}`, { method: "PUT", body: JSON.stringify(body) });
    else await apiFetch("variables", { method: "POST", body: JSON.stringify(body) });

    state.currentVariable = null;
    state.currentForm = null;
    dom.modalEl?.classList.add("hidden");
    await loadVariables();
    toast("已保存", "success");
  } catch (e) {
    toast("保存失败: " + friendlyError(e), "error");
  }
}

/** 删除定义。删了之后引用它的宏会原样保留（不吃内容）。 */
export async function deleteVariable(id) {
  const ok = await confirmDialog("删除这个变量定义？已写入的值不会被清除，但宏将读不到它。");
  if (!ok) return;
  try {
    await apiFetch(`variables/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadVariables();
    toast("已删除", "success");
  } catch (e) {
    toast("删除失败: " + friendlyError(e), "error");
  }
}

export function handleVariableAction(action, id) {
  if (action === "edit") openVariableEditor(id);
  else if (action === "delete") deleteVariable(id);
}

/**
 * 测试替换：拿一段文本跑一遍宏，看变量是否正确展开。
 *
 * 读的是**它自己那张卡里的字段**（输入文本 + 变量值 JSON）。
 * 原先读的是 `#vf-test-input`——一个没有标题、贴在抽屉顶部的孤儿框；
 * 用户会填的却是标着「输入文本」的这个，填了也对不上。
 * 那个孤儿已经删掉（连同 `#vf-test-output`）。
 *
 * 不填 JSON 就用**这一场的真实值**：面板上下两块本来就该是同一个东西，
 * （上面刚能看到值，这里却要人手输一遗，那就成了两个口径）。
 *
 * `references` 也要显示：它列出文本里引用的变量名——
 * 名字写错时一眼能看出来，那才是这个工具存在的理由。
 */
export async function testReplace() {
  const text = document.getElementById("replace-test-input")?.value ?? "";
  const rawVars = document.getElementById("replace-test-vars")?.value ?? "";
  const box = document.getElementById("replace-test-result");
  if (!text.trim()) { toast("先输入要测试的文本", "error"); return; }
  if (!box) return;

  let vars = null;
  if (rawVars.trim()) {
    try {
      const parsed = JSON.parse(rawVars);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        toast("变量值要是一个 JSON 对象", "error");
        return;
      }
      vars = parsed;
    } catch (e) {
      toast("变量值不是合法 JSON：" + friendlyError(e), "error");
      return;
    }
  }
  const usedReal = vars === null;
  if (usedReal) vars = state.convVars || {};

  box.classList.remove("hidden");
  try {
    const res = await apiFetch("variables/test-replace", {
      method: "POST",
      body: JSON.stringify({ text, variables: vars })
    });
    const data = res.data || res;
    const nameOf = (r) => (typeof r === "string" ? r : r?.name || "");
    const refs = (Array.isArray(data.references) ? data.references : []).map(nameOf).filter(Boolean);
    const missing = refs.filter((n) => !(n in vars));

    const lines = [String(data.result ?? "")];
    lines.push("");
    lines.push(usedReal
      ? (Object.keys(vars).length > 0 ? `（用的是这一场的值，共 ${Object.keys(vars).length} 个；在「变量值」里填 JSON 可覆盖）` : "（这一场还没有取值）")
      : "（用的是你填的 JSON）");
    lines.push(refs.length
      ? `引用到的变量：${refs.join("、")}`
      : "没引用到任何变量（{{}} 里的名字得先有定义或在 JSON 里给上值）");
    if (missing.length) lines.push(`值没给：${missing.join("、")}——给上值才会展开`);
    box.textContent = lines.join("\n");
  } catch (e) {
    box.textContent = "失败: " + friendlyError(e);
  }
}
