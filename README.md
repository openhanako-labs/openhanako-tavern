# 夜航船 · Night Ferry Tavern

Hana v2 上的角色扮演伴侣 App —— 角色卡、对话、设定库、变量、提示词预设、图鉴、插图、语音，以及基于倒排索引 + 预算账本的记忆召回。

## 功能

| 功能 | 说明 |
|---|---|
| **角色卡** | CRUD、外观、头像、性格、背景，本地 JSON 存储 |
| **对话** | 多角色会话，流式回复，历史持久化，前情提要压缩 |
| **设定库 / 世界书** | 条目按触发条件注入提示词，跨对话生效 |
| **变量** | 定义 + 运行时赋值，注入对话提示词 |
| **提示词预设** | 系统提示词的拼接顺序数据化，可编辑 |
| **图鉴** | 人物 / 地点 / 势力三张表，对话中可增量登记 |
| **黑板** | 世界的实时状态记录，三个正交标签（地点 / 时间 / 视角） |
| **规则引擎** | 用户手编的 JSON 规则，条件求值 + 效果结算（自研 AST，不用 eval） |
| **插图 / 生成** | 角色立绘、场景插图，走宿主 `media.generate` |
| **文字转语音** | 多提供商（OpenAI / Azure），凭据走宿主 `provider.credentials` |
| **记忆召回** | 倒排索引预热 + ReAct 轻循环，命中高置信直注，失败静默降级 |
| **多导演** | 分镜式对话流，多角色按规则接管发言 |

## 安装

1. 把目录放进 `<HANA_HOME>/apps/eleckoi-tavern/`。**目录名必须一字不差等于 `manifest.id`。**
2. 打开 Market → Installed App，批准该应用（会列出 capabilities）。
3. 最低 Hana 版本：`0.982.0`。

装完后改代码在详情页 Reload 即可；`tools/` 与 `index.js` 改动需重启宿主。

## 工具接口

对外暴露 15 个工具（`app/tools.expose-to-model`）：

```
tavern_list_characters          tavern_get_character
tavern_compose_card             tavern_apply_avatar
tavern_generate_portrait
tavern_create_conversation      tavern_list_conversations
tavern_send_message
tavern_list_variables           tavern_set_variable
tavern_list_settings            tavern_get_active_settings
tavern_embed                    tavern_embed_status
```

角色卡 / 对话 / 变量 / 设定工具按组注册（`characters` / `conversations` / `variables` / `settings` / `media` / `embed` / `gen`）。

## 网络访问

`manifest.network` 白名单里放的是：

- 硅基流动 API（`api.siliconflow.cn`）—— 文字/图像生成
- Azure / OpenAI TTS
- 萌娘百科、arXiv —— 用于文档 / 引用抓取

未列入的域名一律不通。`allowLocalhost: true` 允许连本机服务。

## 数据存储

所有数据都落在 `<HANA_HOME>/app-data/eleckoi-tavern/`，不进本仓库（`.gitignore` 已挡）。

结构大致是：

```
characters/         # 角色卡
conversations/      # 对话历史 + 前情提要
codex/              # 图鉴：persons / places / factions
board-cells.json    # 黑板
presets/            # 提示词预设
variables/          # 变量定义
settings/           # 世界书条目
memory.json         # App 级偏好（记忆开关、召回预算等）
```

**角色卡和对话数据不会公开。** 本仓库只包含源码。

## 目录结构

```
manifest.json       # Hana v2 manifest（capabilities / network / contributes）
index.js            # defineApp 入口
lib/                # 26 个业务模块
  characters/       # 角色卡
  conversations/    # 对话
  codex/            # 图鉴（人物 / 地点 / 势力）
  board/            # 黑板
  lore/             # 世界书
  director/         # 规则引擎（自研 AST）
  presets/          # 提示词预设
  variables/        # 变量
  settings/         # 世界书条目
  appearance/       # 头像 / 立绘
  gen/              # 文本生成
  illustration/    # 场景插图
  media/            # 媒体上传 / 存储
  memory/           # 记忆面板配置
  recall/           # 记忆召回（倒排索引 + ReAct 轻循环）
  tts/              # 语音
  llm/              # LLM 服务封装
  models/           # 模型管理
  embed/            # 向量化
  macros/           # 宏
  regex/            # 正则规则
  migration/        # 数据迁移
  probe/            # 宿主能力探针（工具注册入口）
  tools/            # 后端路由聚合
ui/                 # 前端
  characters.html   # 主卡片
  rail.html         # 侧栏
  assets/           # CSS / 模块 / 图片
tools/              # 本地开发脚本（构建、审计、抽取）
sdk/                # 宿主 bundle 的本地副本（调试用）
```

## 本地开发

```powershell
# 依赖
npm install

# 前端热更新
npm run ui-watch

# 后端跑测试
node --test test/**/*.mjs

# 全量回归
node scripts/regression-all.mjs
```

项目内自带一套 `check-*.mjs` 静态检查（CSS 引用完整性、DOM 引用、导入图、路由健康等），共 25 项，全绿是发布前的硬门槛。

## 许可

AGPL-3.0，跟组织其他 App 保持一致。
