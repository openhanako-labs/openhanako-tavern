// state.js — 跨模块共享的可变状态（B5 从 characters.js 拆出）
//
// 用对象承载，模块间共享同一份引用。改 state.xxx 所有模块立即可见。

export const state = {
  currentCharacter: null,
  importData: null,
  currentConv: null,
  convList: [],
  charList: [],
  settingList: null,
  variableList: null,
  // 世界（黑板）：世界级 + 本场的格子，以及正在编辑的那一格
  boardWorld: [],
  boardChat: [],
  currentBoardCell: null,
  // 正则规则：规则表，以及正在编辑的那一条
  regexList: null,
  currentRegexRule: null,
  toolGroups: null,
  toolList: null,
  exportList: null,
  isGenerating: false,
  // 群聊：这一轮由哪位参与者发言（null = 主角）。
  // 发完一条**不自动换人**——换谁开口是作者的判断，系统不该替他轮转。
  speakerId: null,
  currentSetting: null,
  currentVariable: null,
  currentForm: null,
  lastExportData: null,
  // 当前对话的宏处理器与上下文。renderMessages 与发送都靠它——
  // 缺了它 {{char}} 会原样出现在气泡里。
  macro: null,
  searchQuery: "",
  tagFilter: null,
  importSelected: new Set(),
  editingMessageId: null,
  abortGeneration: false,
  followTail: true,
};
