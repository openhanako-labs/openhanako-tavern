# 需求：让沙箱内的 App 能算 embedding（`models.embed`）

> 这份文档改过三版，前两版的原因都是错的。这一版有确诊证据。
>
> 结论：**白名单补了、能力加了、用户在界面上也批准了、宿主也重启了 ——
> App 进程的网络仍然被进程级拒绝。**

证据（酒馆 `tavern_embed` 的真实报错，2026-09-25）：

```
连不上 embedding 端点（https://api.siliconflow.cn）：
  fetch failed（cause: ERR_ACCESS_DENIED getaddrinfo ERR_ACCESS_DENIED api.siliconflow.cn）
```

`getaddrinfo` 返回 `ERR_ACCESS_DENIED`（Windows 上对应 WSAEACCES / 10013）
——**这不是 DNS 解析失败，也不是白名单不放行，是这次调用被权限层拒绝了。**
App 进程连域名都解析不出去。

## 对照组（同一台机、同一把凭据、同一个端点）

| 谁在发 | 结果 |
|---|---|
| 宿主外的普通 node 进程 | `HTTP 200`　1024 维　367ms |
| App 进程（eleckoi-tavern） | `fetch failed` + `ERR_ACCESS_DENIED` |

## 已经排除的（每一条都实测过）

- **API**：好的（200 / 1024 维 / usage 正常）。
- **凭据**：好的（`tavern_embed_status` 拿得到 baseUrl + apiKey）。
- **模型**：找得到（`BAAI/bge-m3`，`foundBy=scan`——按 `type:"embedding"` 查是 0 条，
  宿主把没写 `type` 的模型一律算 chat，扫目录才认出来）。
- **白名单**：`network.allowedHosts: ["api.siliconflow.cn"]`、`methods: ["GET","POST"]` 已填。
- **能力**：`app/runtime.network` 已加（另外五家能联网的 App 都带着这条：
  comfyui-hana / hana-downloader / hana-media-manager / hanako-gallery / token-tracker-app；
  唯一例外 bilibili-intake-v2 走 `app/process.spawn`，是子进程联网）。
- **用户批准**：App 详情页那排权限开关**全是打开的**（含「允许受管程序联网」）。
- **宿主重启**：重启过（工具通道恢复了，网络仍然被拒）。

## 所以真正缺的是什么

App 进程的网络访问在**进程级**被拒。这不在 App 能改的范围内——
manifest 里的白名单与能力都只能"申请"，真正决定放不放行的是宿主，
以及它给 App 进程套的那层限制。

**请求（按优先级）：**

1. **让 App 进程的网络访问真正开通**，或者写清楚它还需要什么才能开通
   （某条能力？某个开关？安装时物化？）。现在的状态是：
   manifest 两处都写对了、用户在界面上批准了，进程仍然连 DNS 都出不去。
   顺带：被拒时的报错最好能直接说"网络被沙箱拒绝"，
   而不是让它伪装成 `fetch failed`（我是把 undici 的 `cause` 挖出来才看见 `ERR_ACCESS_DENIED` 的）。
2. **或者**：给一条 `models.embed` 面，让宿主代劳算向量。这条更贴设计——
   契约自己写着：
   > Provider credentials, endpoints, headers and transport configuration are
   > **deliberately absent**: Hana keeps those in its shared model runtime.

   宿主有网、有凭据、能抹平端点差异，App 只要向量。

   ```ts
   embed(request: {
     requestId: string;
     provider: string;
     model: string;
     input: string | string[];
   }): Promise<{ vectors: number[][]; dimension: number }>;
   ```

   - 能力名建议 `app/models.embed`（与 `models.read` / `models.infer` 并列）。
     **不复用 `infer`**：这条面存在的意义就是能力收窄——只给向量，不给一把完整钥匙。
   - ⚠️ **不要**加 `dimensions`：那是 OpenAI text-embedding-3 的东西，
     `bge-m3` 收到直接 `400 · code 20015`（酒馆侧实测踩过）。
   - 验收：酒馆侧 `lib/embed/service.js` 那个分支就在等它（两个调用点已经把 `sdk.models`
     传进去了），`test/regression-embed.mjs` 里两条——有这条面就走它
     （`via: "host"`，并用 `fetchImpl` 抛错证明它**没去取凭据**）；没有就直连（`via: "direct"`）。

## 附带一条（小，不急）：工具通道会被一次 reload 静默掐断

App 暴露给模型的工具（`app/tools.expose-to-model`），**只在宿主启动时建立通道**：

- 重启宿主 → 工具立刻可调（实测：`tavern_list_characters`、`tavern_embed_status` 真返回）。
- 此后**只要重载一次 App**（从界面重载也好、用扩展管理工具重载也好）→ 通道断掉，
  之后调用全是 `RPC peer closed; cannot call callback.tools.execute`；
  而且**把 App 的界面打开也没用**（窗口开着，peer 仍然 closed）。
- 自己 `reload`、二次 `reload`、`disable → enable`、先刷新工具目录都不管用。

同一时刻 `extension_manager inspect` 报 `host=on agent=on`，不代表工具能跑。

**请求**：要么让工具通道在 reload 后能重建，要么让 `inspect` / 工具目录如实反映
"它已经断了"——现在那个 `on` 会让人以为能跑。

---

记录人：奥菲莉娅（月曦夜的助手） · 2026-09-25（当日第三版，附确诊证据）
来源仓库：`W:\Games\Hanako\.hanako\apps\eleckoi-tavern`
相关文件：`lib/embed/{service,tool,routes}.js`、`manifest.json`、`docs/notes-host-embedding.md`
