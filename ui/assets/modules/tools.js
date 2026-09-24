// tools.js — 工具列表与工具组开关界面
//
// 只读 + 一个开关动作：工具本身在 defineApp 时就注册完了，
// 改开关要重启 App 才生效（端点如实返回这点，不假装热生效）。

import { apiFetch, toast, escapeHtml, extractArray, friendlyError } from "./core.js";
import { dom } from "./dom.js";
import { state } from "./state.js";

/**
 * 拉工具列表与组开关并渲染。
 *
 * 两个列表分开：上面是分组的开关，下面是该组下的工具明细。
 * 组关了，明细里对应的行会淡掉——比只改开关更容易看懂影响面。
 */
export async function loadTools() {
  try {
    // 端点名是 `tools/groups` / `tools/info`。
    // 之前这里写的是 `tool-groups` / `tools`——两条都不存在，
    // 所以这个面板从来没加载出来过（表现是弹一个「加载失败」）。
    const [groupsRes, infoRes] = await Promise.all([
      apiFetch("tools/groups"),
      apiFetch("tools/info")
    ]);
    state.toolGroups = extractArray(groupsRes);
    state.toolList = flattenTools(state.toolGroups, extractArray(infoRes));
    renderToolGroups(state.toolGroups);
    renderTools(state.toolList);
  } catch (e) {
    console.error("[Tools] load failed:", e);
    toast("加载失败: " + friendlyError(e), "error");
  }
}

/**
 * 拼出界面上那一份工具明细（渲染要 `{name, group, description}`）。
 *
 * 「工具名→组」的归属在后端（TOOL_GROUPS），「工具的说明」在宿主
 * （sdk.tools.list）。两边各只有一半，所以在这里合。
 * **宿主不报 list 时照样出得了明细**——组那半份是权威的，
 * 说明那半份有就补上、没有就空着。
 */
function flattenTools(groups, known) {
  const desc = new Map();
  for (const t of known) if (t && t.name) desc.set(t.name, t.description || "");

  const rows = [];
  const claimed = new Set();
  for (const g of groups) {
    for (const name of g.tools || []) {
      claimed.add(name);
      rows.push({ name, group: g.id, description: desc.get(name) || "" });
    }
  }
  // 宿主报了、但没有组认领的（自加工具）：后端的 isToolEnabled 对这类默认放行，
  // 界面也得把它亮出来——否则「默认放行」的东西在面板上看不见，开关就名不副实。
  for (const t of known) {
    if (t && t.name && !claimed.has(t.name)) {
      rows.push({ name: t.name, group: "", description: t.description || "" });
    }
  }
  return rows;
}

/** 渲染工具组开关。 */
export function renderToolGroups(groups) {
  const el = dom.toolGroupsEl || document.getElementById("tool-groups-list");
  if (!el) return;
  const arr = Array.isArray(groups) ? groups : [];
  if (arr.length === 0) { el.innerHTML = ""; return; }

  el.innerHTML = arr.map(g => `<div class="tool-group${g.enabled ? "" : " off"}" data-id="${escapeHtml(g.id)}">
      <span class="g-name">${escapeHtml(g.name || g.id)}</span>
      <label class="switch" title="重启 App 后生效">
        <input type="checkbox" data-g="${escapeHtml(g.id)}" ${g.enabled ? "checked" : ""}>
        <span></span>
      </label>
    </div>`).join("");

  el.querySelectorAll('input[data-g]').forEach(cb => {
    cb.addEventListener("change", async () => {
      const id = cb.dataset.g;
      const on = cb.checked;
      try {
        await apiFetch(`tools/groups/${encodeURIComponent(id)}/toggle`, {
          method: "PUT",
          body: JSON.stringify({ enabled: on })
        });
        toast(`已保存，重启 App 后生效`, "success");
        // 本地先反映出来，不重拉（重拉会读回旧值造成"开关没反应"的错觉）
        const g = (state.toolGroups || []).find(x => x.id === id);
        if (g) g.enabled = on;
        renderTools(state.toolList || []);
      } catch (e) {
        toast("保存失败: " + friendlyError(e), "error");
        cb.checked = !on;
      }
    });
  });
}

/** 渲染工具明细；所属组关闭的行淡掉。 */
export function renderTools(tools) {
  const el = dom.toolsListEl || document.getElementById("tools-list");
  if (!el) return;
  const arr = Array.isArray(tools) ? tools : [];
  const groups = state.toolGroups || [];
  const off = new Set(groups.filter(g => g.enabled === false).map(g => g.id));

  if (dom.toolsCountEl) {
    const on = arr.filter(t => !off.has(t.group)).length;
    dom.toolsCountEl.textContent = `${on} / ${arr.length} 启用`;
  }

  el.innerHTML = arr.map(t => {
    const disabled = off.has(t.group);
    return `<div class="tool-row${disabled ? " off" : ""}">
      <code class="t-name">${escapeHtml(t.name)}</code>
      <span class="t-group">${escapeHtml(t.group || "")}</span>
      <div class="t-desc">${escapeHtml(t.description || "")}</div>
    </div>`;
  }).join("");
}
