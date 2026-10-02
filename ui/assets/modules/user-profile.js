// user-profile.js — 全局用户人设（名字 / 人设 / 头像）的界面出口
//
// persona 的读写链路本来就通（预设 persona 块 + {{user}} 宏都读 conv.persona），
// 单场覆盖走 ⋯ → 本场人设，语义不变。这里补的是「配置一次、新场自带」的那份
// 全局默认：新角色的第一场、以及任何没设过人设的场，都会兜到它。
//
// 头像：前端缩到 128px 方图（webp 优先）再传，一份 data URL 全场复用——
// 对话里你那一侧的头像格按引用共享它，不给每条消息单独存图。

import { apiFetch, toast, friendlyError, unwrap } from "./core.js";
import { state } from "./state.js";

/** 拉全局人设进 state。init 时调一次；打开弹窗前再调一次（别处可能改过）。 */
export async function loadUserProfile() {
  try {
    state.userProfile = unwrap(await apiFetch("user-profile"))
      || { userName: "", persona: "", avatar: "" };
  } catch {
    state.userProfile = state.userProfile || { userName: "", persona: "", avatar: "" };
  }
  return state.userProfile;
}

let pendingAvatar = null; // 本次编辑里新选的 data URL（保存时才提交）；"" = 明确清除

export function openUserProfile() {
  const p = state.userProfile || { userName: "", persona: "", avatar: "" };
  document.getElementById("up-user-name").value = p.userName || "";
  document.getElementById("up-persona").value = p.persona || "";
  pendingAvatar = null;
  renderAvatarPreview(p.avatar || "");
  document.getElementById("userprofile-modal")?.classList.remove("hidden");
}

export function closeUserProfile() {
  document.getElementById("userprofile-modal")?.classList.add("hidden");
  pendingAvatar = null;
}

function renderAvatarPreview(dataUrl) {
  const el = document.getElementById("up-avatar-preview");
  if (!el) return;
  el.innerHTML = dataUrl ? `<img src="${dataUrl}" alt="">` : "?";
}

/** 选图 → 128px cover 方图 → data URL（webp 优先，环境不认就 png）。 */
function pickAvatarFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const S = 128;
      const canvas = document.createElement("canvas");
      canvas.width = S;
      canvas.height = S;
      const ctx = canvas.getContext("2d");
      const side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
      let out = "";
      try { out = canvas.toDataURL("image/webp", 0.85); } catch { out = ""; }
      if (!out.startsWith("data:image/webp")) out = canvas.toDataURL("image/png");
      pendingAvatar = out;
      renderAvatarPreview(out);
    };
    img.onerror = () => toast("这张图读不出来，换一张试试", "error");
    img.src = String(reader.result || "");
  };
  reader.readAsDataURL(file);
}

export async function saveUserProfile() {
  const userName = document.getElementById("up-user-name").value.trim();
  const persona = document.getElementById("up-persona").value.trim();
  const body = { userName, persona };
  if (pendingAvatar !== null) body.avatar = pendingAvatar;
  try {
    state.userProfile = unwrap(await apiFetch("user-profile", {
      method: "PUT",
      body: JSON.stringify(body)
    })) || state.userProfile;
    toast("全局人设已保存——新开的场会自动带上", "success");
    closeUserProfile();
  } catch (e) {
    toast(`保存失败: ${friendlyError(e)}`, "error");
  }
}

export function bindUserProfile() {
  document.getElementById("userprofile-close")?.addEventListener("click", closeUserProfile);
  document.getElementById("userprofile-cancel")?.addEventListener("click", closeUserProfile);
  document.getElementById("userprofile-save")?.addEventListener("click", saveUserProfile);
  document.getElementById("userprofile-modal")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeUserProfile();
  });
  document.getElementById("up-avatar-pick")?.addEventListener("click", () => {
    document.getElementById("up-avatar-input")?.click();
  });
  document.getElementById("up-avatar-input")?.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // 清掉，同一张图才能重选
    if (f) pickAvatarFile(f);
  });
  document.getElementById("up-avatar-clear")?.addEventListener("click", () => {
    pendingAvatar = "";
    renderAvatarPreview("");
  });
}
