// lib/tools/group.js — 工具组管理（持久化 + 真生效）
//
// 修复要点：
//   1. 开关状态持久化到 dataDir/tool-groups.json（原实现只改内存，重启即丢）
//   2. 开关真正生效——注册工具时按开关过滤（原实现只影响查询接口的返回）
//
// 用法：defineApp 里先 await loadGroupState(dataDir)，再决定注册哪些工具。

import fs from "node:fs/promises";
import path from "node:path";

export const TOOL_GROUPS = {
  characters: {
    id: "characters",
    name: "角色卡",
    description: "角色卡相关工具",
    tools: ["tavern_list_characters", "tavern_get_character"],
    defaultEnabled: true
  },
  conversations: {
    id: "conversations",
    name: "对话",
    description: "对话管理工具",
    tools: ["tavern_create_conversation", "tavern_list_conversations", "tavern_send_message"],
    defaultEnabled: true
  },
  variables: {
    id: "variables",
    name: "变量",
    description: "变量管理工具",
    tools: ["tavern_list_variables", "tavern_set_variable"],
    defaultEnabled: true
  },
  settings: {
    id: "settings",
    name: "设定库",
    description: "设定库管理工具",
    tools: ["tavern_list_settings", "tavern_get_active_settings"],
    defaultEnabled: true
  },
  system: {
    id: "system",
    name: "系统",
    description: "系统诊断工具",
    tools: ["eleckoi_tavern_probe"],
    defaultEnabled: true
  }
};

// 内存态：id → boolean。由 loadGroupState() 从磁盘填充。
let _state = null;
let _stateFile = null;

function defaultState() {
  const out = {};
  for (const g of Object.values(TOOL_GROUPS)) out[g.id] = g.defaultEnabled !== false;
  return out;
}

/** 从 dataDir 读取开关状态；文件不存在或损坏时用默认值。 */
export async function loadGroupState(dataDir) {
  _state = defaultState();
  if (!dataDir) return listGroups();

  _stateFile = path.join(dataDir, "tool-groups.json");
  try {
    const raw = await fs.readFile(_stateFile, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      for (const g of Object.values(TOOL_GROUPS)) {
        if (typeof parsed[g.id] === "boolean") _state[g.id] = parsed[g.id];
      }
    }
  } catch (e) {
    // 首次运行（ENOENT）或文件损坏 → 保持默认值，并落盘一份
    if (e?.code !== "ENOENT") {
      console.error("[tool-groups] 读取失败，回退默认值:", e?.message);
    }
    await saveGroupState();
  }
  return listGroups();
}

/** 持久化当前开关状态。 */
export async function saveGroupState() {
  if (!_stateFile) return false;
  try {
    await fs.writeFile(_stateFile, JSON.stringify(_state, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("[tool-groups] 写入失败:", e?.message);
    return false;
  }
}

function ensureState() {
  if (!_state) _state = defaultState();
  return _state;
}

// 获取所有工具组（带 enabled）
export function listGroups() {
  const state = ensureState();
  return Object.values(TOOL_GROUPS).map(g => ({
    id: g.id,
    name: g.name,
    description: g.description,
    tools: g.tools,
    enabled: state[g.id] !== false
  }));
}

// 获取工具组
export function getGroup(id) {
  const g = TOOL_GROUPS[id];
  if (!g) return null;
  const state = ensureState();
  return { ...g, enabled: state[g.id] !== false };
}

// 启用/禁用工具组（内存 + 落盘）
export async function toggleGroup(id, enabled) {
  if (!TOOL_GROUPS[id]) return null;
  const state = ensureState();
  state[id] = !!enabled;
  await saveGroupState();
  return getGroup(id);
}

// 获取所有启用的工具名
export function getEnabledTools() {
  const state = ensureState();
  const enabled = [];
  for (const g of Object.values(TOOL_GROUPS)) {
    if (state[g.id] !== false) enabled.push(...g.tools);
  }
  return enabled;
}

// 检查工具是否启用
export function isToolEnabled(toolName) {
  const state = ensureState();
  for (const g of Object.values(TOOL_GROUPS)) {
    if (g.tools.includes(toolName)) {
      return state[g.id] !== false;
    }
  }
  // 不在任何已知组里的工具（如新加的自定义工具）默认放行
  return true;
}

/** 判断某个工具组是否启用（供 index.js 决定是否注册）。 */
export function isGroupEnabled(groupId) {
  const state = ensureState();
  return state[groupId] !== false;
}
