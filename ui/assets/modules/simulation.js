// ui/assets/modules/simulation.js — 模拟经营面板（第 9 期）
//
// 入口：左栏「经营」。5×5 网格，每格显示槽位状态（生长进度/库存），
// 点格子出操作（种/收/摘）。tick 是惰性的——打开面板就是一次结算，
// 离开几分钟回来会看到"成熟了/卖出了"的事件提示。

import { apiFetch, unwrap, escapeHtml, toast, friendlyError } from "./core.js";
import { state } from "./state.js";

let bound = false;
function el(id) { return document.getElementById(id); }

function cellHtml(cell, i) {
  const s = cell.slot;
  let inner = `<div class="sim-cell-empty">空</div>`;
  if (s) {
    if (s.kind === "grow") {
      const pct = Math.min(100, Math.floor(((s.progress || 0) / (currentGrowSeconds() * 1000 / 1000 || 1)) * 100 / 1));
      const p = Math.min(100, Math.round(((s.progress || 0) / (window.__simGrowSeconds || 60)) * 100));
      inner = `<div class="sim-cell-grow">${escapeHtml(s.item)}${s.ready ? `<div class="sim-ready">成熟</div>` : `<div class="sim-bar"><div style="width:${p}%"></div></div>`}</div>`;
    } else {
      inner = `<div class="sim-cell-grow">${escapeHtml(s.item)}<div class="sim-stock">库存 ${s.stock} · 已赚 ${s.earned || 0}</div></div>`;
    }
  }
  return `<div class="sim-cell" data-cell="${i}" title="第 ${i + 1} 格">${inner}</div>`;
}

let currentFarm = null;
function currentGrowSeconds() { return currentFarm?.config?.growSeconds || 60; }

function render(farm, events = []) {
  currentFarm = farm;
  const box = el("sim-body");
  if (!box) return;
  const grid = farm.grid || [];
  box.innerHTML = `
    ${events.length ? `<div class="sim-events">${events.map(e => `· ${escapeHtml(e.text)}`).join("<br>")}</div>` : ""}
    <div class="sim-grid">${grid.map((c, i) => cellHtml(c, i)).join("")}</div>
    <div class="hint" style="margin-top:8px">点格子操作：空格种下（生长型/上架消耗型）、成熟收获、任意格摘除。</div>
    <div id="sim-op" style="margin-top:6px"></div>`;

  box.querySelectorAll(".sim-cell").forEach(cellEl => {
    cellEl.addEventListener("click", () => showOps(Number(cellEl.dataset.cell)));
  });
}

function showOps(i) {
  const op = el("sim-op");
  if (!op || !currentFarm) return;
  const cell = currentFarm.grid[i];
  const s = cell?.slot;
  let html = `<div class="bg-row" style="gap:6px;flex-wrap:wrap">`;
  if (!s) {
    html += `<input id="sim-item" placeholder="名字（如：霜麦）" style="flex:1;min-width:100px;font:inherit;padding:4px 8px">
      <button class="btn btn-sm" data-op="grow" data-cell="${i}">种下（生长）</button>
      <button class="btn btn-sm" data-op="consume" data-cell="${i}">上架（售卖）</button>`;
  } else if (s.kind === "grow") {
    html += `<button class="btn btn-sm" data-op="harvest" data-cell="${i}" ${s.ready ? "" : "disabled"}>收获（${escapeHtml(s.item)}${s.ready ? "" : "，未成熟"}）</button>
      <button class="btn btn-sm danger" data-op="clear" data-cell="${i}">摘除</button>`;
  } else {
    html += `<button class="btn btn-sm danger" data-op="clear" data-cell="${i}">下架（已赚 ${s.earned || 0}）</button>`;
  }
  html += `</div>`;
  op.innerHTML = html;

  op.querySelectorAll("[data-op]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const cell2 = Number(btn.dataset.cell);
      const op2 = btn.dataset.op;
      const conv = state.currentConv;
      if (!conv) return;
      try {
        if (op2 === "grow" || op2 === "consume") {
          const item = el("sim-item")?.value?.trim() || (op2 === "grow" ? "作物" : "商品");
          await apiFetch(`conversations/${conv.id}/simulation/plant`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cell: cell2, kind: op2, item })
          });
        } else if (op2 === "harvest") {
          const r = unwrap(await apiFetch(`conversations/${conv.id}/simulation/harvest`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cell: cell2 })
          })) || {};
          toast(`收获 ${r["yield"]} × ${r.item}（进了对话变量）`, "success");
        } else if (op2 === "clear") {
          await apiFetch(`conversations/${conv.id}/simulation/clear`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cell: cell2 })
          });
        }
        await refresh();
      } catch (e) {
        toast(`失败：${friendlyError(e)}`, "error");
      }
    });
  });
}

async function refresh() {
  const conv = state.currentConv;
  if (!conv) return;
  try {
    const env = await apiFetch(`conversations/${encodeURIComponent(conv.id)}/simulation`);
    const d = unwrap(env) || {};
    render(d.farm || { grid: [] }, d.events || []);
  } catch (e) {
    toast(`拉取失败：${friendlyError(e)}`, "error");
  }
}

/** 绑定（main.js 调一次）。幂等。 */
export function bindSimulation() {
  if (bound) return;
  bound = true;
  el("sim-open")?.addEventListener("click", async () => {
    if (!state.currentConv) { toast("经营挂在这一场对话上——先打开一场", "error"); return; }
    el("sim-modal")?.classList.remove("hidden");
    await refresh();
  });
  el("sim-close")?.addEventListener("click", () => el("sim-modal")?.classList.add("hidden"));
  el("sim-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "sim-modal") el("sim-modal")?.classList.add("hidden");
  });
}

export default { bindSimulation };
