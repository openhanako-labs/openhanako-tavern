// lib/user-profile.js — 全局用户人设（名字 / 人设文本 / 头像）
//
// 为什么存在：persona 的读写链路本来就通（预设 persona 块 + {{user}} 宏都读
// conv.persona），单场的入口也在（⋯ → 本场人设）。缺的是「配置一次、新场自带」
// 的那一份——尤其新角色的第一场：人设跟着角色卡走、从最近一场抄的规矩碰上
// 「这张卡从没有过对话」时无场可抄，只能空着。这里是兜底链的最后一环。
//
// 语义（与 conversations create 的兜底链对齐）：
//   显式给值 > 这张卡最近一场 > 这份全局默认 > 空串
//
// 存储形态学 tool-groups.json：dataDir 下一个 JSON，读不到（ENOENT/损坏）就默认值。

import fs from "node:fs/promises";
import path from "node:path";

import { route } from "./respond.js";

const DEFAULT_PROFILE = { userName: "", persona: "", avatar: "" };

let _file = null;

/** 在 index.js 初始化时调用（早于任何路由被请求）。 */
export function initUserProfile(dataDir) {
  _file = dataDir ? path.join(dataDir, "user-profile.json") : null;
}

export async function getUserProfile() {
  if (!_file) return { ...DEFAULT_PROFILE };
  try {
    const raw = await fs.readFile(_file, "utf8");
    const p = JSON.parse(raw);
    return {
      userName: typeof p?.userName === "string" ? p.userName : "",
      persona: typeof p?.persona === "string" ? p.persona : "",
      avatar: typeof p?.avatar === "string" ? p.avatar : ""
    };
  } catch (e) {
    if (e?.code !== "ENOENT") {
      console.error("[user-profile] 读取失败，用默认值:", e?.message);
    }
    return { ...DEFAULT_PROFILE };
  }
}

// 只认 data URL，且给头像设上限——前端会把图缩到 128px 再传，正常远够。
const AVATAR_RE = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/;
const AVATAR_MAX = 400_000;

export async function setUserProfile(patch = {}) {
  const next = await getUserProfile();
  if (patch.userName !== undefined) next.userName = String(patch.userName);
  if (patch.persona !== undefined) next.persona = String(patch.persona);
  if (patch.avatar !== undefined) {
    const a = String(patch.avatar);
    if (a && !AVATAR_RE.test(a)) throw new Error("avatar 必须是 data:image/*;base64 形式的 data URL");
    if (a.length > AVATAR_MAX) throw new Error(`头像太大（${a.length} > ${AVATAR_MAX}）——前端先缩图再传`);
    next.avatar = a;
  }
  if (!_file) throw new Error("user-profile 未初始化（index.js 没调 initUserProfile）");
  await fs.writeFile(_file, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function registerUserProfileRoutes(app) {
  app.get("/user-profile", route(async () => getUserProfile()));

  app.put("/user-profile", route(async (c) => {
    const body = await c.req.json();
    return setUserProfile(body);
  }));
}
