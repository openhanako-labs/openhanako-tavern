# 同类项目精读：flizzywine/dsh-tavern

> 读它的目的不是抄，是**对表**：同一件事（把酒馆挂到 agent 框架上）已经有成熟形态了，
> 我想知道差距在"能力"还是在"结构"。
>
> 结论：在结构。
>
> 项目：<https://github.com/flizzywine/dsh-tavern> · AGPL-3.0 · 481★/36 fork ·
> 建于 2026-08-16 · 2026-09-24 仍在推。挂在 **DeepSeek Harness（DSH）** 上，
> Cordis 插件体系，自带 Win/macOS/Android 装机包。

## 一、我实际读了什么（边界写清楚）

| 读了 | 没读 |
|---|---|
| `README.md` 全文 | 它的实现代码（除下面两个文件） |
| 整棵树（1905 个文件 / 1744 非二进制） | `lib/domain/` 下 227 个模块里的其余 225 个 |
| `lib/domain/context-planner.js`（11KB）全文 | 它的测试与 `testsets/` |
| `prompts/candidate-story.md` 全文 | `dsh-tavern-runtime.json`（148KB） |

**所以下面凡是我推断的，都标了「推断」。** 只凭目录名猜架构很容易猜歪。

## 二、它的形状

- `tavern-plugin/lib/domain/` —— **227 个单概念模块**。名字本身就是设计图：
  `context-planner` · `compaction-{auto,foreground,background,bounded,failure,request}` ·
  `background-agent-{runner,sessions,task}` · `durable-task-mailbox` ·
  `candidate-{generation,selection,tasks,script-context}` ·
  `conversation-fork` / `conversation-fork-point` ·
  `mvu-background-settlement`（32KB，最大的一个）· **`failed-error-visibility`**
- `prompts/` —— prompt **按用途拆成 .md 文件**（`story.md` / `candidate-story.md` /
  `card-workspace.md` / `scene-plan.md` / `story-compaction.md` …），不是拼在代码里
- `packages/` —— 工作区里还挂着别的插件（`dsh-image-gen` 独立可装、`dsh-tavern-remote` 手机端）
- `CONTEXT.md` + `DESIGN.md` —— 分别给 agent 和人看的项目说明（DESIGN 是视觉设计系统）

## 三、从 context-planner 学到的（这三条能直接用）

### 1. 上下文按 **purpose** 规划，稳定前缀是**显式建模的一种用途**

`createContextPlanner({ prompt }).plan(input)` 里有 `input.purpose`，目前看到三种：

- **`play-card-snapshot`** —— 产出的就是**游戏会话的稳定前缀**：
  人物卡基础信息 + 常驻世界书，**故意不含** instructions / guides / posture
- **`body`** —— 每轮正文：`story` 底子 + 卡上的指令段 + 本轮剧本参考
- **`candidate`** —— 候选项那一轮

同一批段落在两种用途下**顺序不同**（`stableFirst` 开关）：稳定优先 vs 动态优先。

> 对表：我们做的是**一个** `buildGenerationInput` 带一堆 flag，
> 前缀与尾部靠"会不会变"现场分拣。我们的分拣原则是对的，
> 但**没有把"稳定前缀"提升为一个有名字的用途**——所以它没有自己的快照、
> 没有自己的失效条件、也没法单独测。

### 2. prompt 构建**返回审计**，而且"被砍掉的"要写理由

```js
audit: {
  included: [{ kind, chars, required }],   // 谁进了，多大，是不是必需
  omitted:  [{ kind, reason }],            // 谁被留下，为什么
  warnings: [...],
  totalChars
}
```

它有一条 `omitted` 的理由写得非常直白：
`'人物卡基本信息和常驻世界书已固定在游戏会话稳定前缀'`。

> 对表：我有 `prompt-preview` 端点，但它给的是**拼好的文本**，不是**账**。
> 人眼看文本对不出"该进没进"和"不该进进了"。这个 `included/omitted` 的形状
> 该照搬进我们的 preview 返回体——**验收看账，不看正文。**

段落还带 `kind` 与 `required` 两个标签，**每个段落都被单独投影**
（`projectAgentContent(text, {charName, macroState})`），宏状态在段落间**串行传递**，
投影结果带 `warnings`。

> 对表：我们的宏是在**卡字段**与**消息**两个位置分别结算的，没有"段落级投影 +
> 宏状态串行传递"这一层。今天的 `delta/chunk` 事故说明：**没被建模的那一层就是塌方的地方。**

### 3. 候选项用**工具调用**提交结构，不是让模型吐 JSON

`prompts/candidate-story.md` 全文（很短，值得逐字看）：

> 你是剧情候选项生成器。必须调用 `candidate_submit_choices` 提交结果：
> actions 恰好包含 4 个各有侧重、彼此不重复且倾向各异的人物行为，
> scene 包含 1 个场景变化。建议每项约 40 字。
> **不得输出 JSON 或把其他工具调用写成普通文字。**
>
> 结合当前正文分析剧情走向，给出具有剧情意义的候选项，并自然承接上一段正文。
> 候选项应充分考虑正文已发生内容，不得产生逻辑冲突，且不得重复之前正文的剧情。

四个细节都是血：**结构靠工具 schema 保证**、**数量与差异度写进 prompt**、
**长度给数**、以及**明确禁止"把工具调用当文本吐出来"**（模型最经典的失效模式之一）。

> 对表：我 backlog 里的「建议行动端点」应该按这个形状做——
> 独立一次调用 + 工具契约 + 结果**不进正文 prompt**（不进正文 = 不伤前缀）。

## 四、推断（标出来，别当事实）

- **后台任务是它那两个数字的原因**（README 称缓存命中 95%+、184 轮 99%）。
  推断依据：`background-agent-runner/sessions/task` + `durable-task-mailbox` +
  `background-task-coordinator` + `mvu-background-settlement` 这一整套在，
  而 README 明说"候选项和后台状态维护分开处理，减少正文的格式负担"。
  **机制它一个字没写**，我不替它下结论。
- `compaction` 那 6 个文件指向"上下文压力到达阈值时的压缩/退休策略"。
  我没有对应子系统，这一条是**空白**，不是差距。
- `conversation-fork-point` 说明回退建模成分叉；`conversation-fork.js` 会在分叉时
  决定"哪些状态跟着走"。README 里"撤销回退，但开始新生成或编辑后恢复点失效"
  这条规则，是分叉模型的自然结果——**不是补丁**。

## 五、不抄码声明

两边都是 AGPL-3.0，读它合法。但这里的规矩不变：**只学设计，不搬代码**。
真要用到具体写法，标注来源文件与项目地址。

## 六、落地的顺序（可执行，按性价比排）

1. **`prompt-preview` 返回体加 `included` / `omitted` / `warnings` / `totalChars`**，
   段落带 `kind` + `required`，`omitted` 必须写理由 —— 小改动，立刻让"该进没进"看得见
2. **把"稳定前缀"提成一个有名字的用途**（快照），它有自己的构建、失效条件与测试
3. **建议行动端点**：独立一次调用 + 工具契约提交 + 结果不进正文 prompt
4. **变量 diff 显示**：本轮变量变化在正文下方列出来（对应它的"正文下方可查看本轮更新结果"）
5. **空白项（不是差距）：上下文压力与压缩** —— 还没有对应子系统，先记账不动手
