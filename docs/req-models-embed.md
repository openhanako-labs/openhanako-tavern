# 需求：让沙箱内的 App 能算 embedding（`models.embed`）

> 一句话：App 找得到模型、拿得到凭据、也拼得出请求，但**发不出去** ——
> 沙箱内的 App 没有出站网络。按宿主契约自己的设计意图，这件事本该由宿主代劳。

## 现象（可复现）

酒馆 App（eleckoi-tavern）用 `app/models.read` + `app/provider.credentials.read`
找到 `BAAI/bge-m3` 并拿到 `{ baseUrl, apiKey }` 后，按 OpenAI 形状 POST `/embeddings`：

```
连不上 embedding 端点（https://api.siliconflow.cn）：fetch failed
```

同一个端点、同一台机、**宿主之外**的一个 node 进程：

```
HTTP 401          ← 通，只是没带 key
```

差别不在网络，在**谁在发请求**。

## 证据

1. `tavern_embed_status` 全绿：

   ```
   ok:true  step:credentials
   providerId=siliconflow  model=BAAI/bge-m3  candidates=1  foundBy=scan  scanned=13
   note: 宿主按类型查 embedding 是 0 条（它把没写 type 的模型一律算 chat），改扫目录：13 条里认出 1 条
   ```

   → **授权没问题、模型没问题、凭据没问题。**（`foundBy=scan` 这条本身也值得看一眼：
   按 `type: "embedding"` 查永远是 0 条，只有扫目录按 id 认才认得出来。）

2. App 侧 `fetch` → `fetch failed`，DNS/连接层就没出去。

3. 宿主给 App 的能力清单里**没有** network / fetch / egress / outbound 任何一条：

   ```
   app/tools.expose-to-model, app/ui.open-external, app/resources.read,
   app/models.infer, app/models.read, app/provider.credentials.read
   ```

## 为什么"App 自己发请求"本来就是错的路

`app-contract/models.d.ts` 头部写着：

> Provider credentials, endpoints, headers and transport configuration are
> **deliberately absent**: Hana keeps those in its shared model runtime.

宿主的设计**就是**不让 App 碰 provider 的传输层。酒馆现在这条路
（自己取完整凭据 + 自己拼端点）是在**绕**这个设计，而沙箱把它堵住了——堵得对。
所以这不是"给 App 开个联网权限"的问题，是**缺一条面**。

## 请求

`HanaPluginModelsV2` 加一个成员：

```ts
embed(request: {
  requestId: string;
  provider: string;
  model: string;
  input: string | string[];
}): Promise<{ vectors: number[][]; dimension: number }>;
```

- 能力名建议 `app/models.embed`，与 `app/models.read` / `app/models.infer` 并列。
  **不复用 `infer`**：这条面存在的意义就是能力收窄——只给向量，不给一把完整凭据；
  端点差异（哪个 provider 吃 `dimensions`、哪个不吃）也由宿主抹平。
- ⚠️ **不要**加 `dimensions` 参数：那是 OpenAI text-embedding-3 的东西，
  `bge-m3` 收到直接 `400 · code 20015`。（酒馆侧已经实测踩过一次。）

## 验收标准

酒馆侧 `test/regression-embed.mjs` 里已经写好了两条，宿主一有这条面就会**自动**用它
（`lib/embed/service.js` 里那个分支在等它，两个调用点都已经把 `sdk.models` 传进去了）：

1. 宿主有 `models.embed` → 走它：返回 `via: "host"`，**且不去调 `provider:credentials`**
   （用 `fetchImpl` 抛错来证明它根本没碰网络）。
2. 宿主没有这条面 → 退回现在的直连：`via: "direct"`。

## 附带一条（小，不急）

App 暴露给模型的工具（`app/tools.expose-to-model`），只在 App 的 UI 实例（窗口）
活着时才能执行；窗口一关，工具**仍出现在工具目录里**，但调用返回：

```
RPC peer closed; cannot call callback.tools.execute
```

同一时刻 `extension_manager inspect` 报 `host=on agent=on`（不代表工具能跑）。
自己 `reload`、二次 `reload`、`disable → enable`、先刷新工具目录都不管用；
从界面重载、或重启宿主之后立即调用才跑得起来。

**请求**：要么让工具执行不依赖 UI 窗口，要么让 `inspect` 如实反映"此刻能不能执行"
——现在那个 `on` 会让人以为能跑。
（我已经用"重启宿主"绕过，故列为小项。）

---

记录人：奥菲莉娅（月曦夜的助手） · 2026-09-25
来源仓库：`W:\Games\Hanako\.hanako\apps\eleckoi-tavern`
相关文件：`lib/embed/{service,tool,routes}.js`、`docs/notes-host-embedding.md`
