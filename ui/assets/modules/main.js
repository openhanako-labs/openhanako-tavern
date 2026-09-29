// main.js — 装配层（U1 之后）
//
// 只做装配：绑定各模块、初始化。不再有 Tab 切换逻辑——
// 六 Tab 已改成「一屏聊天 + 左栏 + 抽屉」，导航在 shell.js。

import { hana } from "../sdk.js";
import { dom } from "./dom.js";
import { state } from "./state.js";
import { apiFetch, toast, confirmDialog, escapeHtml, extractArray, formatDate, formatTime } from "./core.js";

import { loadCharacters, renderCharacters, openCharacterEditor, saveCharacter, deleteCharacter, exportCharacter, handleCharacterAction, handleImport, commitImport, closeImportModal, renderImportPreview } from "./characters.js";
import { loadConversations, renderConversations, openConversation, renderMessages, sendMessage, stopGeneration, bindScrollFollow, bindComposer, createConversation, confirmNewConversation, closeNewConvModal, deleteMessage, startEditMessage, cancelEditMessage, copyMessage, swipeVariant, regenerateFrom, findMessage, hideUsageBar } from "./chat.js";
import { bindChatMore, syncChatMore } from "./chat-more.js";
import { bindShell, toggleSidebar } from "./shell.js";
import { bindPresets } from "./presets.js";
import { loadSettings, renderSettings, openSettingEditor, saveSetting, deleteSetting, toggleSetting, handleSettingAction, importSTWorldBook, exportSTWorldBook, handleSTImport, updateTriggerFields, runAutocategorize, view as settingsView } from "./settings.js";
import { openCatsModal } from "./settings-cats.js";
import { newDirector, saveDirector, closeDirectorEditor, deleteEditingDirector, simulateDirector } from "./director.js";
import { renderVariables, openVariableEditor, saveVariable, deleteVariable, handleVariableAction, testReplace } from "./variables.js";
import { loadTools, renderToolGroups } from "./tools.js";
import { importFile, handleMigrationFile, loadExports, renderExports, downloadExportFile, deleteExportFile, copyExport, formatFileSize, exportAll } from "./migration.js";
import { saveBoardCell, deleteBoardCell, bindBoard } from "./board.js";
import { bindGen } from "./gen.js";
import { bindTts } from "./tts.js";
import { bindMemory } from "./memory.js";
import { bind as bindVarDiffModal } from "./var-diff-modal.js";
import { bindImage } from "./image.js";
import { bindScene } from "./scene.js";
import { bindIllustrate } from "./illustrate.js";
import { bindAppearance, loadAppearance } from "./appearance.js";
import { bindCommand, bindScrollBottom } from "./command.js";
import { saveRegexRule, deleteRegexRule, bindRegex } from "./regex.js";
import { bindCharProfile } from "./char-profile.js";


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
document.getElementById("export-st-btn")?.addEventListener("click", exportSTWorldBook);

// 设定库 2.0：自动分类 / 类目管理 / 分组维度 / 排序。
// 新控件直接绑，保持主链可读性；
// 它们与 settings-cats.js 之间的状态同步靠 CustomEvent，不走 import。
document.getElementById("autocategorize-btn")?.addEventListener("click", runAutocategorize);
document.getElementById("settings-cats-btn")?.addEventListener("click", openCatsModal);
document.getElementById("settings-groupby")?.addEventListener("change", (e) => {
  settingsView.groupBy = e.target.value;
  settingsView.page = 1;
  renderSettings(state.settingList);
});
document.getElementById("settings-sortby")?.addEventListener("change", (e) => {
  settingsView.sortBy = e.target.value;
  renderSettings(state.settingList);
});
document.getElementById("create-director-btn")?.addEventListener("click", newDirector);
// 「刷新」按钮已按基准 5 拿掉：打开抽屉与增删改后本来就会自动重载，
// 它从来不需要被按（docs/spec-drawer.md 第三节·毛病 1）。

// 公式编辑器弹窗（基准 5 · 样张「丙」）。
// 弹窗元素是静态的，只绑一次——不再随列表重绘重建。
document.getElementById("dir-save")?.addEventListener("click", saveDirector);
document.getElementById("dir-cancel")?.addEventListener("click", closeDirectorEditor);
document.getElementById("director-editor-close")?.addEventListener("click", closeDirectorEditor);
document.getElementById("dir-del")?.addEventListener("click", deleteEditingDirector);
document.getElementById("dir-sim")?.addEventListener("click", simulateDirector);

// 设定库搜索：改一个字就重渲染。106 条重排不卡，不必防抖。
// 重渲染用的是内存里那份 state.settingList——不重拉网络。
document.getElementById("settings-search")?.addEventListener("input", () => renderSettings(state.settingList));

document.getElementById("create-variable-btn")?.addEventListener("click", () => openVariableEditor(null));
// 「刷新」按钮已按基准 5 拿掉（同上）。
document.getElementById("test-replace-btn")?.addEventListener("click", testReplace);

document.getElementById("export-all-btn")?.addEventListener("click", exportAll);
document.getElementById("import-file-btn")?.addEventListener("click", () => dom.migrationFileInput.click());

// 弹窗
document.getElementById("modal-close")?.addEventListener("click", closeEditModal);
document.getElementById("modal-cancel")?.addEventListener("click", closeEditModal);
document.getElementById("modal-save")?.addEventListener("click", handleSave);
// 导出下拉：开关 + 点外部关闭。
// 为什么不直接把两个导出项放在页脚——它们属于同一件事的两个输出格式，
// 拆开平列等于告诉用户“这是两件事”。合成一个下拉后，入口就一个，
// 里面才是两个选项；标签也写清了各自导出什么。
const exportToggle = document.getElementById("modal-export-toggle");
const exportMenu = document.getElementById("modal-export-menu");
if (exportToggle && exportMenu) {
  exportToggle.addEventListener("click", () => {
    const closed = exportMenu.classList.toggle("hidden");
    exportToggle.setAttribute("aria-expanded", closed ? "false" : "true");
  });
  // 菜单里的两项：点完就关（否则用户以为菜单还开着可以接着选）
  exportMenu.querySelectorAll(".em-item").forEach(b => {
    b.addEventListener("click", () => {
      exportMenu.classList.add("hidden");
      exportToggle.setAttribute("aria-expanded", "false");
    });
  });
  // 点弹窗外面关掉菜单
  document.addEventListener("click", (e) => {
    if (!exportMenu.classList.contains("hidden")
        && !exportMenu.contains(e.target)
        && !exportToggle.contains(e.target)) {
      exportMenu.classList.add("hidden");
      exportToggle.setAttribute("aria-expanded", "false");
    }
  });
}
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

// 备份导入。以前这里没有这行：handleMigrationFile 写好了、却从没被绑过，
// 而按钮借的是 #file-input —— 选备份会被角色卡导入器接手。
dom.migrationFileInput?.addEventListener("change", handleMigrationFile);

// AI 生成台的按钮（弹窗由左栏的 ✧ 生成 → nav → shell.js 打开）
bindGen();

// 语音朗读的设置面板（入口在聊天头 ⋯ 菜单里），以及面板自己的按钮
bindTts();

// 「本轮发生了什么」面板的关闭 / 修改按钮。chips 行的「明细 ›」在 chat.js 动态绑。
bindVarDiffModal();

// 记忆面板（S2）：短期轮数 / 总结字数 / 总结提示词。入口在工具抽屉。
bindMemory();

// 出图设置（同样在 ⋯ 菜单里）：宿主供应商 / 本机 ComfyUI 两条路
bindImage();

// 场景插图设置（第 2 批）：三个开关
bindScene();

// 手动补一张场景图（⋯ 菜单里「这一场」那组）。
// 面板文案承诺过这个入口、后端也早就写好了——缺的就是这一颗按钮。
bindIllustrate();

/*
 * 工具抽屉里的两个设置入口。
 *
 * 为什么要有第二份：⋯ 菜单那颗按钮只在**开了对话**时才显示，
 * 而“先配好语音/引擎再开始玩”是很自然的一条路——没对话就进不去设置，那是死路。
 * 工具抽屉不需要对话，所以这里各给一个入口。
 */
document.getElementById("open-tts-settings")?.addEventListener("click", async () => {
  const m = await import("./tts.js");
  m.openTts();
});
document.getElementById("open-image-settings")?.addEventListener("click", async () => {
  const m = await import("./image.js");
  m.openImage();
});
document.getElementById("open-scene-settings")?.addEventListener("click", async () => {
  const m = await import("./scene.js");
  m.openScene();
});
document.getElementById("open-models-settings")?.addEventListener("click", async () => {
  const m = await import("./models.js");
  await m.openModels();
});
document.getElementById("open-memory-settings")?.addEventListener("click", async () => {
  const m = await import("./memory.js");
  await m.openMemory();
});

// 聊天输入：Enter 发送，Shift+Enter 换行
dom.chatInput?.addEventListener("keydown", (e) => {
  // Esc 退出编辑。这是编辑状态**唯一的出口**：
  // 不绑它的话，用户点开“编辑”就出不来（清空再保存会静默丢掉内容）。
  if (e.key === "Escape" && state.editingMessageId != null) {
    e.preventDefault();
    cancelEditMessage();
    return;
  }
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

  // 输入区：「给点方向」那一个按钮
  bindComposer();

  // 一屏外壳：侧栏折叠 / 抽屉 / 点卡开聊
  bindShell();

  // 自定义背景：先绑事件，再拉配置（拉不到就按“没背景”跑，不拦整屏）
  bindAppearance();
  loadAppearance().catch((e) => console.error("[bg] 初始化失败:", e));

  // 命令面板（Ctrl/⌘K）与“滚到底”
  bindCommand();
  bindScrollBottom();

  // ⋯ 菜单（人设 / 预览）
  bindChatMore();

  // 预设抽屉内的按钮
  bindPresets();

  // 世界（黑板）抽屉内的按钮
  bindBoard();

  // 正则规则抽屉内的按钮
  bindRegex();
// C3 二期：角色档案（八区块展示）。按钮在「当前角色」抽屉的工具条上。
bindCharProfile();

  // 快捷键：Ctrl/Cmd+B 折侧栏
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
      e.preventDefault();
      toggleSidebar();
    }
  });

  // 首屏数据。
  //
  // **这一行曾经丢过**（恢复时掉的，和那批被截掉的函数同一个形状）：
  // init() 只剩绑事件，于是 App 打开后左栏永远是空的，看起来像
  // 「一个角色也没有」。原文在
  //   已分类/工作/代码/tavern-reads/ui__assets__modules__main.js.read.txt
  // 里就是 `// 加载数据` + `loadCharacters();`。
  //
  // 对话列表不在这里拉：页内侧栏已经删掉，那一份由宿主 rail 承担
  //（见 dom.js 的 conversationsListEl）。
  try {
    await loadCharacters();
  } catch (e) {
    console.error("[Init] 首屏角色列表加载失败:", e);
    toast("角色列表加载失败: " + friendlyError(e), "error");
  }
}

init();

// 抽屉工具条的「⋯」：点开 / 收起，点别处或按 Esc 收起。
// 和左轨那个「设置」浮层同一套做法（都用 .more-menu）——
// 菜单里的按钮点完就收起，不然它一直盖着下面的列表。
(() => {
  const btn = document.getElementById("settings-more-btn");
  const menu = document.getElementById("settings-more-menu");
  if (!btn || !menu) return;
  const close = () => {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // 不让下面那个 document 监听立刻把它关回去
    if (menu.hidden) {
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
    } else close();
  });
  menu.addEventListener("click", close);
  document.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
})();
