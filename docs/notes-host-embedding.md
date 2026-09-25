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

## 所以现在能走的路只有两条

**① 实验台直连 SiliconFlow**（今天就能跑，用的是同一个模型）
在自己终端里给 key，**不要写进任何脚本或日志**：

```powershell
$env:SILICONFLOW_API_KEY = "sk-..."      # 你自己的 shell 里
$py run_sample.py --encoder api --base-url https://api.siliconflow.cn/v1 --model BAAI/bge-m3
```

**② 给宿主契约加一条 embedding 面**（这是宿主侧的事，不是 App 能自己解决的）

要加的话，形状大概是这样（和现有契约同构）：

```ts
interface HanaPluginModelsV2 {
  // …
  embed(request: { requestId: string; provider: string; model: string;
                   input: string | string[]; dimensions?: number }): Promise<{ vectors: number[][] }>;
}
```

加的收益不只是这一个实验台：**任何想做"记住以前发生过什么"的 App 都需要它**
（检索、去重、聚类、相似度）。宿主里那个模型已经在付费清单上，
但目前只有 App 之外的运行时能用。

## 一句话

**"能用"和"能看见"是两件事。** 这次卡住的位置不在实验台，也不在网络——
在**契约**上。而契约是宿主作者自己写的那份（也就是你）。
