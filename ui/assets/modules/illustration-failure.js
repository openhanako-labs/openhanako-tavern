// illustration-failure.js — 把出图失败的原话拆成「一句人话」+「详情原文」
//
// 为什么值得单独一个模块：
//   它是**纯函数**（不碰 DOM、不碰 SDK），所以能直接在 Node 里测。
//   而它要解决的问题只在真机上才看得见——留个能跑测试的地方，比"下次注意"实在。
//
// 判据 4 要求「失败要说清原因，带宿主原话」。这条纪律容易被做成两种错：
//   ① 换成一句笼统的"生成失败"——原话丢了，查不出为什么（纪律本身就是防这个）
//   ② 把原话**原样糊在聊天里**——原话是够了，但那是给排查的人看的，
//      不是给用户看的。真机上那条长这样：
//        取不到图片字节：getTaskResources → APP_HOST_ERROR Media task output is not complete:
//        getTaskFileContents → task 里没有 sessionFiles (status=failed): task 状态 → 任务失败:
//        Media task failed. Review the provider configuration and try again.
//      跨了四层调用链、中英夹杂。用户读不懂，只会以为 App 坏了。
//
// 这一步做的是把它分成两半：**先给一句人话，原话收在「详情」里，一个字不丢。**

/**
 * @param {string} failReason 宿主/引擎回来的原话
 * @returns {{headline: string, detail: string}}
 *   headline —— 一句人话，说明**哪一步不成了**
 *   detail   —— 原话（空串表示本来就没有）
 */
export function splitFailure(failReason) {
  const raw = String(failReason ?? "").trim();
  if (!raw) {
    // 没有原因本身就是个 bug（不该静默），所以这句要写成"该查"，不是"未知原因"
    return { headline: "没写出原因——这条值得报一下。", detail: "" };
  }

  /*
   * 按"哪一步不成了"归类，不按错误码。
   * 用户关心的是「是配置问题 / 是引擎问题 / 是我自己的卡问题」，
   * 不是 getTaskFileContents 和 getTaskResources 的区别。
   *
   * 顺序有讲究：越具体的放前面。比如"参考图被拒"的原文里也含 provider configuration，
   * 但先命中的那条才是有用的那一句。
   */
  const RULES = [
    [/参考图|reference image/i, "参考图没被接受——这张是带着角色立绘画的，引擎那边不收。"],
    [/没有 sessionFiles|sessionFiles/i, "出图任务失败了，宿主没拿到产物。"],
    [/output is not complete|没跑完/i, "图还没画完，就被取走了。"],
    [/provider configuration|未配置|没配置/i, "出图引擎那边没配好。"],
    [/timeout|超时|timed out/i, "等图等超时了。"],
    [/ENOTFOUND|ECONNREFUSED|fetch failed|network|网络/i, "连不上出图引擎。"],
    [/ENOENT|不存在|已删除/i, "图文件不在了。"]
  ];

  const hit = RULES.find(([re]) => re.test(raw));
  return {
    headline: hit ? hit[1] : "出图引擎那边报错了。",
    detail: raw
  };
}

/**
 * 详情要不要默认展开。
 *
 * 判据：原话短（一句以内）就展开——它本身就是一句人话，藏起来反而多一次点击。
 * 长的那种（跨了几层调用链）收起来，但**留一个明确的"详情"入口**，不许吞掉。
 */
export function detailIsShort(detail) {
  const d = String(detail ?? "").trim();
  return d.length > 0 && d.length <= 60 && !d.includes("\n");
}
