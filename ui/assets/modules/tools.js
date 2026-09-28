// tools.js — 工具列表与工具组开关界面（2026-09-28 重做）
//
// 只读 + 一个开关动作：工具本身在 defineApp 时就注册完了，
// 改开关要重启 App 才生效（端点如实返回这点，不假装热生效）。
//
// 结构改成正向因果：组是"因"（开了这一整类才可用），组下的工具是"果"。
// 组关了 → 组下的行自己淡掉（opacity + 删除线），影响面一眼可见。

import { apiFetch, toast, escapeHtml, extractArray, friendlyError } from "./core.js";
import { dom } from "./dom.js";
import { state } from "./state.js";
import { emptyHtml } from "./drawer-state.js";

/**
 * 拉工具列表与组开关并渲染。
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

/**
 * 渲染工具组：每个组一行（折叠箭头 + 组名 + "N 个" + 开关），
 * 组下面直接挂着它的工具明细（可折叠）。
 *
 * 宿主报了、但没有组认领的工具（自加工具）单独成一组，标记为"自加"。
 */
export function renderToolGroups(groups) {
  const el = dom.toolGroupsEl || document.getElementById("tool-groups-list");
  if (!el) return;
  const arr = Array.isArray(groups) ? groups : [];
  const tools = state.toolList || [];

  // 分组：按 group id 收拢
  const byGroup = new Map();
  for (const t of tools) {
    const key = t.group || "";
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(t);
  }

  if (arr.length === 0 && byGroup.size === 0) {
    // 空态：工具清单是后端注册的，正常不会空——真空了要能看出是“没拉到”
    el.innerHTML = emptyHtml({
      ico: "⚒",
      title: "没读到工具清单",
      desc: "工具由 App 启动时注册。这份清单为空说明后端没回数据，不是你没开——重启 App 后再看。"
    });
    if (dom.toolsCountEl) dom.toolsCountEl.textContent = "";
    return;
  }

  // 计数：开了的组里的工具数 / 总数
  const offGroups = new Set(arr.filter(g => g.enabled === false).map(g => g.id));
  const totalTools = tools.length;
  const onTools = tools.filter(t => !offGroups.has(t.group)).length;
  if (dom.toolsCountEl) {
    dom.toolsCountEl.textContent = `${arr.length} 组 · ${onTools}/${totalTools} 启用`;
  }

  el.innerHTML = arr.map(g => renderGroupCard(g, byGroup.get(g.id) || [], offGroups.has(g.id))).join("")
    + (byGroup.has("") ? renderUnclaimed(byGroup.get("") || [], tools) : "");

  // 折叠：点组头展开/收起（默认展开）
  el.querySelectorAll(".tool-group-card").forEach(card => {
    card.querySelector(".tool-group-hd")?.addEventListener("click", (e) => {
      // 点在开关上不算折叠
      if (e.target.closest(".tg-switch")) return;
      card.classList.toggle("is-open");
    });
  });

  // 开关
  el.querySelectorAll(".tg-switch").forEach(sw => {
    sw.addEventListener("click", async () => {
      const id = sw.dataset.g;
      const on = !sw.classList.contains("is-on");
      try {
        await apiFetch(`tools/groups/${encodeURIComponent(id)}/toggle`, {
          method: "PUT",
          body: JSON.stringify({ enabled: on })
        });
        toast(`已保存，重启 App 后生效`, "success");
        // 本地先反映出来，不重拉（重拉会读回旧值造成"开关没反应"的错觉）
        const g = (state.toolGroups || []).find(x => x.id === id);
        if (g) g.enabled = on;
        // 直接改 DOM 状态，不整块重绘（重绘会丢折叠状态）
        sw.classList.toggle("is-on", on);
        const card = sw.closest(".tool-group-card");
        card?.classList.toggle("is-off", !on);
      } catch (e) {
        toast("保存失败: " + friendlyError(e), "error");
      }
    });
  });
}

function renderGroupCard(g, tools, isOff) {
  const open = !isOff;  // 关了的组默认折叠，开着的展开
  const count = tools.length;
  return `<div class="tool-group-card${isOff ? " is-off" : ""}${open ? " is-open" : ""}" data-id="${escapeHtml(g.id)}">
    <div class="tool-group-hd">
      <span class="tg-arrow">▸</span>
      <span class="tg-name">${escapeHtml(g.name || g.id)}</span>
      <span class="tg-count">${count} 个</span>
      <span class="tg-switch${g.enabled ? " is-on" : ""}" data-g="${escapeHtml(g.id)}" role="switch" aria-checked="${g.enabled}" title="重启 App 后生效"></span>
    </div>
    <div class="tool-group-body">
      ${tools.map(t => renderToolRow(t)).join("")}
    </div>
  </div>`;
}

/**
 * 自加工具组：宿主报了、但没有组认领的。
 * 后端 isToolEnabled 对这类默认放行——界面得把它亮出来，
 * 否则"默认放行"的东西在面板上看不见，开关就名不副实。
 */
function renderUnclaimed(tools, allTools) {
  if (tools.length === 0) return "";
  return `<div class="tool-group-card is-open is-unclaimed" data-id="_unclaimed">
    <div class="tool-group-hd">
      <span class="tg-arrow">▸</span>
      <span class="tg-name">自加工具</span>
      <span class="tg-count">${tools.length} 个</span>
      <span class="tg-switch is-on" data-g="_unclaimed" role="switch" aria-checked="true" title="后端默认放行，不可关"></span>
    </div>
    <div class="tool-group-body">
      ${tools.map(t => renderToolRow(t)).join("")}
    </div>
  </div>`;
}

/**
 * 工具行。
 * "说明"那半份来自宿主，可能拿不到——拿不到时只显示工具名，不显示成空。
 */
function renderToolRow(t) {
  const desc = t.description ? `<div class="tdesc">${escapeHtml(t.description)}</div>` : "";
  return `<div class="trow">
    <div class="tname">${escapeHtml(t.name)}</div>
    ${desc}
  </div>`;
}
