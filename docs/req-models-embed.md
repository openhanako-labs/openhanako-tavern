# 需求：App 侧算 embedding 的两条路（附：`models.embed` 的价值在哪）

> **2026-09-25 当日更正**：这份文档的第一版把原因写错了。
> 我当时的结论是"沙箱内的 App 出不了网，所以缺一条 `models.embed` 面"。
> 查清了不是这么回事——真正挡住的是 **App 自己 `manifest.json` 里的
> `network.allowedHosts` 是空数组**。那是我自己写的，**门就在我手上**。
> 把域名填进去就能跑。
>
> 所以这份文档现在分两半：
> ① **已经能跑的路**（App 自己发请求 + 白名单）——记录原因与做法，不需要谁改宿主；
> ② **仍然值得提的一条**（`models.embed`）——不是"做不到"，是"更干净"。

## ① 已经能跑的路：App 自己发请求 + manifest 白名单

### 走通它需要什么

App 的 `manifest.json` 里有一个出站白名单：

```json
"network": {
  "allowedHosts": [],          // ← 空数组 = 全部拒绝
  "methods": [],
  "allowLocalhost": false
}
```

填上要访问的域名即可。参照 `bilibili-intake-v2`（它那份里本来就写着 `api.siliconflow.cn`）：

```json
"network": {
  "allowedHosts": ["api.siliconflow.cn"],
  "methods": ["GET", "POST"],
  "allowLocalhost": false,
  "defaultTimeoutMs": 30000,
  "maxResponseBytes": 5242880
}
```

改完，宿主会把它判定为**新增权限**，reload 时返回：

```
Reload of app:eleckoi-tavern needs the user's review for newly declared authority.
```

→ 需要用户批准。这是对的：出站白名单就该有人过一眼。

### 当时的误判（留档，别再犯）

先看到 `fetch failed`，又从"宿主给 App 的能力清单里没有 network 字样"推成
"宿主根本没有这条路"——**推过头了**。实际上：

- App 出站**不看能力清单**，看的是 manifest 里的 `network.allowedHosts`；
- `app/runtime.network` 是另一回事（那是 `ctx.runtime.*` 那条面，
  `comfyui-hana`、`hana-mail`、`token-tracker-app` 在用）；
- `bilibili-intake-v2` 既没 `app/runtime.network`、也不走 `ctx.runtime`，
  它声明 `app/process.spawn`，靠**子进程**联网。

一句话：**门在我自己的清单里，我一直在外面找。**

## ② 仍然值得提的一条：`models.embed`（不是"做不到"，是"更干净"）

现在这条路（App 自己取凭据 + 自己拼端点）**能跑**，但有两个代价：

1. App 手里是一把**完整凭据**（`provider:credentials` 返回明文 `apiKey`）。
   出站白名单一开，它就能把 key 带到任何被允许的域名去。
2. 端点差异要 App 自己记。比如 `dimensions`——那是 OpenAI text-embedding-3 的东西，
   `bge-m3` 收到直接 `400 · code 20015`（酒馆侧实测踩过）。

而契约自己写着：

> Provider credentials, endpoints, headers and transport configuration are
> **deliberately absent**: Hana keeps those in its shared model runtime.

所以长期更贴设计的是宿主补一条：

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
- ⚠️ **不要**加 `dimensions`（见上）。
- 验收：酒馆侧 `test/regression-embed.mjs` 里两条 —— 有这条面就走它
  （`via: "host"`，并且用 `fetchImpl` 抛错来证明它**没去取凭据**）；
  没有这条面就退回直连（`via: "direct"`）。
  `lib/embed/service.js` 里那个分支就在等它，两个调用点都已经把 `sdk.models` 传进去了。

## 附带一条（小，不急）：工具可执行性

App 暴露给模型的工具（`app/tools.expose-to-model`），只在 App 的 UI 实例（窗口）
活着时才能执行；窗口一关，工具**仍出现在工具目录里**，但调用返回：

```
RPC peer closed; cannot call callback.tools.execute
```

同一时刻 `extension_manager inspect` 报 `host=on agent=on`（不代表工具能跑）。
自己 `reload`、二次 `reload`、`disable → enable`、先刷新工具目录都不管用。

**2026-09-25 当天更正（观察更准了，前面那版说成“窗口活着就能跑”是错的）**：

- 重启宿主 → 工具立刻可调。实测：重启后 `tavern_list_characters`、
  `tavern_embed_status` 都真返回了，而 `tavern_embed` 已经能一路走到
  “拿凭据、算请求”那一步。
- 此后**只要重载一次 App**（从界面重载也好、用扩展管理工具重载也好）→ 通道断掉，
  之后调用全是 `RPC peer closed`；而且**把 App 的界面打开也没用**（窗口开着，peer 仍然 closed）。
- 界面开着/关着都不影响这个判断：窗口列表可以一直是 0 个而工具照旧能用（刚重启那阵），
  也可以是窗口开着而工具全死（重载之后）。

→ 操作结论：**改完 App 不要重载，直接重启宿主。**
→ 对设计者的请求不变，只是更具体：**这条通道不应该被一次 reload 静默掐掉**，
要么让它重建，要么让 `inspect` / 工具目录如实反映它已经断了。

**请求**：要么让工具执行不依赖 UI 窗口，要么让 `inspect` 如实反映"此刻能不能执行"
——现在那个 `on` 会让人以为能跑。（我已用"重启宿主"绕过，故列为小项。）

---

记录人：奥菲莉娅（月曦夜的助手） · 2026-09-25（当日更正一版）
来源仓库：`W:\Games\Hanako\.hanako\apps\eleckoi-tavern`
相关文件：`lib/embed/{service,tool,routes}.js`、`manifest.json`、`docs/notes-host-embedding.md`
