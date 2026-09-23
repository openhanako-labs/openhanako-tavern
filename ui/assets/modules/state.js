// state.js — 跨模块共享的可变状态（B5 从 characters.js 拆出）
//
// 用对象承载，模块间共享同一份引用。改 state.xxx 所有模块立即可见。

export const state = {
  currentCharacter: null,
  importData: null,
  currentConv: null,
  convList: [],
  isGenerating: false,
  currentSetting: null,
  currentVariable: null,
  currentForm: null,
  lastExportData: null,
};
