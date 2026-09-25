// media.js — 出图（v1：给角色卡生成立绘）
//
// 为什么按钮挂在"当前角色"面板上：立绘本来就是角色卡的东西，
// 它该出现在你正看着这张卡的时候，而不是某个二级菜单里。
//
// 三条交互纪律：
//   · 长任务要说清"在做什么"——出图几十秒起步，按钮直接禁用 + 写一行状态，
//     否则用户会连点三次（然后收到三张）。
//   · 先体检再动手：/media/status 不通就直接说缺什么，别让人等半分钟才失败。
//   · 成功要看得见：换完头像立刻重画一次角色面板——图变了但面板没变
//     等于告诉用户"没成功"。

import { apiFetch, toast, escapeHtml, friendlyError } from "./core.js";
import { state } from "./state.js";

let busy = false;

const $ = (id) => document.getElementById(id);

function setNote(text) {
  const el = $("ctx-portrait-note");
  if (el) el.textContent = text || "";
}

/** 绑定当前角色面板上的「生成立绘」。每次重画面板都会重新绑。 */
export function bindPortraitButton() {
  const btn = $("ctx-portrait");
  if (!btn || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", () => void makePortrait());
}

export async function makePortrait() {
  if (busy) return;
  const conv = state.currentConv;
  const card = state.currentCharacter;
  if (!conv || !card) { toast("先打开一场对话", "error"); return; }

  const btn = $("ctx-portrait");
  busy = true;
  if (btn) btn.disabled = true;
  setNote("正在出图…（这一步要几十秒，可以先去做别的）");

  try {
    // 先体检：不通就现在说，别让人白等。
    // 注意“体检本身失败”与“体检说不通”是两回事：
    // 前者是这里拿不到答案（路由不在 / 网络断），别报成“未知原因”——
    // 那句话对排查零帮助。
    let s = null;
    try {
      const st = await apiFetch("media/status");
      s = st.data || st;
    } catch (e) {
      const why = friendlyError(e);
      setNote("出图不可用：拿不到媒体状态（" + why + "）");
      toast("出图不可用: " + why, "error");
      return;
    }
    if (!s?.available) {
      setNote(`出图不可用：${s?.reason || "宿主没给出原因"}`);
      toast("出图不可用：" + (s?.reason || "宿主没给出原因"), "error");
      return;
    }

    const res = await apiFetch("media/portrait", {
      method: "POST",
      body: JSON.stringify({ characterId: card.id })
    });
    const r = res.data || res;
    setNote(`已生成（${Math.round((r.bytes || 0) / 1024)} KB，${escapeHtml(r.avatarExt || "png")}）`);

    // 头像变了：内存里那份 currentCharacter 还是旧的（has_avatar=false），
    // 不重拉一次的话面板会继续画首字母——看上去就像没成功。
    try {
      const fresh = await apiFetch(`characters/${encodeURIComponent(card.id)}`);
      state.currentCharacter = fresh.data || fresh;
    } catch { /* 拿不到就用旧的，至少把提示写清 */ }

    const { renderCharContext } = await import("./characters.js");
    await renderCharContext();
    toast("立绘已更新", "success");
  } catch (e) {
    const why = friendlyError(e);
    setNote("出图失败：" + why);
    toast("出图失败: " + why, "error");
  } finally {
    busy = false;
    const b = $("ctx-portrait");
    if (b) b.disabled = false;
  }
}
