// media.js — 出图（v1：给角色卡生成立绘）
//
// 两个入口，同一个动作：
//   · 「当前角色」面板（在对话里）= 默认入口
//   · 角色编辑器弹窗 = 复查指出的缺口：不给某张卡开一场对话就没法给它出图
//
// 四条交互纪律：
//   · 长任务要说清"在做什么"——出图几十秒起步，按钮直接禁用 + 写一行状态，
//     否则用户会连点三次（然后收到三张）。
//   · 先体检再提问：先问"能不能出"（/media/status），再问"要不要出"（空卡那一问）。
//     反过来的话，后端不可用时用户白答一个问题。
//   · 成功要看得见：换完头像立刻重画一次角色面板——图变了但面板没变
//     等于告诉用户"没成功"。
//   · 别把"没刷出来"说成成功：刷新失败时说清是界面没跟上，不是活没干。

import { apiFetch, toast, escapeHtml, friendlyError, confirmDialog } from "./core.js";
import { state } from "./state.js";

/** 拆信封：这个 App 的 apiFetch 在 4xx 时不抛，会把 {ok:false,error} 整个返回。 */
function readEnvelope(res, what) {
  const env = res && typeof res === "object" ? res : {};
  if (env.ok === false) throw new Error(env.error || `${what}被拒绝了`);
  return env.data !== undefined ? env.data : env;
}

let busy = false;

const $ = (id) => document.getElementById(id);

/** 卡里有没有“这个人的东西”。名字不算：光有名字，模型手里几乎没信息。
 * 与 lib/media/prompt.js 的 hasCharacter 同一判据。 */
function cardHasContent(card) {
  const c = card || {};
  const tags = Array.isArray(c.tags) ? c.tags.filter((t) => String(t || "").trim()) : [];
  return [c.description, c.personality, c.scenario].some((v) => String(v || "").trim()) || tags.length > 0;
}

const PANE = { card: null, btnId: "ctx-portrait", noteId: "ctx-portrait-note" };
const MODAL = { btnId: "modal-portrait", noteId: "modal-portrait-note" };

/** 绑定当前角色面板上的「生成立绘」。每次重画面板都会重建按钮，所以每次重绑。 */
export function bindPortraitButton() {
  const btn = $(PANE.btnId);
  if (!btn) return;
  btn.addEventListener("click", () => void makePortrait());
}

/** 绑定编辑器弹窗里的那一个（编辑既有卡时才显示）。 */
export function bindModalPortrait() {
  const btn = $(MODAL.btnId);
  if (!btn || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", () => void makePortrait({ ...MODAL, card: state.currentCharacter, target: "editor" }));
}

/**
 * @param {{card?: object, btnId?: string, noteId?: string, target?: "pane"|"editor"}} [opts]
 */
export async function makePortrait(opts = {}) {
  if (busy) return;

  const card = opts.card || state.currentCharacter;
  const btnId = opts.btnId || PANE.btnId;
  const noteId = opts.noteId || PANE.noteId;
  const toEditor = opts.target === "editor";

  const setNote = (text) => {
    const el = $(noteId);
    if (el) el.textContent = text || "";
  };

  if (!card || !card.id) { toast("先打开一张角色卡", "error"); return; }

  const btn = $(btnId);
  busy = true;
  if (btn) btn.disabled = true;
  setNote("正在出图…（这一步要几十秒，可以先去做别的）");

  try {
    // 先体检：把“哪条路能用”和“选中的那条配全了没”分开问。
    // 之前这里只问宿主那条（/media/status）——一旦用户把引擎切成
    // 本机 ComfyUI，按钮就会一直说“宿主没提供 sdk.media”，而它说的根本不是
    // 选中的那条路。体检要问对对象，否则它比不检还坏。
    let engines = null;
    let cfg = null;
    try {
      engines = readEnvelope(await apiFetch("media/engines"), "读引擎状态");
      cfg = readEnvelope(await apiFetch("media/config"), "读出图配置");
    } catch (e) {
      const why = friendlyError(e);
      setNote("出图不可用：拿不到媒体状态（" + why + "）");
      toast("出图不可用: " + why, "error");
      return;
    }

    const backend = cfg?.backend || "host";
    const laneOk = backend === "comfyui" ? engines?.comfyui?.available : engines?.host?.available;
    const laneWhy = backend === "comfyui" ? engines?.comfyui?.reason : engines?.host?.reason;
    if (!laneOk) {
      setNote(`出图不可用：${laneWhy || "这条路的引擎不可用"}`);
      toast("出图不可用：" + (laneWhy || "这条路的引擎不可用"), "error");
      return;
    }
    if (cfg?.ready === false) {
      setNote(`出图还没配好：${cfg.reason || ""}（⋯ 菜单里有「出图设置」）`);
      toast("出图还没配好：" + (cfg.reason || ""), "error");
      return;
    }

    // 空卡先问：出图要几十秒，而这一趟注定画不出“她”。
    if (!cardHasContent(card)) {
      const yes = await confirmDialog({
        title: "这张卡里没有角色信息",
        body: "描述、性格、场景、标签都是空的。出图只会按风格画一张，不会像这个角色。\n\n仍然生成吗？"
      });
      if (!yes) {
        setNote("已取消——这张卡里没有可画的东西。");
        return;
      }
    }

    const res = await apiFetch("media/portrait", {
      method: "POST",
      body: JSON.stringify({ characterId: card.id })
    });
    const r = res.data || res;
    // 扩展名照**盘上真写的那个文件**说（后端返回 file=avatar.xxx），
    // 不自己猜一个——猜错就成了“界面说 png、盘上是别的”。
    const what = r.file || (r.avatarExt ? `avatar.${r.avatarExt}` : "图");
    setNote(`已生成（${Math.round((r.bytes || 0) / 1024)} KB，${escapeHtml(String(what))}）`);

    // 头像变了：内存里那份 currentCharacter 还是旧的（has_avatar=false），
    // 不重拉一次的话面板会继续画首字母——看上去就像没成功。
    let refreshed = false;
    try {
      const fresh = await apiFetch(`characters/${encodeURIComponent(card.id)}`);
      state.currentCharacter = fresh.data || fresh;
      refreshed = true;
    } catch { /* 下面把那句实话补上 */ }

    if (toEditor) {
      // 编辑器里的图不走角色面板，所以这里只需要让用户知道该去哪看。
      if (refreshed) {
        setNote("已生成——关掉弹窗，头像就是新的了。");
      } else {
        setNote("头像已经生成好了，但这个界面没刷出来——重开一次就能看到。");
        toast("头像已生成，界面没刷新", "error");
        return;
      }
    } else {
      const { renderCharContext } = await import("./characters.js");
      await renderCharContext();
      if (!refreshed) {
        // 别把“没刷出来”说成成功：面板还在画首字母，用户会以为白跑了。
        setNote("头像已经生成好了，但这个界面没刷出来——重开一次角色面板就能看到。");
        toast("头像已生成，界面没刷新", "error");
        return;
      }
    }

    if (r.warning) {
      setNote(String(r.warning));
      toast("立绘已更新——但卡里没有角色信息，图不会像她", "error");
      return;
    }
    toast("立绘已更新", "success");
  } catch (e) {
    const why = friendlyError(e);
    setNote("出图失败：" + why);
    toast("出图失败: " + why, "error");
  } finally {
    busy = false;
    const b = $(btnId);
    if (b) b.disabled = false;
  }
}
