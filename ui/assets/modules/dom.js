// dom.js — DOM 引用集中管理（B5 从 characters.js 拆出）
//
// 所有模块通过 dom.xxx 访问，避免各自 getElementById。

export const dom = {

  listEl: null,   // 页内侧栏已删，角色列表由宿主 rail 承担
  countEl: null,
  modalEl: document.getElementById("modal"),
  importModalEl: document.getElementById("import-modal"),
  newConvModalEl: document.getElementById("new-conv-modal"),
  fileInput: document.getElementById("file-input"),
  stImportInput: document.getElementById("st-import-input"),

  conversationsListEl: null, // 页内侧栏已删，对话列表由宿主 rail 独家承担
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

  // 世界（黑板）
  boardListEl: document.getElementById("board-list"),
  boardCountEl: document.getElementById("board-count"),
  boardNoteEl: document.getElementById("board-note"),

  // 正则规则
  regexListEl: document.getElementById("regex-list"),
  regexCountEl: document.getElementById("regex-count"),
  regexNoteEl: document.getElementById("regex-note"),

  // 预设
  presetListEl: document.getElementById("preset-list"),
  presetCountEl: document.getElementById("preset-count"),
  presetNoteEl: document.getElementById("preset-note"),

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
  board: document.getElementById("drawer-board"),
  variables: document.getElementById("drawer-variables"),
  presets: document.getElementById("drawer-presets"),
  regex: document.getElementById("drawer-regex"),
  tools: document.getElementById("drawer-tools"),
  migration: document.getElementById("drawer-migration"),
  character: document.getElementById("drawer-character"),
};

/* ── 外壳与浮层 ─────────────────────────────────────
 * 这三个是 read 分页恢复时尾部丢掉的一批引用。dom.js 少一项，
 * shell.js 里对应的功能就是死的——而 optional chaining 让它
 * 连报错都没有（dom.x?.addEventListener 静默跳过）。
 * 这类「静默失效」比抛错难查十倍。
 */

dom.shellEl = document.querySelector(".shell");
dom.sidebarCollapseBtn = null;   // 页内侧栏已删，收/展无对象（键保留防 shell.js 引用断裂）
dom.sidebarExpandBtn = null;
dom.convPickerEl = document.getElementById("conv-picker-modal");
dom.convPickerListEl = document.getElementById("conv-picker-list");
dom.suggestRowEl = document.getElementById("suggest-row");
dom.suggestBtn = document.getElementById("suggest-btn");
