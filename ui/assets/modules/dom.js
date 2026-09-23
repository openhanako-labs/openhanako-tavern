// dom.js — DOM 引用集中管理（B5 从 characters.js 拆出）
//
// 所有模块通过 dom.xxx 访问，避免各自 getElementById。

export const dom = {

  listEl: document.getElementById("characters-list"),
  countEl: document.getElementById("count"),
  modalEl: document.getElementById("modal"),
  importModalEl: document.getElementById("import-modal"),
  newConvModalEl: document.getElementById("new-conv-modal"),
  fileInput: document.getElementById("file-input"),
  stImportInput: document.getElementById("st-import-input"),

  conversationsListEl: document.getElementById("conversations-list"),
  messagesContainer: document.getElementById("messages-container"),
  chatTitle: document.getElementById("chat-title"),
  chatInputArea: document.getElementById("chat-input-area"),
  chatInput: document.getElementById("chat-input"),
  sendBtn: document.getElementById("send-btn"),
  chatActions: document.getElementById("chat-actions"),

  settingsListEl: document.getElementById("settings-list"),
  settingsCountEl: document.getElementById("settings-count"),

  variablesListEl: document.getElementById("variables-list"),
  variablesCountEl: document.getElementById("variables-count"),

  toolsListEl: document.getElementById("tools-list"),
  toolsCountEl: document.getElementById("tools-count"),
  toolGroupsEl: document.getElementById("tool-groups-list"),

  exportsListEl: document.getElementById("exports-list"),
  exportInfoEl: document.getElementById("export-info"),
  importResultEl: document.getElementById("import-result"),
  migrationFileInput: document.getElementById("file-input"),
};

/**
 * 侧边抽屉表：name → 抽屉容器。
 *
 * key 与 HTML 的 data-drawer / id="drawer-<key>" 对应。
 * 少一个 key，shell.openDrawer(name) 就只是静默不动——
 * 那种「按钮点了没反应」最难排查。新增抽屉时这里要同步加。
 */
export const DRAWERS = {
  settings: document.getElementById("drawer-settings"),
  variables: document.getElementById("drawer-variables"),
  presets: document.getElementById("drawer-presets"),
  tools: document.getElementById("drawer-tools"),
  migration: document.getElementById("drawer-migration"),
};
