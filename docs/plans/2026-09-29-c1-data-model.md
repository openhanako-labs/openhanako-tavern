# C1 图鉴 · 数据模型一页纸

- 日期：2026-09-29
- 作者：奥菲莉娅
- 状态：**待月曦夜过目**，过目后瑞贝卡动工
- 上游：`2026-09-29-airp-intake.md`（C 线；关系边已定：独立表）

---

## 〇、这张纸管什么

C1「图鉴」的数据形状：人物、地点、关系、力量体系，四张表。
**不管**：UI 长什么样（动工前另出一页交互稿）、自动抽取的提示词（那是 C1 二期）。

## 一、总原则（与仓库现有约定对齐）

1. **照旧三件套**：每张表 = `lib/codex/{model, repo, routes}.js`，
   落盘走 `atomic.js` 的 `mutateJson`（board / memory / models 都是这个写法）。
2. **读侧 normalize，不写迁移**：老文件没有字段也能读，盘上文件不被读操作改写。
3. **寿命两级**：世界级（`<dataDir>/codex/*.json`，跨对话共享——世界是同一部）
   + 对话级（挂在对话文件上，比如「这一场才认识的酒馆老板」）。
   与 board 的两盘设计同构。
4. **图鉴 ≠ 角色卡**：`lib/characters/` 是「能上场扮演的卡」（ST 兼容）；
   图鉴人物是「世界里存在的人」（NPC、提及的势力成员）。
   两者之间只存**引用**（`characterId` 可空），不互相嵌套——卡会被换，世界不会。

## 二、四张表

### 1. `persons` 人物图鉴（对齐 AIRP 图 05：态度/关系/状态/记录）

```jsonc
{
  "id": "p_xxx",
  "name": "李明玥",
  "aliases": ["相女"],                 // 称呼会变，名字是锚
  "characterId": null,                  // 若此人同时是可扮演的卡 → 引用 characters.id
  "firstMet": { "convId": "…", "at": "2026-09-29T…" },
  "attitude": "戒备",                   // 对玩家/主角的态度，一词
  "status": "禁足中",                   // 当前状态，一句
  "affinity": 35,                       // 好感度 -100~100，可空（未知就是未知，不编 0）
  "tags": ["皇室", "将门"],
  "notes": [                            // 「记录」：追加制，不覆写
    { "at": "…", "convId": "…", "text": "中秋宴上替主角解了围" }
  ],
  "updatedAt": "…"
}
```

要点：`notes` 是**追加制**——图鉴的价值在时间纵深，覆写等于失忆。
`affinity` 允许 `null`：AIRP 展示「未知」比展示「0」诚实。

### 2. `places` 地点图鉴（对齐图 05：描述 + 当前局势）

```jsonc
{
  "id": "pl_xxx",
  "name": "御花园",
  "parentId": "pl_皇宫",                // 地点有层级：京城 > 皇宫 > 御花园
  "description": "…",                   // 静态描述
  "situation": "贵妃在此设宴，耳目众多", // 当前局势——会随剧情变
  "tendency": "偏向宫斗线",              // 图 05 的「走向倾向」
  "updatedAt": "…"
}
```

要点：`description`（静）与 `situation`（动）分两格——
局势每轮可能变，描述不该跟着抖。

### 3. `relations` 关系表（**独立表**，09-29 已拍板）

```jsonc
{
  "id": "r_xxx",
  "from": "p_李明玥",                   // 实体 id：人物、地点、势力都行
  "to": "p_裴玉姝",
  "kind": "敌对",                       // 自由词 + 常用词表提示，不做枚举硬限
  "label": "争宠",                      // 一句话说明这条边
  "strength": 70,                       // 0~100，图谱上决定线的粗细；可空
  "source": "manual",                   // manual | extract（谁写进来的，图 01 的教训：来源要可追）
  "convId": null,                       // 对话级关系则带，世界级为 null
  "updatedAt": "…"
}
```

要点：**边是有向的**（A 对 B 的态度 ≠ B 对 A）；`kind` 不做死枚举——
世界观千奇百怪，枚举是给自己挖坑，UI 侧给常用词提示即可。
势力用同一套实体：势力 = `persons` 里 `tags` 含「势力」的条目？**不**——
势力单开太亏，混进人物又脏。方案：`from/to` 接受 `p_` / `pl_` / `f_` 三种前缀，
势力表就是 `factions`（id、name、简介、tags）——第五张**轻表**，只有四格。

### 4. `powers` 力量体系（对齐图 03：等级路线 + 角色能力 + 对比分析）

```jsonc
{
  "id": "ps_xxx",
  "name": "以太回路",
  "kindLabel": "魔法位阶",
  "ranks": ["学徒", "正式", "大师"],    // 等级路线，有序数组
  "dims": [                             // 这套体系比哪些维度（雷达图的轴）
    { "key": "control", "label": "控制", "max": 100 },
    { "key": "output",  "label": "强度", "max": 100 }
  ]
}
```

角色能力挂在**人物**上，不挂在体系上：

```jsonc
// persons 条目里加一格：
"power": {
  "systemId": "ps_xxx",
  "rank": "大师",                        // 取 system.ranks 里的值
  "scores": { "control": 80, "output": 65 },  // 只写有值的轴，缺的轴在雷达上留缺口
  "history": [{ "at": "…", "rank": "正式" }]   // 成长历程（图 03 有这一栏）
}
```

要点：不同体系的 `dims` 各自定义，**对比分析只在同体系内做**——
「魔法师的精神力 vs 剑士的精神力」是假可比，AIRP 那张图也是按体系分 Tab 的。

## 三、写入从哪来

C1 一期**手动为主**：图鉴抽屉里增删改。
但留一个钩子：`lib/gen/extract.js` 已有「从正文抽结构化信息」的一次调用——
C1 二期做「每轮正文后抽取新人物/新地点/关系变化，进**待确认区**」。
待确认区 = 条目上一个 `pending: true`，UI 黄点提示，用户点头才转正。
**不自动转正**——模型会编，图鉴编进去一条假人物比没有更糟（与摘要的防编红线同源）。

## 四、路由草图

```
GET    /codex/persons?convId=…     （合并世界级 + 该对话级）
POST   /codex/persons              PUT /codex/persons/:id     DELETE 同
GET    /codex/places …             （同上四件）
GET    /codex/relations?convId=…   POST/PUT/DELETE 同
GET    /codex/factions …           （轻表，四件）
GET    /codex/powers …             （体系 + 读人物时带 power 格）
```

## 五、明确不动的

- `lib/characters/` 的 ST 兼容字段——图鉴引用它，不改它。
- 变量账（`lib/variables/`）——图鉴的人物状态**不从变量表推导**，
  两套各有各的账：变量是「宏引擎的舞台状态」，图鉴是「读者视角的世界Wiki」。
  将来想要联动，走 extract 那条路，不做实时同步。
- `board`——黑板是「此刻」，图鉴是「累计」，不合并。

## 六、动工顺序（过目后）

1. `persons` + `places` + `factions`（三表 + 抽屉 CRUD）—— 图鉴能用了
2. `relations` + 简易图谱视图（先列表后图，图谱可视化是 C3 的事）
3. `powers` + 人物 power 格 + 雷达占位
4. （二期）extract 待确认区
