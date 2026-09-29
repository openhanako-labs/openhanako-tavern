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
  chatMeta: document.getElementById("chat-meta"),
  chatInputArea: document.getElementById("chat-input-area"),
  chatInput: document.getElementById("chat-input"),
  sendBtn: document.getElementById("send-btn"),
  chatActions: document.getElementById("chat-actions"),

  settingsListEl: document.getElementById("settings-list"),
  settingsCountEl: document.getElementById("settings-count"),
  // ── 设定库 2.0（分页 / 分组维度 / 排序 / 批量条 / 类目按钮）──
  settingsPagerEl: document.getElementById("settings-pager"),
  settingsBatchBarEl: document.getElementById("settings-batch-bar"),
  settingsGroupBy: document.getElementById("settings-groupby"),
  settingsSortBy: document.getElementById("settings-sortby"),
  settingsCatsBtn: document.getElementById("settings-cats-btn"),
  settingsAutocategorizeBtn: document.getElementById("autocategorize-btn"),
  createSettingBtn: document.getElementById("create-setting-btn"),
  importStBtn: document.getElementById("import-st-btn"),
  exportStBtn: document.getElementById("export-st-btn"),
  settingsSearch: document.getElementById("settings-search"),
  priorityPickerEl: null,

  variablesListEl: document.getElementById("variables-list"),
  variablesCountEl: document.getElementById("variables-count"),
  convVarsListEl: document.getElementById("conv-vars-list"),
  convVarsCountEl: document.getElementById("conv-vars-count"),

  toolsCountEl: document.getElementById("tools-count"),
  toolGroupsEl: document.getElementById("tool-groups-list"),

  // 世界（黑板）
  boardListEl: document.getElementById("board-list"),
  boardCountEl: document.getElementById("board-count"),
  boardNoteEl: document.getElementById("board-note"),

  // 正则规则
  regexListEl: document.getElementById("regex-list"),
  regexCountEl: document.getElementById("regex-count"),
  regexModalEl: document.getElementById("regex-modal"),
  importRegexInput: document.getElementById("import-regex-input"),

  // 图库（本场 / 全部两级）
  galleryListEl: document.getElementById("gallery-list"),
  galleryCountEl: document.getElementById("gallery-count"),
  galleryScopeEl: document.getElementById("gallery-scope"),
  galleryKindEl: document.getElementById("gallery-kind"),
  galleryMoreEl: document.getElementById("gallery-more"),
  galleryMoreBtn: document.getElementById("gallery-more-btn"),

  // 预设
  presetListEl: document.getElementById("preset-list"),
  presetCountEl: document.getElementById("preset-count"),
  presetNoteEl: document.getElementById("preset-note"),

  exportsListEl: document.getElementById("exports-list"),
  exportInfoEl: document.getElementById("export-info"),
  importResultEl: document.getElementById("import-result"),
  migrationFileInput: document.getElementById("migration-file-input"),
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
  // 注：**没有 board**。世界不是抽屉，而是聊天左边一条可折叠的常驻栏
  //（#board-col）。shell.openDrawer("board") 会转去做开关，
  // 所以顶栏与 ⋯ 菜单里原有的入口照旧能用。
  director: document.getElementById("drawer-director"),
  variables: document.getElementById("drawer-variables"),
  presets: document.getElementById("drawer-presets"),
  regex: document.getElementById("drawer-regex"),
  codex: document.getElementById("drawer-codex"),
  // 图库：本场 / 全部两级。装在这里而不是左轨——
  // 它和预设/正则/工具/迁移同级，属于「配一次就不常看」的那一类。
  gallery: document.getElementById("drawer-gallery"),
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
dom.convPickerEl = document.getElementById("conv-picker-modal");
dom.convPickerListEl = document.getElementById("conv-picker-list");
dom.suggestRowEl = document.getElementById("suggest-row");
dom.suggestBtn = document.getElementById("suggest-btn");

/**
 * 只显示 `kind` 对应的那张编辑表单。
 *
 * 为什么必须有这一步：编辑弹窗里住着五张表单（角色/设定/变量/世界/正则），
 * 各自带着 `hidden`。
 * 而先前只有角色编辑器自己做了「隐藏所有、显示自己那张」——
 * 其余四个都只把弹窗显示出来，于是点「新建」弹出一个
 * 有「保存 / 导出 / ✕」、**却一个输入框都没有**的空壳对话框。
 *
 * kind → 表单 id 的对应只写在这一处；调用方只说自己是谁。
 */
export function showEditForm(kind) {
  const byKind = {
    character: "character-form",
    setting: "setting-form",
    variable: "variable-form",
    board: "board-form",
    regex: "regex-form"
  };
  for (const id of Object.values(byKind)) {
    document.getElementById(id)?.classList.add("hidden");
  }
  const target = byKind[kind] ? document.getElementById(byKind[kind]) : null;
  target?.classList.remove("hidden");

  // 页脚切换：
  //   · character 表单的页脚由 openCharacterEditor 管（编辑已有卡时：删除 + 导出；
  //     新建时：只有取消 / 保存）——所以那里不改。
  //   · 非 character（setting / variable / board）一律「取消 / 保存」右对齐；
  //     导出只对角色卡有意义，对它们隐藏。
  //   · regex 已经走自己的弹窗与页脚（#regex-modal），这里不改。
  if (kind && kind !== "character") {
    document.getElementById("modal-delete")?.classList.add("hidden");
    document.getElementById("modal-export-wrap")?.classList.add("hidden");
    document.getElementById("modal-cancel")?.classList.remove("hidden");
  }

  return !!target;
}
