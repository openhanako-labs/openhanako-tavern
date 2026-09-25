# 记录：App 里怎么正确地出网（`sdk.network.fetch`）

> 2026-09-25 收尾版。前三版把原因写错了 —— "宿主没有这条路" → "沙箱设置" →
> "白名单是空的" → 实际是**用错了门**。这一版是跑通之后的定稿。

## 结论（已实测跑通）

App 出网必须走 `sdk.network.fetch`：

```js
const r = await sdk.network.fetch("https://api.siliconflow.cn/v1/embeddings", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({ model, input })
});
```

- App 入口跑在独立的 **AppHost 子进程**里，**原始网络被 Node 权限模型拒掉**。
  直接 `globalThis.fetch` 的结果是 `getaddrinfo ERR_ACCESS_DENIED`
  （Windows 上 WSAEACCES / 10013）——看着像 DNS 坏了，其实是被权限层拒了。
- `sdk.network.fetch` 跨 IPC 让**宿主**代为检查
  （白名单 → 私网/HTTPS → 方法 → 超时 → 字节上限）并发出；
  检查用的就是 manifest 里的 `network.allowedHosts`。
- v2 **没有**单独的 `network.fetch` 能力；`app/runtime.network` 是给
  **受管运行时 / 外部命令**用的，进程内出网不需要它。

manifest 里那一段：

```json
"network": {
  "allowedHosts": ["api.siliconflow.cn"],
  "methods": ["GET", "POST"],
  "allowLocalhost": false,
  "defaultTimeoutMs": 30000,
  "maxResponseBytes": 5242880
}
```

## 实测结果（2026-09-25 收尾）

```
tavern_embed   → providerId=siliconflow  model=BAAI/bge-m3
                 dimension=1024  count=3  file=embed-probe.json (65,497 字节)
落盘校验       → 3×1024、无全零、无 NaN、整体范数 1.73
指纹对照       → 第一维 0.0127 == 直连探测那次 0.0127（逐位一致）
```

（余弦那三个数字不能当质量证据：0.3878 / 0.3543 / 0.4075 全挤在一条窄带里，
bge-m3 在短句上就是这样。判质量要用检索测。）

## 给宿主的一条建议（唯一还值得改的）

`getaddrinfo` 被权限层拒掉时，报错应该直说
"该 App 的原始网络被沙箱拒绝，出网请用 `sdk.network.fetch`"，
而不是伪装成 `fetch failed`。
——我是挖 undici 的 `cause` 才看见 `ERR_ACCESS_DENIED` 的，这一步不该靠猜。

## 附带一条：工具通道会被一次 App reload 静默掐断

App 暴露给模型的工具（`app/tools.expose-to-model`），**只在宿主启动时建立通道**：

- 重启宿主 → 工具立刻可调（实测：`tavern_list_characters`、`tavern_embed_status` 真返回）。
- 此后**只要重载一次 App**（从界面重载也好、用扩展管理工具重载也好）→ 通道断掉，
  之后调用全是 `RPC peer closed; cannot call callback.tools.execute`；
  **把 App 的界面打开也没用**（窗口开着，peer 仍然 closed）。
- 自己 `reload`、二次 `reload`、`disable → enable`、先刷新工具目录都不管用。
- 同一时刻 `extension_manager inspect` 报 `host=on agent=on`，不代表工具能跑。

操作结论：**改完 App 不要重载，直接重启宿主。**

另：`hana-app-creator` SKILL 里写着「用户安装的 App 不能用 force reload」，
且「manifest 扩大声明时宿主要求既有复核，**取消则保留旧实例在跑**」
（`cancellation leaves the old instance running`）——所以"打开了复核框"不等于"批准了"。

## `models.embed` 还要不要

**不再是阻塞项**（`sdk.network.fetch` 这条路已经跑通）。
仍然值得做，但理由从"做不到"降为"更干净"：App 现在手里是一把**完整凭据**
（`provider:credentials` 返回明文 apiKey），出网门一开，它就能把 key 带到任何
被允许的域名去。若宿主愿意代劳（只给向量、不给钥匙、端点差异由宿主抹平），
酒馆这边已经留好分支：`lib/embed/service.js` 的 `modelsFace`，
返回里 `via: "host" | "direct"` 可诊断，测试在 `test/regression-embed.mjs` 里等着。

签名（**不要加 `dimensions`**：bge-m3 收到直接 400 code 20015）：

```ts
embed(request: {
  requestId: string;
  provider: string;
  model: string;
  input: string | string[];
}): Promise<{ vectors: number[][]; dimension: number }>;
```

---

记录人：奥菲莉娅（月曦夜的助手） · 2026-09-25（收尾版）
来源仓库：`W:\Games\Hanako\.hanako\apps\eleckoi-tavern`
关键依据：`C:\Users\Administrator\.hanako\skills\hana-app-creator\SKILL.md`
　（"network: the checked outbound door" 一节）
