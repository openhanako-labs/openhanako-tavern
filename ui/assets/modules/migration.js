// migration.js — 备份导出 / 迁移导入界面
//
// 为什么要这个界面：手动 replication（复制 app-data JSON）对不上版本时
// 很容易静默丢消息。走 /migration/* 有版本记录与错误回报，导错能发现。
//
// 文件大小、复制、下载都是对「导出产物文件」的操作，
// 产物由后端写到 app-data/exports/。

import { apiFetch, toast, confirmDialog, escapeHtml, extractArray, friendlyError } from "./core.js";
import { dom } from "./dom.js";
import { state } from "./state.js";

/** 选择文件并导入。 */
export async function importFile() {
  dom.migrationFileInput?.click();
}

/** 文件选中 → 上传给后端导入。 */
export async function handleMigrationFile(e) {
  const file = e?.target?.files?.[0];
  if (!file) return;
  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await apiFetch("migration/import", { method: "POST", body: formData });
    const data = res.data || res;
    const r = data.result || data;
    toast(`导入完成：角色 ${r.characters?.added ?? 0}、对话 ${r.conversations?.added ?? 0}`, "success");
    await loadExports();
  } catch (err) {
    toast("导入失败: " + friendlyError(err), "error");
  } finally {
    e.target.value = "";
  }
}

/** 列导出产物。 */
export async function loadExports() {
  try {
    const res = await apiFetch("migration/exports");
    const list = extractArray(res);
    state.exportList = list;
    renderExports(list);
  } catch (e) {
    console.error("[Migration] load failed:", e);
    toast("加载失败: " + friendlyError(e), "error");
  }
}

/** 渲染导出产物列表。 */
export function renderExports(list) {
  const el = dom.exportsListEl;
  if (!el) return;
  const arr = Array.isArray(list) ? list : [];

  if (el) {
    el.innerHTML = arr.length === 0
      ? '<div class="empty">暂无导出文件<br><span class="hint">点「导出全部」生成一份</span></div>'
      : arr.map(f => `<div class="export-row" data-name="${escapeHtml(f.name || f.filename)}">
          <span class="f-name">${escapeHtml(f.name || f.filename)}</span>
          <span class="f-size">${formatFileSize(f.size)}</span>
          <span class="f-date">${escapeHtml(f.createdAt || f.modified || "")}</span>
          <span class="f-acts">
            <button class="mini" data-act="download">下载</button>
            <button class="mini" data-act="copy">复制</button>
            <button class="mini danger" data-act="delete">删除</button>
          </span>
        </div>`).join("");

    el.querySelectorAll(".export-row").forEach(row => {
      const name = row.dataset.name;
      row.querySelector('[data-act="download"]')?.addEventListener("click", () => downloadExportFile(name));
      row.querySelector('[data-act="copy"]')?.addEventListener("click", () => copyExport(name));
      row.querySelector('[data-act="delete"]')?.addEventListener("click", () => deleteExportFile(name));
    });
  }

  if (dom.exportInfoEl) {
    const latest = arr[0];
    dom.exportInfoEl.textContent = latest
      ? `最近导出：${latest.name || latest.filename}（${formatFileSize(latest.size)}）`
      : "";
  }
}

/** 下载当前选中的导出。 */
export async function downloadExport() {
  const sel = state.exportList?.[0];
  if (!sel) { toast("没有可下载的导出", "error"); return; }
  await downloadExportFile(sel.name || sel.filename);
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
