# 精读：MyWriting（DSH 里的小说写作工作流）

- 来源：`https://github.com/Satori-Kmj/MyWriting`（MIT）· 2026-09-22 initial commit · 32 文件 / 138KB
- 读过：`README.md`、`AGENTS.md`、`.dsh/skills/*`（6 个）、`plugin/src/*.ts`（6 个，含核心 `commit-story-update.ts` 36.5KB）、`plugin/tests/workflow-regressions.test.ts`
- **只学设计，不搬代码。** 下面所有结论都指到具体文件/常量，方便核对。

## 它是什么

跑在 **DSH（DeepSeek Harness）** 里的小说写作工作流。把"让模型照着大纲写一篇"拆成
**可检查、可修改、可持续推进**的阶段机：

```
用户大纲 → 粗纲 → 扩写大纲 → 正文 → 【用户明确采纳】 → 发布事务 → 更新状态/History
```

`.dsh/skills/` 六个技能：`story-pipeline`（权威状态机）· `outline-expansion` · `prose-writing` ·
`candidate-revision` · `memory-update` · `scene-checkpoint`。
`plugin/src/` 六个插件：三个变更工具 + 工具面闸门 + 根目录守卫 + 调用日志。

## 一、真正的骨架：**保存 ≠ 发生**

这是整份东西最值钱的一条。它把"模型生成了什么"和"故事世界里实际发生了什么"
用**两种数据状态**分开了：

- 存下来的草稿是 **pending data**（`work/draft.md` + `work/draft.meta.json`）
- 只有**用户明确采纳当前候选**才进提交阶段（`story-pipeline` Stage 3 → 4）
- 而且明确写了**什么不算采纳**：「继续」「下一步」「赞」「沉默」都不是，
  `Stage 3` 里要**留在原地**

`AGENTS.md` 把它写成一句不容含糊的话：

> Tool results and verified filesystem state are authoritative.
> A saved draft … is **pending data, not committed story canon.**

## 二、两段式发布 + 内容哈希绑定

```
commit_story_draft   → work/commit-intent.json  （transaction_id / draft_sha256 /
                                                  base_commit_id / base_manifest_sha256）
                        只做出「待批准的待定事务」，**不发布**
commit_story_update  → 唯一发布工具：写 history/<id>/，再把工作副本物化出去
```

三条闸门（都在 `commit-story-update.ts`）：

1. **内容绑定**：`sha256(work/draft.md)` 必须同时等于 `draft.meta.sha256`
   **和** `intent.draft_sha256`，否则 `DRAFT_VERSION_MISMATCH`。
   → **不能批准 A、提交 B。** 采纳的是内容本身，不是"那一版"。
2. **乐观并发**：intent 记着批准时的 `base_commit_id` 与 `base_manifest_sha256`；
   历史基底动过就 `BASE_COMMIT_MISMATCH` / `BASE_MANIFEST_MISMATCH`。
   → 事务只对它被批准时的那份基底有效，别人插进来就作废重来。
3. **幂等重试**：若最新提交的 `transaction_id` + `source_draft_sha256` 与 intent 相符，
   说明历史已发布、只是上次没收尾 → 走**重试路径**，只重新物化，
   **不重新生成、不开新 intent**。返回 `already_committed`。

## 三、第三态：`committed_needs_sync`

发布分两半：**写历史**（不可变、正典）和**物化工作副本**（output/ state/）。
两半可能一半成一半败。它承认这个第三态，并给**唯一一条出路**：

- `committed` / `already_committed`：还要求 `materialized: true` **且** `verified: true` 才算完
- `committed_needs_sync`：历史成了、副本没成 → 报 `sync_error`，
  **只许重试同一笔事务**；不许重新生成、不许开新 intent、不许碰旧工具
- 抛错：那次调用**没有**建立新的有效历史 → 停下报告、保住待定产物、**不许手改状态**

另外：**正典 = 最新有效的 `history/<commit_id>/` 快照**；
`output/accepted-draft.md`、`state/current-scene.md`、`state/recent-prose.md`、`state/rag/`
都只是**物化出来的工作副本**。而 `state/current-commit.json` 这枚**标记最后写**——
源码注释：*"Marker is written last; it certifies that all canonical working-copy files above were verified."*
（用**写入顺序**换原子性。）

## 四、两道防线，都不靠提示词自律

`mywriting-tool-filter.ts`：

- **工具面白名单**（8 个）：`read` / `glob` / `grep` / `skill` / `ask_user_question`
  + 3 个变更工具。shell、通用文件写入、goals、todos、web、委派、编码流程
  **都在写作 Agent 的面之外**（`AGENTS.md` 明写）
- **受保护路径**：13 个精确文件 + 5 个目录（`input/ work/ output/ state/ history/`），
  路径比对做了规范化（Windows 下大小写折叠）

即使某个通用写工具漏进来，也写不进那几个目录。这是**纵深防御**，不是提醒。

## 五、它的"防幻觉"条款（和我们在做的事高度重合）

- *"Do not claim that an artifact, approval, commit, synchronization, or workflow
  completed unless the responsible tool returned the required success state."*
- *"A progress summary never replaces a remaining stage."*
- *"A DSH goal is not pipeline state."*（别拿目标/待办当流程状态）
- *"If a required skill fails to load, stop and report the failure. Do not imitate
  or reconstruct the missing skill."* ← 这条是在防模型的**补全冲动**

测试也照着这些写：Allowlist 必须最小、mutation guard 必须活着、
**损坏的快照必须是完整性错误（不许混进 `committed_needs_sync`）**、
阶段顺序/采纳/提交不变量都在。

## 六、对照：我们（eleckoi-tavern）已有 / 真缺

| MyWriting | eleckoi-tavern |
|---|---|
| 稳定档案 vs 持续状态分家 | **已有**：变量定义 vs 值；设定库 vs 黑板 |
| 「工具没成功就不许说完成」 | **已有**（这一整天都在做这个） |
| prompt 组装返回"账"（谁进/谁没进+理由） | **已有**：`audit.included/omitted/warnings` |
| **保存 ≠ 发生**（pending vs canon） | **缺**：回复一落盘就是历史 |
| **内容哈希绑定**（批准的是内容，不是"那一版"） | **缺**：变体/summary 都是"最新者胜" |
| **乐观并发**（事务绑基底） | **缺** |
| **第三态 + 唯一修复路径** | **缺**：多文件写靠 `atomic.js` 兜，没有"半成"的表达 |
| **写入标记最后落**（用顺序换原子性） | **部分**：`atomic.js` 是临时文件+改名 |
| **工具面白名单 + 受保护路径** | **缺**：路由全量开放 |
| **History 快照 = 正典** | **缺**：单一对话文件 + git 备份 |

## 七、如果要移植，按这个顺序

1. **「采纳门槛」**——回复生成完 ≠ 已发生；给"采纳"一个明确的动作与状态。
   （酒馆里这条最值钱，也最贴它的形状。）
2. **内容哈希绑定**——采纳时记下内容的 sha256，落盘前比对三处；
   挡住"批准 A 提交 B"。
3. **第三态**——把"对话/变量/摘要/黑板"这几次写当成一笔事务，
   失败时表达成"半成 + 唯一修复路径"，而不是各写各的。
4. **工具面**——对 Agent 面收窄到必要的那几个 + 受保护路径。

（第 1、3 条在酒馆里都属于"对话模型 + 落盘路径"的改动，不是加个页面。）
