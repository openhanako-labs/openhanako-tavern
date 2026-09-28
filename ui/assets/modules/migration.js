// migration.js — 备份导出 / 迁移导入界面（2026-09-28 重做）
//
// 为什么要这个界面：手动 replication（复制 app-data JSON）对不上版本时
// 很容易静默丢消息。走 /migration/* 有版本记录与错误回报，导错能发现。
//
// 文件大小、复制、下载都是对「导出产物文件」的操作，
// 产物由后端写到 app-data/exports/。
//
// 结构改造：
//   · 导出信息从"常驻四格"改成"点哪条出哪条"（点中的那条加 accent 左线）
//   · 「跳过已存在的数据」从常驻挪到选完文件之后才问
//   · 导出记录行：名字 + 大小 + 相对时间（3 行内）

import { apiFetch, toast, confirmDialog, escapeHtml, extractArray, friendlyError } from "./core.js";
import { dom } from "./dom.js";
import { state } from "./state.js";

/** 选中的导出名（点中才出信息） */
let selectedExportName = null;

/** 选择文件并导入。 */
export function importFile() {
  dom.migrationFileInput?.click();
}

/**
 * 文件选中 → 先问"跳过已存在的数据"，再上传。
 *
 * 「跳过已存在的数据」以前常驻在 UI 上——但它只在导入时有意义，
 * 平时占地方不说别的，还容易被误勾。挪到选完文件之后才问：
 * 用户已经决定"要导这个文件了"，这时候问"要不要跳过重复的"才有意义。
 */
export async function handleMigrationFile(e) {
  const file = e?.target?.files?.[0];
  if (!file) return;

  const skipExisting = await confirmDialog(
    `导入「${file.name}」时，已存在的同 ID 条目要跳过吗？\n\n` +
    `· 跳过：只加新的，覆盖不了已有的\n` +
    `· 不跳过：同 ID 的直接覆盖本地`
  );

  const formData = new FormData();
  formData.append("file", file);
  formData.append("skipExisting", String(!!skipExisting));

  try {
    const res = await apiFetch("migration/import", { method: "POST", body: formData });
    const data = res.data || res;
    const r = data.result || data;
    const kinds = ["characters", "conversations", "variables", "settings"];
    const added = kinds.reduce((n, k) => n + (r[k]?.added ?? 0), 0);
    const skipped = kinds.reduce((n, k) => n + (r[k]?.skipped ?? 0), 0);
    const failed = kinds.reduce((n, k) => n + (r[k]?.errors?.length ?? 0), 0);
    const parts = [`新增 ${added}`];
    if (skipped) parts.push(`跳过 ${skipped}`);
    if (failed) parts.push(`失败 ${failed}`);
    toast(`导入完成：${parts.join("、")}`, failed ? "error" : "success");
    // 结果也进 #import-result 里留个底
    const resultEl = document.getElementById("import-result");
    if (resultEl) {
      resultEl.classList.remove("hidden");
      resultEl.textContent = `导入「${file.name}」：${parts.join("、")}`;
    }
    await loadExports();
  } catch (err) {
    toast("导入失败: " + friendlyError(err), "error");
  } finally {
    if (e?.target) e.target.value = "";
  }
}

/** 列导出产物。 */
export async function loadExports() {
  try {
    const res = await apiFetch("migration/exports");
    const list = extractArray(res);
    state.exportList = list;
    // 如果之前选中的那条已经不在了（被删了），清掉
    if (selectedExportName && !list.some(f => (f.name || f.filename) === selectedExportName)) {
      selectedExportName = null;
    }
    renderExports(list);
  } catch (e) {
    console.error("[Migration] load failed:", e);
    toast("加载失败: " + friendlyError(e), "error");
  }
}

/** 渲染导出产物列表：点中才出信息。 */
export function renderExports(list) {
  const el = dom.exportsListEl;
  if (!el) return;
  const arr = Array.isArray(list) ? list : [];

  if (arr.length === 0) {
    el.innerHTML = '<div class="empty">暂无导出文件<br><span class="hint">点「导出全部」生成一份</span></div>';
    if (dom.exportInfoEl) dom.exportInfoEl.classList.add("hidden");
    return;
  }

  el.innerHTML = arr.map(f => {
    const name = f.name || f.filename || "";
    const isSelected = name === selectedExportName;
    return `<div class="exp-row${isSelected ? " is-selected" : ""}" data-name="${escapeHtml(name)}">
      <span class="exp-name">${escapeHtml(name)}</span>
      <span class="exp-size">${formatFileSize(f.size)}</span>
      <span class="exp-time">${relativeTime(f.createdAt || f.modified)}</span>
    </div>`;
  }).join("");

  el.querySelectorAll(".exp-row").forEach(row => {
    row.addEventListener("click", () => {
      selectedExportName = row.dataset.name;
      // 直接改 DOM 状态，不整块重绘
      el.querySelectorAll(".exp-row").forEach(r => r.classList.remove("is-selected"));
      row.classList.add("is-selected");
      renderExportInfo(selectedExportName, arr);
    });
  });

  // 默认不选任何一条（跟"点哪条出哪条"一致）
  renderExportInfo(selectedExportName, arr);
}

/**
 * 渲染选中导出的详情（点中才出）。
 * 4 格：角色卡 / 对话 / 变量 / 设定
 */
function renderExportInfo(name, list) {
  const el = dom.exportInfoEl;
  if (!el) return;
  if (!name) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  const item = list.find(f => (f.name || f.filename) === name);
  if (!item) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }

  // 从文件名解析计数（后端返回的 export 里带 summary）
  const summary = item.summary || {};
  el.classList.remove("hidden");
  el.innerHTML = `<div class="ei-hd">
      <span class="ei-name">${escapeHtml(item.name || item.filename || "")}</span>
      <span class="ei-size">${formatFileSize(item.size)}</span>
    </div>
    <div class="ei-grid">
      <div class="ei-cell"><span class="ei-lbl">角色卡</span><span class="ei-val">${summary.characters ?? "-"}</span></div>
      <div class="ei-cell"><span class="ei-lbl">对话</span><span class="ei-val">${summary.conversations ?? "-"}</span></div>
      <div class="ei-cell"><span class="ei-lbl">变量</span><span class="ei-val">${summary.variables ?? "-"}</span></div>
      <div class="ei-cell"><span class="ei-lbl">设定</span><span class="ei-val">${summary.settings ?? "-"}</span></div>
    </div>
    <div class="ei-acts">
      <button class="primary" data-act="download">下载</button>
      <button data-act="copy">复制 JSON</button>
      <button data-act="delete">删除</button>
    </div>`;

  el.querySelector('[data-act="download"]')?.addEventListener("click", () => downloadExportFile(name));
  el.querySelector('[data-act="copy"]')?.addEventListener("click", () => copyExport(name));
  el.querySelector('[data-act="delete"]')?.addEventListener("click", () => deleteExportFile(name));
}

/** 下载指定导出文件。 */
export async function downloadExportFile(name) {
  if (!name) { toast("缺少文件名", "error"); return; }
  try {
    const url = `${hana?.api?.baseUrl || "/api/apps/eleckoi-tavern/routes"}/migration/exports/${encodeURIComponent(name)}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    toast("下载失败: " + friendlyError(e), "error");
  }
}

/** 复制导出内容到剪贴板。 */
export async function copyExport(name) {
  if (!name) { toast("缺少文件名", "error"); return; }
  try {
    const res = await apiFetch(`migration/exports/${encodeURIComponent(name)}`);
    const data = res.data || res;
    await navigator.clipboard.writeText(typeof data === "string" ? data : JSON.stringify(data, null, 2));
    toast("已复制到剪贴板", "success");
  } catch (e) {
    toast("复制失败: " + friendlyError(e), "error");
  }
}

/** 删除导出产物。 */
export async function deleteExportFile(name) {
  const ok = await confirmDialog(`删除导出文件 ${name}？`);
  if (!ok) return;
  try {
    await apiFetch(`migration/exports/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (selectedExportName === name) selectedExportName = null;
    await loadExports();
  } catch (e) {
    toast("删除失败: " + friendlyError(e), "error");
  }
}

/** 字节数转可读大小。 */
export function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 相对时间：3 行内看完。
 *   · 今天：HH:MM
 *   · 昨天：昨天 HH:MM
 *   · 本周：周几
 *   · 本月：MM-DD
 *   · 更早：YYYY-MM-DD
 */
function relativeTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts).slice(0, 16).replace("T", " ");
  const now = new Date();
  const diff = now - d;
  const day = 24 * 3600 * 1000;
  if (d.toDateString() === now.toDateString()) {
    return d.toTimeString().slice(0, 5);
  }
  if (diff < 2 * day) {
    return `昨天 ${d.toTimeString().slice(0, 5)}`;
  }
  const dow = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  if (diff < 7 * day) {
    return `周${dow}`;
  }
  if (d.getFullYear() === now.getFullYear()) {
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 导出全部数据。 */
export async function exportAll() {
  try {
    const res = await apiFetch("migration/export", { method: "POST", body: JSON.stringify({}) });
    const data = res.data || res;
    toast(`已导出：${data.filename || data.name || ""}`, "success");
    state.lastExportData = data;
    await loadExports();
  } catch (e) {
    toast("导出失败: " + friendlyError(e), "error");
  }
}
