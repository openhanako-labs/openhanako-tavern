# 自动创建角色卡与世界书 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `productivity` 的 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。每个任务完成后 commit，commit message 引用任务编号。
>
> **规格：** `docs/superpowers/specs/2026-09-25-auto-create-card-book-design.md`（已获用户批准）。规格与本计划冲突时，以规格为准并回头改本计划。

**目标：** 用户在酒馆里说一句「我要一个 X」，App 联网检索**可信来源** → 用 AI 生成**符合原酒馆格式**的角色卡 + 世界书（成套）→ 用户逐条审查后入库。

**架构：** 检索（两个来源适配器，走 `sdk.network.fetch`）→ 抽取事实清单（模型调用一，每条事实挂出处）→ 组装（模型调用二，喂**清单**不喂原文）→ 出处核对（删掉挂不上出处的断言并计数）→ 前端三段式审查界面 → 走现成的 `lib/characters/formats.js` 落库。长任务用提交 + 轮询，不新增宿主能力。

**技术栈：** 纯 Node ESM（无框架）、Hono 风格路由 shim（`lib/respond.js` 的 `route()`）、`lib/llm/service.js` 做模型调用、原酒馆 V2 卡格式（`spec: "chara_card_v2"` + `character_book`）。

---

## 已探明的外部事实（不要再重查）

| 事实 | 证据（2026-09-25 实测） |
|---|---|
| 萌娘百科 **API 关闭** | `GET https://zh.moegirl.org.cn/api.php?action=query&list=search…` → 200 但 `{"error":{"code":"action-notallowed","info":"Unauthorized API call"}}` |
| 萌娘百科 **搜索页可用** | `GET https://zh.moegirl.org.cn/index.php?search=初音未来&fulltext=1` → 200，HTML 里结果条链为 `/<条目名>`（URL 编码） |
| 萌娘百科 **条目页可用** | `GET https://zh.moegirl.org.cn/初音未来` → 200，服务端渲染 HTML（`mw-parser-output` 在） |
| arXiv **API 可用** | `GET http://export.arxiv.org/api/query?search_query=all:electron&max_results=1` → 200 atom XML |
| 维基百科 / Fandom **本机不通** | 连接超时（无代理）→ 不入白名单 |
| 灰机 wiki **403** | 换完整浏览器头复测仍 403 → 不入白名单 |
| 出网必须走宿主 | `globalThis.fetch` 在 AppHost 子进程被 Node 权限模型拒（`ERR_ACCESS_DENIED`）。正门是 `sdk.network.fetch(url, init)` |

**用户会对白名单扩容做一次权限复核**（manifest 的 `network.allowedHosts` 变更被宿主判为「新增权限」）。这是一次性动作，不是 bug。

---

## 文件结构（先锁定职责，再拆任务）

**新增（服务端）**

| 文件 | 职责 |
|---|---|
| `lib/gen/text.js` | HTML → 纯文本；XML/atom → 条目数组。纯函数，无网络 |
| `lib/gen/sources/moegirl.js` | 萌娘适配器：`search(q)`、`fetchPage(url)`，返回 `{url,title,text}` |
| `lib/gen/sources/arxiv.js` | arXiv 适配器：`search(q)` 返回 `{url,title,text(summary)}` |
| `lib/gen/sources/index.js` | 来源注册表 + `checkAvailability(net)`（逐个源打一次，报通/不通） |
| `lib/gen/prompt.js` | 两个调用的提示词构造 + 严格 JSON 解析（失败说清哪一条不合法，不重试） |
| `lib/gen/extract.js` | 调用一：正文 → 事实清单 `[{fact, source{url,title,tier}}]`；挂不上出处的丢弃 |
| `lib/gen/compose.js` | 调用二：事实清单 → `{card, book}`；字段白名单；只喂清单 |
| `lib/gen/verify.js` | 出处核对：清单外的断言删掉并计数；纯函数 |
| `lib/gen/job.js` | 任务存储：`create/get/update`，状态 `running|done|failed` + 阶段 + 进度 |
| `lib/gen/routes.js` | `GET /gen/sources`、`POST /gen/jobs`、`GET /gen/jobs/:id` |
| `lib/gen/tool.js` | 给 Agent 的工具 `tavern_draft_card`：收**已检索好的材料**→ 生成（兜底那条路） |

**新增（前端）**

| 文件 | 职责 |
|---|---|
| `ui/assets/modules/gen.js` | 生成台：提交、轮询、三段式展示、逐条留/删/改、落库 |
| `ui/characters.html` | 加 `#gen-modal`（三段式 + 结果列表）与入口按钮 |
| `ui/assets/characters.css` | `.gen-*` 样式（复用 `.import-item` 的观感） |

**修改**

| 文件 | 改动 |
|---|---|
| `manifest.json` | `network.allowedHosts` 加 `zh.moegirl.org.cn`、`export.arxiv.org` |
| `lib/characters/routes.js` | 复用现成的 `POST /characters`（`body.card` 直通 `repo.create`），无需改 |
| `test/check-route-order.mjs` 等 | 路由数变化后同步断言 |

**测试**

| 文件 | 覆盖 |
|---|---|
| `test/regression-gen-text.mjs` | HTML→文本、atom→条目（喂真片段，不联网） |
| `test/regression-gen-verify.mjs` | 出处核对：越界断言被删并计数 |
| `test/regression-gen-compose.mjs` | 组装：字段白名单、坏 JSON 报哪一条 |
| `test/regression-gen-routes.mjs` | 路由契约（route-harness）：提交/轮询/来源体检 |
| `test/check-gen-wiring.mjs` | 前端 id 与 JS 引用一致（gen.js 里建的 element，HTML 里必须有） |

---

## 任务

### 任务 1：出网白名单扩容

- [ ] 改 `manifest.json` 的 `network.allowedHosts`：加 `zh.moegirl.org.cn`、`export.arxiv.org`
- [ ] `network.methods` 保持 `["GET","POST"]`（两个源都只用 GET）
- [ ] 跑 `node test/check-host-refs.mjs`（应有白名单相关断言）
- [ ] **验证：** 重载 App 时宿主报「需要复核新增权限」——把原文抄进 commit message（这是预期行为，不是故障）
- [ ] commit：`feat(gen): 出网白名单加两个来源`

### 任务 2：HTML→文本（纯函数，先写测试）

- [ ] `test/regression-gen-text.mjs`：
  - 去掉 `<script>` / `<style>` 内容
  - 去掉标签、解 HTML 实体（`&amp;` → `&`、`&nbsp;` → 空格）
  - 压缩连续空白；超长截断到给定上限
  - 从萌娘搜索页抠条目链：`/<条目名>`，排除 `Special:`、`index.php?`、`Help:`、命名空间前缀
- [ ] 跑测试确认**红**
- [ ] `lib/gen/text.js` 实现 `htmlToText(html, {max})` 与 `parseSearchLinks(html)`
- [ ] 跑测试确认绿
- [ ] commit：`feat(gen): HTML→文本与搜索结果解析（任务2）`

### 任务 3：atom→条目（纯函数）

- [ ] `test/regression-gen-text.mjs` 增加 atom 用例：从 `<entry>` 抠 `title` / `link href` / `summary`
- [ ] 跑测试确认红
- [ ] 在 `lib/gen/text.js` 实现 `parseAtom(xml)`
- [ ] 跑测试确认绿
- [ ] commit：`feat(gen): atom 解析（任务3）`

### 任务 4：两个来源适配器

- [ ] `lib/gen/sources/moegirl.js`：
  - `search(q, {net})` → 打 `https://zh.moegirl.org.cn/index.php?search=<q>&fulltext=1`（**必须带 UA**，否则可能被拒）
  - 取前 N 条链接 → `fetchPage(url, {net})` → `{url, title, text}`（`htmlToText`，上限 6000 字）
- [ ] `lib/gen/sources/arxiv.js`：
  - `search(q, {net})` → 打 `https://export.arxiv.org/api/query?search_query=all:<q>&max_results=5`
  - `parseAtom` → 每条的 summary 当正文（上限 4000 字）
- [ ] 两个适配器的 `net` 参数与 `lib/embed/service.js` 同款：`const doFetch = net?.fetch ? net.fetch.bind(net) : null`；**没有 net 就报「出网未就绪」，不要回退到 globalThis.fetch**
- [ ] 单测：喂假 `net`（记录调用 URL 的桩），断言 URL 形状与 UA 存在
- [ ] commit：`feat(gen): 萌娘 / arXiv 来源适配器（任务4）`

### 任务 5：来源体检

- [ ] `lib/gen/sources/index.js` 导出 `SOURCES` 与 `checkAvailability(net)`
- [ ] 实现：逐个源发一次最小请求，返回 `[{id,label,tier,ok,ms,note}]`；单个失败不影响其余
- [ ] 单测：桩里让一个源超时、一个 200，断言两者都出现在结果里且 `ok` 分别 false/true
- [ ] commit：`feat(gen): 来源可用性体检（任务5）`

### 任务 6：提示词与严格 JSON 解析

- [ ] `lib/gen/prompt.js`：
  - `extractPrompt({query, docs})`：只许抽取、不许新增；每条事实必须挂 source；挂不上就丢
  - `composePrompt({query, facts})`：只喂清单；字段白名单（`name/description/personality/scenario/first_mes/mes_example/creator_notes/tags` + `character_book`)
  - `parseJsonStrict(text, {expect})`：剥 ```json 围栏；解析失败抛「第 N 条不合法：…」，**不重试**
- [ ] 单测：喂各种坏形状（缺字段、数组里混进字符串、围栏不闭合），断言错误话指明位置
- [ ] commit：`feat(gen): 提示词与严格 JSON 解析（任务6）`

### 任务 7：抽取（模型调用一）

- [ ] `lib/gen/extract.js`：`extractFacts({query, docs, llm, net})`
- [ ] 事实清单形状校验：`{fact, source:{url,title,tier}}`，`tier ∈ encyclopedia|official|community`
- [ ] 挂不上出处的条目**丢弃**（fail closed）
- [ ] 单测：桩 llm 返回一条没 source 的 → 断言被丢且计数
- [ ] commit：`feat(gen): 事实抽取（任务7）`

### 任务 8：组装 + 出处核对（模型调用二 + 第三道）

- [ ] `lib/gen/compose.js`：`compose({query, facts, llm})` → `{card, book}`
- [ ] `lib/gen/verify.js`：`verifyProvenance({card, book, facts})` → 删掉清单里找不到的断言，返回 `{card, book, dropped: [...]}`
- [ ] 单测（先红）：
  - 卡里写了一条事实清单没有的断言 → 被删且进 `dropped`
  - 世界书条目 keys 为空 → 丢掉该条
  - `dropped` 有内容时，报告里能看到条数
- [ ] commit：`feat(gen): 组装与出处核对（任务8）`

### 任务 9：任务存储（提交 + 轮询）

- [ ] `lib/gen/job.js`：内存 Map（进程内即可，不落盘）；`create/get/list`；阶段 `searching|extracting|composing|verifying|done|failed`
- [ ] 进度字段：`{phase, detail, counts}`；失败带 `error` 与卡住的阶段
- [ ] 单测：状态机迁移、未知 id 返回 null
- [ ] commit：`feat(gen): 生成任务存储（任务9）`

### 任务 10：路由三条

- [ ] `GET /gen/sources` → 体检结果
- [ ] `POST /gen/jobs` → `{query, sources?, makeBook?}` → 立即返回 `{id}`，后台跑
- [ ] `GET /gen/jobs/:id` → 任务快照（含结果）
- [ ] `test/regression-gen-routes.mjs`（用 `test/lib/route-harness.mjs`）：
  - 三条路由都注册（`app.routes` 断言）
  - 提交 → 轮询拿到 `running` → 桩流程跑完 → `done` 且结果里有卡与世界书
  - 未知 id → 404
- [ ] 更新 `test/check-route-order.mjs` 的路由数断言
- [ ] commit：`feat(gen): 生成路由（任务10）`

### 任务 11：前端生成台（显示）

- [ ] `ui/characters.html`：加 `#gen-modal`（需求 / 过程 / 结果 三段）+ 角色页「AI 生成」入口（放在"新建"旁）
- [ ] `ui/assets/modules/gen.js`：提交 → 轮询（1s 间隔）→ 渲染三段
- [ ] 结果区：角色卡预览（名字/描述/开场白）+ 世界书条目列表（逐条带 checkbox）
- [ ] `test/check-gen-wiring.mjs`：gen.js 里 `document.getElementById("x")` 的每个 id 必须存在于 HTML
- [ ] commit：`feat(gen): 生成台界面（任务11）`

### 任务 12：前端生成台（交互）

- [ ] 「越界内容」**不进审查列表**（用户明确）：只在过程区显示「删除 N 条无出处内容」
- [ ] 每条事实/条目旁挂来源（域名 + 可点开的 URL）
- [ ] 逐条可取消勾选；底部「写进卡库 / 存草稿 / 丢掉」
- [ ] `tools/flows/gen.js` 探针：走一遍真流程（假来源），断言 DOM 里出现三段与来源链接
- [ ] commit：`feat(gen): 生成台交互与来源展示（任务12）`

### 任务 13：落库

- [ ] 「写进卡库」→ `POST /characters`（`{card: {...}}`）+ 世界书条目 `POST /settings`
- [ ] 断言：入库后 `GET /characters` 能看到，且 `has_book` 为真（接缝 A 那个字段）
- [ ] 端到端：探针跑通「生成 → 审查 → 入库 → 左栏出现这张卡」
- [ ] commit：`feat(gen): 生成结果落库（任务13）`

### 任务 14：Agent 兜底工具

- [ ] `lib/gen/tool.js`：`tavern_draft_card({query, material})` —— 收**已检索好的材料**（白名单装不下的题材由 Agent 先查）→ 直接跑调用二
- [ ] 注册进 `index.js` 的工具表；`test/check-server-exports.mjs` 通过
- [ ] commit：`feat(gen): Agent 兜底工具（任务14）`

### 任务 15：收尾

- [ ] 全套测试绿（`Get-ChildItem test -Filter *.mjs | Where-Object { $_.Name -match '^(regression|check)' }`）
- [ ] 把 4 条新纪律（检查器盲区登记、跨侧契约判据、读函数体、零命中先怀疑搜法）现状同步进 `W:\Games\Hanako\Work\通用\助手\SKILL.md`（若本计划又踩到新坑，一并补）
- [ ] 写日记：`W:\Games\Obsidian\Work\无极限\03-日记\开发\2026-09-25-自动生成卡与世界书.md`
- [ ] commit：`docs(gen): 实现完成（任务15）`

---

## 风险与取舍

| 风险 | 处置 |
|---|---|
| 萌娘 HTML 结构变动 → 解析失效 | `parseSearchLinks` 只依赖 `title=` 与 `href`，不吃 class 名；坏形状由单测固定成"返回空数组"而不是崩 |
| 白名单只剩 2 个源，覆盖窄 | 规格已写明：历史/地理/真实人物走 Agent 兜底（任务 14）。不假装能搜全网 |
| 模型把清单里的内容改写走样 | 出处核对照原清单比字符串，宽松匹配（去空白/标点后包含），宁可少删不可错删；计数进报告 |
| 长任务卡住 | 每个阶段写 `job` 进度；前端显示当前阶段；超时给明确话 |
| manifest 扩容触发权限复核 | 预期行为，写进任务 1 的验证步骤 |

## 开工前要确认的一件事

白名单扩容会让宿主弹一次权限复核（需要用户点确认）。若用户不方便当场点，任务 2–9（纯函数 + 桩）不受影响，可以先全做完再装回。
