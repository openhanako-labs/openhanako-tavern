# ElecKoi Tavern · 场景插图与图片归档 · 实施计划

> 写于 2026-09-25 · 奥菲莉娅 · 给"开新会话执行"用
> 状态：**待批**（未开工）。四个关键决定已给出默认值，开工前可改。

---

## 一、这份文档要解决的三件事

1. **头像看得清**（今天报的两个小毛病）：点头像不能放大 ✗；左栏角色行没有缩略图 ✗。
2. **按情节生图**（新功能）：每次回复之后，按剧情画一张插图。
3. **图片归档**（月曦夜的想法）：把 App 生成的图**记录路径**，交给图库 App 读取并分类保存。

第 1 件是收尾，2 与 3 是新线。**3 依赖 2，2 不依赖 3**——所以顺序是 1 → 2 → 3。

---

## 二、现状（执行前先复核，别从记忆里抄）

**已验证的链路**（今天真机跑通，别再重查弯路）：

```
出图：sdk.media.generateImage({ scope:"app", input:{ prompt, delivery:{mode:"response"} } })
      → 返回值形状：{ ok:true, kind:"image", batchId, prompt }   ← 没有 files / sessionFiles / taskId
batchId → sdk.media.listTasks({ batchId, scope:"own" }) → 最新 taskId
taskId  → sdk.media.getTaskResources(taskId) → { kind:"local-file", path }
        → ctx.resources.read({ kind:"local-file", path }) → 字节     ← 关键：ResourceIO
        （第二条正路：getTask(taskId).sessionFiles[].fileId + task.sessionId）
产物异步写完 → 必须轮询（宿主原话：Media task output is not complete）
```

代码落点：
- `lib/media/bytes.js`——`readProductBytes(sdk, res, opts)` 把上面这套顺序封装好了，**新功能直接复用，不要重写**。
- `lib/media/service.js`——`generateImageRaw(sdk, opts)` 只出图不管形状；`generateImage` 额外要求一个路径（老调用方用）。
- `lib/media/prompt.js`——`portraitPrompt(card, {extra, style})`，只吃卡里已有字段，不编外貌。

**图片现在都落在哪**：
- 角色头像：`<ctx.dataDir>/characters/<characterId>/avatar.png`（App 自己写）
- 出图原图：`W:\Games\Hanako\.hanako\plugin-data\image-gen\generated\portrait-<卡名>-<hash>.png`（宿主图像插件写）
- 这两处的**具体文件**今天都验证过存在、是真 PNG。

**已知的坑（写进纪律了，执行时别踩第二遍）**：
- App 只能碰 `ctx.dataDir` 里的东西——裸 `fs` 读外部路径会 `ERR_ACCESS_DENIED`，要走 ResourceIO。
- `<img src="…/characters/<id>/avatar">` 在真机会 **403**（URL 里没有 `/_surface/<票据>/` 段，`<img>` 不会自己带鉴权）。头像现在走 `GET /characters/:id/avatar.json`（base64）这条通路。
- 工具注册对象必须写 `execute` 与 `parameters` 两个键名；`test/check-tool-registrations.mjs` 会拦。
- 改 SKILL.md 不许用 PowerShell `Set-Content`（BOM）。

---

## 三、四个关键决定（默认值已给，开工前确认或改）

| # | 决定 | 默认取法 | 代价 |
|---|---|---|---|
| D1 | 什么时候画 | **场景切换时画**：由模型在回复末尾输出一个可选的 `[场景]` 标记（一行画面描述），有标记才画；不做"每条回复都画" | 需要一次额外的规约提示，但省掉大量废图 |
| D2 | 谁决定画什么 | **模型给画面描述**，App 只做校验（长度、是否含真人/版权名） | 要防它编；校验规则要写清 |
| D3 | 画到哪 | **落成对话里的一条插图消息**（新 role: `illustration`），点开可看大图；文件留在 `dataDir/media/` | 要动消息模型 + 渲染 |
| D4 | 一致性 | **用该角色的立绘当参考图**（图生图/参考图），没有立绘时退化为纯文生图并**在界面标注** | 依赖出图引擎支不支持参考图；本机 ComfyUI 那条要注意工作流 |

**不做**（这一版明确排除）：视频、放大/超分、批量预生成、角色多套服装。

---

## 四、任务分解（2–5 分钟粒度，逐条可验）

### 第 0 批 · 收尾今天报的两个小毛病（约 40 分钟）

- [x] 0.1 `ui/assets/modules/characters.js`：头像 `<img>` 加点击 → 打开一个轻量看图浮层（复用现有 modal 样式；Esc / 点背景关闭）。
- [x] 0.2 左栏角色行加缩略图：`ui/assets/modules/shell.js`（或角色列表渲染处）在行首放 20×20 圆角图，走同一条 `apiAvatarBlobUrl(id)`；失败退回首字母。
- [x] 0.3 两条都要有测试：`test/check-dom-refs.mjs` 覆盖新元素 id；`test/regression-avatar-url.mjs` 断言"界面上不再出现裸 `<img src>` 指向 App 路由"。
- [x] 0.4 真机验：面板点开能放大、左栏能看到缩略图。

### 第 1 批 · 图片台账（约 1 小时）

> 这是第 3 件事的地基，先做它，后面图库只是读台账。

- [x] 1.1 新增 `lib/media/index-store.js`：`<dataDir>/media-index.json`，每条记
      `{ id, kind, characterId, conversationId, messageId, file, bytes, prompt, taskId, scene, createdAt }`。
      写入必须**原子**（复用 `lib/atomic.js`），读损坏时要能自愈（丢一条不丢全表）。
- [x] 1.2 出图成功后（`tavern_generate_portrait` 与将来的场景插图）都往台账写一条。
- [x] 1.3 `GET /media/index` 与 `GET /media/index/:id`（后者回 base64，给界面显示用）。
- [x] 1.4 `test/regression-media-index.mjs`：新增/读回/损坏自愈/重复 id 覆盖，4 条。
- [x] 1.5 纪律：台账里的 `file` 只存**绝对路径**（相对路径无从追溯，BUG-059 同源）。

### 第 2 批 · 场景插图（约 4–6 小时，主线）

- [x] 2.1 规格先落文档：`docs/spec-scene-illustration.md`——`[场景]` 标记的语法、出现在哪、被谁消费、模型漏写时怎么办、写错时怎么办。
- [x] 2.2 `lib/illustration/scene-marker.js`：从回复正文里**抽取**标记（纯函数，含：无标记、多标记、标记里带换行、标记里有 `{{char}}` 宏 四种用例）。
- [x] 2.3 `lib/illustration/prompt.js`：把"卡里已有字段 + 场景描述 + 说话人"拼成出图提示词。**不编外貌**（沿用 `portraitPrompt` 的纪律）。
- [x] 2.4 `lib/conversations/model.js`：消息新 kind `illustration`（`{ kind:"illustration", mediaId, prompt, status }`）；**旧消息读进来要照常工作**（迁移兼容）。
- [x] 2.5 `lib/illustration/service.js`：拿到标记 → 出图（复用 `generateImageRaw` + `readProductBytes`）→ 落文件到 `<dataDir>/media/` → 写台账 → 回写消息的 `mediaId` + `status`。
- [x] 2.6 `lib/illustration/routes.js`：`POST /conversations/:id/illustrate`（手动补一张）、`GET /media/:id`（取图，base64）。
- [x] 2.7 `ui/assets/modules/chat.js`：插图消息的渲染（缩略图 + 点开放大 + 生成中/失败三态）；失败要说出原因，不许静默。
- [x] 2.8 设置项：`scene.enabled`（默认关）、`scene.mode`（`marker` | `off`）、`scene.characterRef`（默认开）。默认关——**别替用户决定花钱**。
- [x] 2.9 测试：`regression-scene-marker.mjs`(≥6) / `regression-scene-prompt.mjs`(≥4) / `regression-scene-flow.mjs`(≥5，用假 sdk)。
- [ ] 2.10 真机验：开设置 → 发一条带 `[场景]` 的消息 → 出现一张插图 → 点开能放大。

### 第 3 批 · 接到图库（约 2 小时）

- [x] 3.1 **先侦察，别先写**：读 `hanako-gallery` 的工具与能力（`gallery_push` 的参数语义、它监视哪些目录、分类是目录级还是标签级、能否自定义目标）。
      —— 这一步的产出是一段结论，不是代码。
- [x] 3.2 按侦察结果二选一：
      **(a) 推**：出图后把文件复制到图库监视的目录（`gallery_push` 或直接复制）。
      **(b) 报**：App 只维护台账 + 暴露 `GET /media/index`，图库那边加一个读台账的来源。
      **优先 (b)**——单向、无侵入、图库不用改；只有在图库完全不支持外部来源时才走 (a)。

      > ⚠ **2026-09-27 侦察已定：走 (a)，但形态是「插图落盘到 `app-data/eleckoi-tavern/generated/`」，
      > 不是调推送接口。图库自动扫盘发现，零图库侧改动。详见 `docs/notes-gallery-intake.md`。
      > 原默认的 (b) 已被推翻——图库没有「读外部清单」的口子，加一个会把台账 schema 绑死。**
- [x] 3.3 分类键定死：`kind`（立绘 / 场景）/ `characterId` / `conversationId` / 日期。写进 spec。
      —— 落在 `docs/spec-scene-illustration.md` §6.1（表格），
         并写清「立绘没有 conversationId」这条不对称是设计。
- [x] 3.4 去重：同一个 `mediaId` 不重复归档；重复推送要幂等。
      —— App 侧不做归档也不推送（见 3.2 的侦察结论），所以这一条
         拆成两层写在 §6.3：台账内 insert/upsert，图库内按文件字节 hash。
- [x] 3.5 测试：台账 → 归档清单的纯函数测试（≥4）。
      —— 「归档清单纯函数」已不存在（改为图库自己扫盘），
         换成两个真契约的测试：
         `test/regression-gallery-query.mjs`（13 条，两级查询 + 空态 + 计数，含反证）
         `test/regression-gallery-drawer.mjs`（45 条，入口→抽屉→dom→shell→模块→CSS 全链）
- [x] 3.6 真机验：图库里能找到今天的薇拉立绘，并且能按分类筛出来。

---

## 五、验收判据（这几条不满足就是没做完）

1. 面板点头像 → 能看大图；左栏每张卡有缩略图（无头像时是首字母，不是裂图）。
2. 关掉场景插图时，行为与今天完全一致（**默认关闭是硬要求**）。
3. 开启后：模型给标记 → 出图 → 插图出现在对话里；模型不给标记 → 什么都不发生，不报错。
4. 出图失败 → 消息里写明失败原因（不是一句"生成失败"，要带宿主原话）。
5. `media-index.json` 里的 `file` 全是绝对路径；删掉文件后索引能自愈，不连带整表损坏。
6. 全套测试绿（当前 70 个文件），新增测试**自带反证**（改坏必须红）。
7. 图库那边能读到今天的薇拉立绘并按分类筛出——这一条由月曦夜本人确认，不由我判绿。

---

## 六、调度（按调度中心）

| 批次 | 谁做 | 为什么 |
|---|---|---|
| 第 0 批 | 奥菲莉娅 | 纯 UI 收尾，我自己欠的账 |
| 第 1 批 | 奥菲莉娅 | 后端契约与原子写，与现有 media 层同一套纪律 |
| 第 2 批 2.1–2.4 | 奥菲莉娅 | 规格与数据模型，做错代价最大 |
| 第 2 批 2.5–2.10 | 奥菲莉娅 + 可派 `kurisu` 复核 | 流程与边界条件多，值得一个"冷眼"复核 |
| 第 3 批 3.1 | 派 `rebecca`（只读侦察） | 她的长处是"在计划书之外找一条能走通的路"，适合摸清图库底细 |
| 第 3 批 3.2–3.6 | 奥菲莉娅 | 落地 |
| 全程 | `glados` 可做记录归档 | 多会话交接时它能守住上下文 |

派活原则：**只读侦察可以并行**；写代码同一文件同一时间只有一个执行者。

---

## 六点五、状态复核（2026-09-27）

> 刷这份勾的时候发现：**这些框一直没人维护**（第 0、1 批早做完了还空着，
> 而下面几条又早就不成立了）。所以顺手复核了一遗，写清楚每一条为什么是这个状态。
> **后续纪律：活落地就把框划掉；划不了的在框旁写一句为什么。**

### 已划（有证据）

0.1–0.4、1.1–1.5、2.1–2.9、3.1、3.2、3.6。

### 2.7 曾经只做了一半（今天才补全）

框里写的是「缩略图 + 点开放大 + 生成中/失败三态」，而今天查出来：

- **`.illus-*` 那一套一行 CSS 都没有**——JS 里类名齐全，样式零，图按原始尺寸糊满气泡
- **“点开放大”只绑了头像**，插图没绑——画出来了却点不开

三态的结构当时是有的，所以很容易看着像做完了。两条今天已补，并在
`test/check-scene-entry.mjs` 里钉住（「JS 里有类名」不等于「有人给它们写过样式」）。

### 2.10 没划：自动那条不该现在跑

- **手动那条已真机验过**（2026-09-27，真出图两张，含参考图通路，见日记）
- **自动那条未验，而且现在跑也证明不了什么**：App **从不告诉模型要写 `[场景]`**——
  spec §4 把「模型漏写」定成了“不救”，但正文里写着“提示词**约束**模型是建议”，
  而代码里那句约束**不存在**。所以 `mode=marker` 对普通用户等于永不触发，
  而设置面板写着「模型写 `[场景]` 时自动出图」，读起来像它自己会。

**这是个待定的设计口，不是 bug**：要么在 `mode=marker` 时注入一句指令（改提示词），
要么在面板上说清“得自己在预设里写”。**两条都会改行为/文案，等你定。**

### 3.3 / 3.4 / 3.5 没划

~~3.2 改道后（图库自己扫盘，App 不做归档清单也不推送）这三条的对象变了：~~
**2026-09-28 已划。** 对象确实变了，但三条各自都还有真实的落点：

- **3.3** → §6.1 的分类键表。四条键（kind / characterId / conversationId / createdAt）
  就是两级筛选的全部依据，已在 index-store 的 schema 里定死，spec 补上图。
- **3.4** → §6.3 拆成两层：台账内 insert/upsert（App 侧），图库内文件字节 hash（图库侧）。
- **3.5** → 「归档清单纯函数」这个对象**不存在了**（改成图库自己扫盘），
  换成两个真契约的测试：两级查询 + 空态文案 + 计数（13 条），
  以及整条接线的 source-level 测试（45 条）。

## 七、风险与未决

- **R1 参考图支持未知**：D4 依赖出图引擎收不收参考图。本机 ComfyUI 那条要先确认工作流里哪个节点吃图；宿主引擎那条要先确认协议支不支持。
- **R2 模型不肯给标记**：靠提示词约束，天然不可靠 → 所以默认关 + 手动补一张（2.6）是必需的兜底。
- **R3 成本**：每条回复都画会烧钱烧显存。这是"默认关"的真正理由，不是洁癖。
- **R4 图库能力未核实**：3.1 的侦察结论可能推翻 3.2 的选型。**不要先写代码。**
- **未决**：插图要不要参与上下文（下一条回复能否"看见"上一张图）——这一版**不参与**，但要在 spec 里留一句话，免得以后当成 bug。

---

## 八、开新会话时的第一句话（给未来的自己）

> 读 `docs/plans/2026-09-25-scene-illustration-and-gallery.md`，从第 0 批开始。
> 先跑 `node test/regression-routes-smoke.mjs` 和全套确认起点是绿的（当前 70 个文件），
> 再复核第三节的四个决定有没有被改过。改代码不许用 PowerShell 写文件。
