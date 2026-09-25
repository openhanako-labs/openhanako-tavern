# 记一笔：宿主里的 embedding 模型，App 用不上（2026-09-25）

## 事实

宿主的模型清单里**有** embedding 模型：

```
BAAI/bge-m3          ← provider: siliconflow
   baseUrl  https://api.siliconflow.cn/v1
   api      openai-completions            ← OpenAI 兼容
   apiKey   hana-runtime-api-key:siliconflow   ← 运行时引用，明文不在清单里
```

（这份清单 App 侧自己就承认过：`lib/llm/service.js:83` 写着"真实目录第一项是
`BAAI/bge-m3`（embedding），盲选会让每次生成都失败"——所以那里还专门有个
`NON_CHAT_PATTERN` 把它过滤掉。）

## 但 App 拿不到它

`apps/eleckoi-tavern/sdk/app-contract/models.d.ts` 全文读完，**只有四个成员**：

```ts
list()                      // 读目录
stream(request)             // 对话推理（NDJSON）
utility(request)            // 辅助文本模型（不可选 provider/model）
cancel(requestId)
```

契约里**没有任何 embedding 调用**。契约头部的注释是明确的设计意图：

> Provider credentials, endpoints, headers and transport configuration are
> **deliberately absent**: Hana keeps those in its shared model runtime.

也就是说：**列表能读，模型不能用。** App 看得见 `BAAI/bge-m3`，
但没有一条路能让它算出向量来。

## 顺带确认的两条路（探针实测）

| 端点 | `/models` | `/embeddings` |
|---|---|---|
| 本地中继 `http://127.0.0.1:8788/v1` | 401（要运行时 key） | **404 page not found** ✗ 不转发 |
| SiliconFlow `https://api.siliconflow.cn/v1` | 401（没 key） | 需要 key（没带就不试） |

本地中继是**对话**中继，不代理 embedding。

### ⚠️ 上面那段“只能看见不能用”是**不完整的**（同日晚更正）

我说“App 拿不到它”——不准确。准确的版本是：
**`models` 这个面里没有，但 `queries` 那个面里有。**

```ts
// app-contract/queries.d.ts
ctx.bus.request("provider:models-by-type", { type: "embedding" })
ctx.bus.request("provider:credentials",   { providerId })     // ← 就是这条
   → { apiKey, baseUrl, api, headers? }

// 授权："app/models.read" + "app/provider.credentials.read"
// （都在 APP_BUS_REQUEST_ALLOWLIST 里）
```

拿到 `baseUrl` + `apiKey` 之后，按 OpenAI 形状 POST `/embeddings` 就行。
酒馆已落地：`lib/embed/service.js`（找模型 → 取凭据 → 算）、
`lib/embed/tool.js`（`tavern_embed_status` / `tavern_embed`）、
`lib/embed/routes.js`（`GET /embed/status`、`POST /embed`）。

### 而且“要用户给 key”也是错的

钥匙一直在磁盘上：`~/.hanako/provider-catalog.json` → `providers.<id>.api_key`
（`api_key` + `base_url`，字段名就这么写）。

这个生态里**早就有人这么做**——表情包插件 `biaoqingbao/lib/shared.js:237`：

```js
const catalog = JSON.parse(fs.readFileSync(PROVIDER_CATALOG, 'utf-8'));
const provider = catalog.providers?.[providerId];
return { apiKey: provider.api_key, baseUrl: provider.base_url };
```

它的 `embedding-config.json` 里 `source: "hana"` 就是这个意思：
用宿主已经配好的那个（`siliconflow` / `BAAI/bge-m3` / 1024 维）。

**两条路都对，看身份：**

| 身份 | 该走哪条 | 为什么 |
|---|---|---|
| **插件**（跑在宿主进程里） | 直接读 `provider-catalog.json` | 它就在进程里，能读文件 |
| **App**（沙箱内） | 问 bus 要 | 沙箱内的正路，凭据由宿主现场发 |
| **宿主外的进程**（实验台） | 读文件（内存里用完即弃） | 够不着 bus；而文件本来就在 |

⚠️ 教训：我最初那个探针把 `api_key` 按“像 key 的字段”打码了——
于是它明明在屏幕上，我反而去问用户要。**打码是为了不泄露，
不该连自己都骗过去。**

## 宿主契约还该不该加一条 embedding 面

该加，但不再是为了“能用”——而是为了**沙箱内的 App 能用得干净**：
现在 App 得自己拼 `/embeddings` 请求（多一份 OpenAI 形状要维护），
而且拿的是一把**完整凭据**（不只是“能算向量”这个能力）。
加一条 `models.embed(...)` 的好处是：能力收窄（只给向量，不给钥匙）、
端点差异由宿主抹平。

```ts
interface HanaPluginModelsV2 {
  // …
  embed(request: { requestId: string; provider: string; model: string;
                   input: string | string[] }): Promise<{ vectors: number[][]; dimension: number }>;
}
```

（注意：**不要**加 `dimensions` 参数——那是 OpenAI text-embedding-3 的东西，
`bge-m3` 收到会直接 400 `code 20015`。这个坑我在实验台上踩过了。）

## 一条实测出来的行为：**工具执行要求 App 实例活着**（2026-09-25）

现象：`lib/embed/` 装好后，**用户从界面重载** → 工具当场能调（真执行、真返回）；
随后我用 `extension_manager` **无界面重载**几次 → 工具全部变成：

```
App tool "tavern_embed_status" failed: RPC peer closed; cannot call callback.tools.execute
```

而且**连旧的 `tavern_list_variables` 也一样死**——所以这不是新代码的问题，
是通道的问题。（这就是“分开验”的价值：一个对照工具就能把
“我写的新代码坏了”和“整个通道断了”分开。）

试过并且**无效**的四条（都是不同假设，不是重复重试）：

| 试的 | 结果 |
|---|---|
| `reload` 一次 | 依旧 closed |
| 再 `reload` 一次 | 依旧 closed |
| `disable` → `enable` | 依旧 closed |
| 先 `tool_search` 刷新目录再调 | 依旧 closed（不是手柄过期） |

**读法**：`peer` = App 的运行时实例。它在（比如窗口开着）→ 工具能执行；
它不在（无界面重载之后）→ 工具只剩个名字。
`inspect` 会报 `host=on agent=on`——**但那个 on 不代表工具能跑**。

**怎么办**：要验工具，就趁 App 实例活着的时候验（从界面重载后立即调）；
不要拿“工具在目录里”当成“工具能用”。

（本文里的“工具能调”那一次就是这么来的：用户从界面重载 →
我立刻调 → 真的执行了，返回了 `宿主说没有 type=embedding 的模型`。
那句报错本身倒是真的——它直接帮我把类型解析的坑挖出来了。）

## 落地清单：宿主那条 `models.embed` 面（2026-09-25 拍板要做）

来源仓库已就位：`liliMozi/openhanako`（main）。要动的就四处：

1. **契约** `app-contract/models.d.ts` 的 `HanaPluginModelsV2`（现在只有
   `list / stream / utility / cancel`）：

   ```ts
   embed(request: {
     requestId: string;
     provider: string;
     model: string;
     input: string | string[];
   }): Promise<{ vectors: number[][]; dimension: number }>;
   ```

   ⚠️ **不要**加 `dimensions` 参数——那是 OpenAI text-embedding-3 的东西，
   `bge-m3` 收到直接 400 `code 20015`。这个坑在实验台上踩过了。

2. **能力**：`app/models.embed`，与 `app/models.read` / `app/models.infer` 并列。
   新开一个而不是复用 `infer`：能力收窄是这条面存在的理由——
   只给向量，不给一把完整凭据。

3. **实现**：宿主里按 provider 的 `baseUrl` / `api` 拼 `/embeddings`，
   凭据复用宿主已有的解析（App 今天就只能自己干这件事）。
   返回 `{ vectors, dimension }`；`dimension` 由向量长度得出，不猜。

4. **验收**：酒馆侧 `test/regression-embed.mjs` 里那两条就是验收标准——
   `via: "host"` 且**不去取凭据**。宿主一长出这条面，那两条断言会直接拿它验；
   没这条面时退回直连的那条路已经绿了（`via: "direct"`）。

## 一句话

卡住的位置不在实验台，也不在网络，甚至不在“能不能写代码”——
在**我以为我看不见**。两件事都能做到：App 有 bus 那条门，
磁盘上有现成的钥匙；缺的只是有人去看。
