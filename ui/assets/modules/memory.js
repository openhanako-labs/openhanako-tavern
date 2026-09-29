// memory.js — 记忆面板（S2）
//
// 三格硬编码提到 App 配置：keepRecent / summaryMaxChars / summaryPrompt。
//
// 与模型分选同一个模态语言：顶部体检条、下面分区。
// 保存之后下一次生成即刻生效（不用重启）。
//
// 向量记忆那格只写评估结论，不接开关——lib/embed 现在还没有存储与检索，
// 装了等于没装。评估结论写在方案文档 §四 S2。

import { apiFetch, toast, escapeHtml, friendlyError } from "./core.js";

const $ = (id) => document.getElementById(id);

let config = null;
let embedding = null;

function readEnvelope(res, what) {
  const env = res && typeof res === "object" ? res : {};
  if (env.ok === false) throw new Error(env.error || `${what}被拒绝了`);
  return env.data !== undefined ? env.data : env;
}

/**
 * 拉配置 + 向量状态。两条并行——面板打开时一次看到全部真相。
 */
export async function loadMemory() {
  const [cfgRes, embedRes] = await Promise.all([
    apiFetch("memory/config").catch(() => ({ ok: false, error: "记忆配置未就绪" })),
    apiFetch("embed/status").catch(() => ({ ok: false, error: "embed 未就绪" }))
  ]);

  let healthOk = false;
  try {
    config = readEnvelope(cfgRes, "记忆配置");
    healthOk = true;
  } catch (e) {
    toast(`记忆配置：${friendlyError(e)}`, "error");
    config = null;
  }

  try {
    embedding = readEnvelope(embedRes, "向量状态") || null;
  } catch {
    embedding = null;
  }

  renderHealth(healthOk);
  renderFields();
  renderEmbedding();
}

function renderHealth(ok) {
  const el = $("memory-health");
  if (!el) return;
  el.querySelector(".mh-dot").style.background = ok ? "#5ac877" : "#e56a6a";
  el.querySelector(".mh-title").textContent = ok ? "配置就绪" : "拉不到记忆配置";
  el.querySelector(".mh-sub").textContent = ok
    ? "保存之后下一次生成即刻生效"
    : "保存后不生效——重启 App 或检查数据目录";
}

function renderFields() {
  const kr = $("memory-keep-recent");
  const sm = $("memory-summary-chars");
  const sp = $("memory-summary-prompt");
  const tpl = $("memory-default-prompt");
  if (!kr || !sm || !sp || !tpl) return;

  const c = config || {
    keepRecent: 4,
    summaryMaxChars: 500,
    summaryPrompt: "",
    limits: { keepRecent: { min: 1, max: 40 }, summaryMaxChars: { min: 50, max: 5000 }, summaryPrompt: { maxLength: 4000 } }
  };
  const lim = c.limits || {};

  if (kr.dataset.loaded !== "1") {
    kr.min = lim.keepRecent?.min ?? 1;
    kr.max = lim.keepRecent?.max ?? 40;
    kr.value = c.keepRecent;
    kr.dataset.loaded = "1";
  }
  if (sm.dataset.loaded !== "1") {
    sm.min = lim.summaryMaxChars?.min ?? 50;
    sm.max = lim.summaryMaxChars?.max ?? 5000;
    sm.step = 10;
    sm.value = c.summaryMaxChars;
    sm.dataset.loaded = "1";
  }
  if (sp.dataset.loaded !== "1") {
    sp.maxLength = lim.summaryPrompt?.maxLength ?? 4000;
    sp.value = c.summaryPrompt || "";
    sp.dataset.loaded = "1";
  }
  tpl.textContent = c.defaultSummaryPromptTemplate || "（拉不到默认模板）";
}

function renderEmbedding() {
  const el = $("memory-embed-status");
  if (!el) return;
  if (!embedding) {
    el.innerHTML = `<div class="mh-text" style="margin:0">
      <div class="mh-title">向量能力未就绪</div>
      <div class="mh-sub">lib/embed 拉不到状态——存储与检索那两块还没接</div>
    </div>`;
    return;
  }
  if (embedding.ok && embedding.model) {
    el.innerHTML = `<div class="mh-text" style="margin:0">
      <div class="mh-title">现在能算向量：<code>${escapeHtml(embedding.model || "?")}</code></div>
      <div class="mh-sub">provider：<code>${escapeHtml(embedding.providerId || "?")}</code> · 但没有存储与检索</div>
    </div>`;
  } else {
    el.innerHTML = `<div class="mh-text" style="margin:0">
      <div class="mh-title">向量能力未就绪</div>
      <div class="mh-sub">${escapeHtml(embedding.note || "没有 embedding 模型")}</div>
    </div>`;
  }
}

function collectPatch() {
  const kr = $("memory-keep-recent");
  const sm = $("memory-summary-chars");
  const sp = $("memory-summary-prompt");
  return {
    keepRecent: Number(kr?.value),
    summaryMaxChars: Number(sm?.value),
    summaryPrompt: sp?.value ?? ""
  };
}

export async function saveMemory() {
  const patch = collectPatch();
  const res = await apiFetch("memory/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });
  try {
    config = readEnvelope(res, "保存记忆配置");
    toast("已保存 · 下一次生成即刻生效", "success");
    renderFields();
  } catch (e) {
    toast(`保存失败：${friendlyError(e)}`, "error");
  }
}

export async function openMemory() {
  const modal = $("memory-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  try { await loadMemory(); } catch (e) {
    console.error("[Memory] load failed:", e);
  }
}

export function closeMemory() {
  $("memory-modal")?.classList.add("hidden");
}

/** 幂等绑定：面板按钮 + 遮罩点击关闭。 */
export function bindMemory() {
  const modal = $("memory-modal");
  if (!modal || modal.dataset.bound === "1") return;
  modal.dataset.bound = "1";

  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeMemory();
  });
  $("memory-close")?.addEventListener("click", closeMemory);
  $("memory-cancel")?.addEventListener("click", closeMemory);
  $("memory-save")?.addEventListener("click", saveMemory);
}
