// illustrate.js — 手动补一张场景图
//
// 后端那条 POST /conversations/:id/illustrate 早就写好了（plan 2.6），
// 但前端一个入口都没有——而设置面板上写着「保留手动补一张入口」。
// 一个有文案、没按钮的能力，用户只会以为是自己没找到。
//
// 为什么不是"点一下就画"：得先有一句画面描述。所以开一个只有一件事的小弹窗。
//
// 两条纪律：
//   ① 总闸关着（scene.enabled=false）**先说**，别让人写完描述才被告知不出图。
//      手动补一张也受总闸管——这不是限制，是"花钱的动作别偷偷发生"。
//   ② 发出去就交给轮询，不等这条请求：服务端要跑完整个出图（可能两分钟），
//      而"生成中"这件事**消息里已经有了**（pending 那条）。与自动触发同一条路。

import { apiFetch, friendlyError, toast } from "./core.js";
import { state } from "./state.js";

const $ = (id) => document.getElementById(id);

let masterOn = false;

export function bindIllustrate() {
  const modal = $("illustrate-modal");
  if (!modal || modal.dataset.bound === "1") return;
  modal.dataset.bound = "1";

  $("illustrate-close")?.addEventListener("click", closeIllustrate);
  $("illustrate-cancel")?.addEventListener("click", closeIllustrate);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeIllustrate(); });
  $("illustrate-go")?.addEventListener("click", () => void submit());

  // ⌘/Ctrl+Enter 直接画——写长句时不该为了让手离开键盘去点按钮
  $("illustrate-scene")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) closeIllustrate();
  });
}

export async function openIllustrate() {
  const conv = state.currentConv;
  const modal = $("illustrate-modal");
  if (!modal) return;
  if (!conv) { toast("先打开一场对话", "error"); return; }

  const ta = $("illustrate-scene");
  if (ta) ta.value = "";
  setStatus("");
  modal.classList.remove("hidden");
  setTimeout(() => ta?.focus(), 30);

  // 先问一次总闸——别让人写完一整句描述才被告知"其实不会出图"。
  try {
    const cfg = await apiFetch("illustration/config");
    const data = cfg?.data ?? cfg ?? {};
    masterOn = data.enabled === true;
  } catch {
    // 读不到配置不当成"关着"：那会把一个网络抖动说成用户的设置。
    masterOn = true;
  }

  const go = $("illustrate-go");
  if (go) go.disabled = !masterOn;
  if (!masterOn) {
    setStatus("场景插图的总闸关着——关了就不出图，手动也不行。先去「场景插图」设置里打开。", true);
  }
}

export function closeIllustrate() {
  $("illustrate-modal")?.classList.add("hidden");
}

function setStatus(text, bad = false) {
  const el = $("illustrate-status");
  if (!el) return;
  el.classList.toggle("bad", !!bad);
  el.textContent = text || "";
}

async function submit() {
  const conv = state.currentConv;
  if (!conv) return;

  const scene = String($("illustrate-scene")?.value || "").trim();
  if (!scene) { setStatus("写一句画面描述——空着没法画。", true); return; }
  if (!masterOn) { setStatus("场景插图的总闸关着，先打开它。", true); return; }

  const go = $("illustrate-go");
  if (go) go.disabled = true;

  // 先关窗：让用户看得到下面正在画的那条。留在窗里反而看不到它出现。
  closeIllustrate();
  toast("画着…好了会出现在对话里", "success");

  try {
    const r = await apiFetch(`conversations/${conv.id}/illustrate`, {
      method: "POST",
      body: JSON.stringify({ scene })
    });
    const data = r?.data ?? r ?? {};
    // 真被总闸拦下来时（开窗之后有人又去关了），得说出来——
    // 不然对话框关了、图也没来，用户只能猜。
    if (data.skipped) {
      toast(`没画：场景插图被总闸拦下了（${data.reason || "scene 未启用"}）`, "error");
      return;
    }
    if (data.status === "failed") {
      // 宿主原话在 failReason 里——别换成一句笼统的"生成失败"。
      toast(`画不出来：${data.failReason || "未知原因"}`, "error");
    }
  } catch (e) {
    // 请求本身失败不代表图没画出来（服务端可能已经在跑）：
    // 所以照样把轮询开起来，让它去问结果。
    toast(`请求出错：${friendlyError(e)}`, "error");
  } finally {
    if (go) go.disabled = false;
    // 与自动触发同一条路：交给轮询去看那条 pending 什么时候变成 ok/failed。
    import("./chat.js").then(m => m.startIllustrationPoll(conv.id)).catch(() => {});
  }
}
