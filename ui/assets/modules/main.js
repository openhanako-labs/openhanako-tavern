// main.js — 装配层（U1 之后）
//
// 只做装配：绑定各模块、初始化。不再有 Tab 切换逻辑——
// 六 Tab 已改成「一屏聊天 + 左栏 + 抽屉」，导航在 shell.js。

import { hana } from "../sdk.js";
import { dom } from "./dom.js";
import { state } from "./state.js";
import { apiFetch, toast, confirmDialog, escapeHtml, extractArray, formatDate, formatTime } from "./core.js";

import { loadCharacters, renderCharacters, openCharacterEditor, saveCharacter, deleteCharacter, exportCharacter, handleCharacterAction, handleImport, commitImport, closeImportModal, renderImportPreview } from "./characters.js";
import { loadConversations, renderConversations, openConversation, renderMessages, sendMessage, stopGeneration, bindScrollFollow, createConversation, confirmNewConversation, closeNewConvModal, deleteMessage, startEditMessage, copyMessage, swipeVariant, regenerateFrom, findMessage, hideUsageBar } from "./chat.js";
import { bindChatMore, syncChatMore } from "./chat-more.js";
import { bindShell, toggleSidebar } from "./shell.js";
import { bindPresets } from "./presets.js";
import { loadSettings, renderSettings, openSettingEditor, saveSetting, deleteSetting, toggleSetting, handleSettingAction, importSTWorldBook, handleSTImport, updateTriggerFields } from "./settings.js";
import { loadVariables, renderVariables, openVariableEditor, saveVariable, deleteVariable, handleVariableAction, testReplace } from "./variables.js";
import { loadTools, renderToolGroups, renderTools } from "./tools.js";
import { importFile, loadExports, renderExports, downloadExport, downloadExportFile, deleteExportFile, copyExport, formatFileSize, exportAll } from "./migration.js";
import { saveBoardCell, deleteBoardCell, bindBoard } from "./board.js";
import { saveRegexRule, deleteRegexRule, bindRegex } from "./regex.js";


// ── 通用弹窗 ──────────────────────────────────────────

export function closeEditModal() {
  dom.modalEl.classList.add("hidden");
  state.currentCharacter = null;
  state.currentSetting = null;
  state.currentVariable = null;
  state.currentBoardCell = null;
  state.currentRegexRule = null;
  state.currentForm = null;
}

export async function handleSave() {
  if (state.currentForm === 'character') await saveCharacter();
  else if (state.currentForm === 'setting') await saveSetting();
  else if (state.currentForm === 'variable') await saveVariable();
  else if (state.currentForm === 'board') await saveBoardCell();
  else if (state.currentForm === 'regex') await saveRegexRule();
}

export async function handleExport() {
  if (state.currentForm === 'character' && state.currentCharacter) {
    await exportCharacter(state.currentCharacter.id, "json");
  }
}

export async function handleExportST() {
  if (state.currentForm === 'character' && state.currentCharacter) {
    await exportCharacter(state.currentCharacter.id, "st-v2");
  }
}

export async function handleDelete() {
  if (state.currentForm === 'character' && state.currentCharacter) await deleteCharacter(state.currentCharacter.id);
  else if (state.currentForm === 'setting' && state.currentSetting) await deleteSetting(state.currentSetting.id);
  else if (state.currentForm === 'variable' && state.currentVariable) await deleteVariable(state.currentVariable.id);
  else if (state.currentForm === 'board' && state.currentBoardCell) await deleteBoardCell(state.currentBoardCell.id);
  else if (state.currentForm === 'regex' && state.currentRegexRule) await deleteRegexRule(state.currentRegexRule.id);
}


// ── 事件绑定 ──────────────────────────────────────────

// 聊天
document.getElementById("send-btn")?.addEventListener("click", sendMessage);
document.getElementById("stop-btn")?.addEventListener("click", stopGeneration);
document.getElementById("gen-meta-close")?.addEventListener("click", hideUsageBar);

// 设定库 / 变量 / 预设 / 工具 / 迁移（抽屉在 shell.js 里开，这里绑它们内部按钮）
document.getElementById("create-setting-btn")?.addEventListener("click", () => openSettingEditor(null));
document.getElementById("import-st-btn")?.addEventListener("click", importSTWorldBook);
document.getElementById("refresh-settings-btn")?.addEventListener("click", loadSettings);

document.getElementById("create-variable-btn")?.addEventListener("click", () => openVariableEditor(null));
document.getElementById("refresh-variables-btn")?.addEventListener("click", loadVariables);
document.getElementById("test-replace-btn")?.addEventListener("click", testReplace);

document.getElementById("refresh-tools-btn")?.addEventListener("click", loadTools);

document.getElementById("export-all-btn")?.addEventListener("click", exportAll);
document.getElementById("import-file-btn")?.addEventListener("click", () => dom.migrationFileInput.click());
document.getElementById("refresh-exports-btn")?.addEventListener("click", loadExports);
document.getElementById("download-export-btn")?.addEventListener("click", downloadExport);
document.getElementById("copy-export-btn")?.addEventListener("click", copyExport);

// 弹窗
document.getElementById("modal-close")?.addEventListener("click", closeEditModal);
document.getElementById("modal-save")?.addEventListener("click", handleSave);
document.getElementById("modal-export-json")?.addEventListener("click", handleExport);
document.getElementById("modal-export-st")?.addEventListener("click", handleExportST);
document.getElementById("modal-delete")?.addEventListener("click", handleDelete);

// 导入弹窗
document.getElementById("import-close")?.addEventListener("click", closeImportModal);
document.getElementById("import-confirm")?.addEventListener("click", commitImport);
document.getElementById("import-cancel")?.addEventListener("click", closeImportModal);

// 新对话弹窗
document.getElementById("new-conv-close")?.addEventListener("click", closeNewConvModal);
document.getElementById("new-conv-cancel")?.addEventListener("click", closeNewConvModal);
document.getElementById("new-conv-confirm")?.addEventListener("click", confirmNewConversation);

// 触发类型切换
document.getElementById("sf-trigger-type")?.addEventListener("change", (e) => {
  updateTriggerFields(e.target.value);
});

// 文件输入
dom.fileInput?.addEventListener("change", (e) => {
  if (e.target.files) { handleImport(e.target.files); dom.fileInput.value = ""; }
});

dom.stImportInput?.addEventListener("change", handleSTImport);

// 聊天输入：Enter 发送，Shift+Enter 换行
dom.chatInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// 刷新
document.getElementById("reload-link")?.addEventListener("click", (e) => {
  e.preventDefault();
  window.location.reload();
});

// 遮罩关闭
dom.modalEl?.addEventListener("click", (e) => { if (e.target === dom.modalEl) closeEditModal(); });
dom.importModalEl?.addEventListener("click", (e) => { if (e.target === dom.importModalEl) closeImportModal(); });
dom.newConvModalEl?.addEventListener("click", (e) => { if (e.target === dom.newConvModalEl) closeNewConvModal(); });


// ── 初始化 ──────────────────────────────────────────

export async function init() {
  try {
    if (typeof hana?.ready === "function") {
      await hana.ready();
    }
  } catch (e) {
    console.error("[Init] hana.ready error:", e);
  }

  // 滚动跟随（只在用户已在底部时自动跟随）
  bindScrollFollow();

  // 一屏外壳：侧栏折叠 / 抽屉 / 点卡开聊
  bindShell();

  // ⋯ 菜单（人设 / 预览）
  bindChatMore();

  // 预设抽屉内的按钮
  bindPresets();

  // 世界（黑板）抽屉内的按钮
  bindBoard();

  // 正则规则抽屉内的按钮
  bindRegex();

  // 快捷键：Ctrl/Cmd+B 折侧栏
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
      e.preventDefault();
      toggleSidebar();
    }
  });

}

init();
