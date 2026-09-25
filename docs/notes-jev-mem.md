# 精读：Jev-Mem（System-One 控制的 agentic memory）

- 来源：`https://github.com/libingzheren/Jev-Mem`（MIT）· 论文 arXiv **2609.23986**（2026-09）
- 作者：Dongming Jiang / Yi Li / Bingzhe Li
- 读过：`README.md`、`memory/` 的模块分布与关键文件（`jev_client.py` / `jev_questions.py` /
  `jev_mem_policies.py` / `jev_mem_retrieval.py`）、配置字段表
- 只学设计，不搬代码。**它是论文实现 + 检索评测**，不是角色扮演系统——数值别照搬。

## 它是什么

把"记忆管理"和"回答问题"拆给两个角色：

| 组件 | 干什么 |
|---|---|
| **System One（控制器）** | 记忆分类、关系判定、**查询路由**、预算分配、候选打分、证据充分性评估 |
| **共享记忆** | 原始观察 + **四种关系图视图**（语义 / 时间 / 因果 / 实体）+ 向量与关键词索引 |
| **System Two（语言模型）** | 只做一件事：拿选中的证据合成答案 |

LoCoMo（GPT-4o-mini）报的是：总分 0.777（最强基线 MAGMA 0.700）、
构建 158s（比最快基线快 6.6×）、查询延迟 0.93s（低 36.7%）；五类问题里四类领先
（时间类 MAGMA 更高——它没藏这条）。

## 真正可学的四条

### ① 决策**有名字**，而且**有类型**

`memory/jev_questions.py` 里三组问题：`routing_questions` / `stopping_questions` /
`traversal_questions`。输出分两种类型：

- **Noul**：二元命题 → 给概率
- **Choice**：分类决策 → 给选项

`jev_client.py` 里写着 *"Noul probabilities and complete Choice answers, **never conflated**"*，
混用会直接 `ValueError`。→ **决策不是一个自由文本，是一个有类型的提问。**

### ② 预算由**代码**守，绝不由模型自律

```python
budget = CallBudget(cfg.maximum_jev_calls, started + cfg.max_latency_seconds)
if budget.remaining_seconds() > 0: ...
```

`maximum_nodes` / `maximum_edges` / `total_graph_budget` / `maximum_jev_calls` 全在配置里。
README 还如实标注：**延迟是在操作之间检查的，不是严格的墙钟截止**。
→ 限流是**外部的、可数的**，模型说什么都不改变它。

### ③ 循环要**带着理由停下**

`jev_mem_retrieval.py`：`stop_reason` 有明确取值（`no_evidence` / 充分 / 期望值太低 / 触限）。
配合 trace 暴露 routing / budgets / stopping / cache hits / fallbacks。
→ **"停下来了"不够，要能说出为什么停。**

### ④ 证据要留原样（有损的只是索引）

*"Preserve the evidence. Keep original observations, timestamps, and provenance."*
默认档 `admission_enabled: false` = **全部收下**（"一个细节当下看不出有用，以后可能有用"）。
→ 压缩可以有损，**原文不许有损**。

## 一个结构上的共鸣

它的记忆有**四种正交关系**（语义/时间/因果/实体），而不是一棵分类树。
我们的黑板格也是三个正交标签（活多久 / 谁看得见 / 何时醒）。

**同一种立场：正交的多轴 > 单一的层级。** 层级逼你二选一，正交轴可以只答一维。

## 对我们（eleckoi-tavern）：已经做对的 / 可以借的

| Jev-Mem | 酒馆现状 |
|---|---|
| 原文不许有损，有损的只是索引 | **已有**：折叠是每轮按预算**重算**的，消息一条不删 |
| 正交多轴 > 单一层级 | **已有**：黑板格三标签；变量「定义 vs 值」也分家 |
| 「停下来了」要能说出为什么 | **已有**：`audit.omitted` 每条带理由；护栏遇错要说清哪个 id |
| 决策有类型（Noul / Choice） | **可借**：我们的决策（激活哪条设定 / 哪些格上场 / 该不该折）是散在代码里的隐式判断，没有名字也没有类型 |
| 预算由代码守、由配置给 | **部分**：有 `historyBudget` / `SUGGESTION_LIMIT`，但散落各处，没有统一的一处声明 |
| 循环带 `stop_reason` | **不适用**：我们没有"检索-评估-再检索"的循环（除非将来做多轮查证） |

**要借就借前两条里那条"可借"的：把散落的决策收成有名字、有类型的提问。**
它的价值不在省 token，在于**每个决策都能被单独测、单独记、单独关掉**。

## 实测：搭了个实验台，它给出的第一个结论是“测不了”

实验台在 `W:\Games\Hanako\Work\projects\jev-mem-bench`（**不在本仓库**，失败能整块扔掉）。
造了一份带标准答案的 18 条中文对话 + 5 个问题。结果按顺序说：

1. **形状接得上**：18 条观察全部入库、0 条被拒。它要的就是
   `[{content, timestamp, metadata}]`，从我们的对话转过去没有障碍。
2. **mock 路径不能判质量**。表面上是“命中 2 / 部分 2 / 落空 1”，但脚本自检拆穿了它：
   **五题返回集合的两两平均重叠度 77%**——检索几乎不随问题变。
   因为三个部件里两个是假的：向量检索关着（MockEncoder），
   决策也是 mock（四视图预算每次都一样）。那些“命中”是碰上的。
3. **真编码器这条路被本机网络堵住了**：直连 huggingface 不通，
   镜像拿到配置但倒在 Xet 存储层（401），关了 Xet 又倒在 TLS 证书。
   三层都不是 Jev-Mem 的问题。

**这一轮真正产出的东西有两个**：一是“**能装、能跑、形状接得上**”这个事实；
二是那个自检——**它防止下一个人把 77% 重叠下的命中率当真**。

要越过它，只有两条路：（a）本地真 embedding 跑起来（差一个能下模型的网络）；
（b）用他们的托管服务（`TYPESAFE_API_KEY`，数据出本机——你的判断）。

## 备注（别误读）

- 评测是 LoCoMo / LongMemEval 这类**问答检索**基准，跟角色扮演的"记得住人设与关系"
  不是同一类任务。借的是**控制器的纪律**，不是它的分数。
- README 自己就标了两处诚实限定：命令本身不重现完整评测；LongMemEval runner
  用的是宽松打分器，**不是官方指标**。这种自我限定值得学。
