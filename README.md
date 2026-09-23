# ElecKoi Tavern · M0 探针

Hana v2 App · 用于验证宿主能力（B11-B20）

**阶段**：M0 · 骨架 + 探针  
**版本**：0.1.0-probe  
**宿主版本**：≥ 0.982.0

---

## 目标

M0 是 ElecKoi Tavern 的第一阶段：不写业务，只验证 Hana v2 宿主 API。

`04-open-questions.md` 里的 **B 类问题**（B11-B20）都需要实测：

| 编号 | 探针项 |
|---|---|
| B11 | `defineApp` 生命周期是否按预期触发 |
| B12 | install-confirmed grants 是否真的在 defineApp 前生效 |
| B13 | `sdk.dataDir` 卸载是否保留 |
| B14 | `contributes.cards[].face` 图片要求是否满足 |
| B15 | `hana.ui.resize` 是否有上限 |
| B16 | `sdk.bus.subscribe` 是否是只读投影 |
| B17 | `sdk.config` 时机（本探针暂未涉及） |
| B18 | `sdk.agents` / `contributes.agentTypes` 存在性 |
| B19 | `contributes.ui.inputStatus` 输入栏控件（已声明一个） |
| B20 | `contributes.messageRenderers`（本探针暂未涉及） |

## 安装

```powershell
# 1. 拷贝到 HANA_HOME/apps/
$devDir = "W:\Games\Hanako\Work\开发\eleckoi-tavern"
$installDir = "$env:USERPROFILE\.hanako\apps\eleckoi-tavern"
Copy-Item $devDir $installDir -Recurse -Force

# 2. 重启 Hana（或触发 App 加载）
# 3. 在设置页批准安装（会列出 capabilities）

# 4. 打开探针卡片
#    在聊天里输入："打开 ElecKoi Tavern 探针面板"
#    或者调用工具：eleckoi_tavern_probe
```

## 验证步骤

1. **App 加载成功**：Hana 设置 → App 列表里出现 `eleckoi-tavern`，状态是 `active`
2. **capabilities 批准**：安装时弹窗列出 3 个能力，全部批准
3. **卡片能打开**：右键聊天流"打开卡片"或调用工具
4. **输入栏出现 Probe 按钮**：如果 Hana ≥ 0.970.9
5. **调用 `eleckoi_tavern_probe` 工具**：模型能拿到 probe 状态 JSON
6. **dataDir 落盘**：`%USERPROFILE%\.hanako\apps\eleckoi-tavern\userdata\probe-state.json` 存在

## 交付物

**M0 探针报告**：`W:\Games\Hanako\Work\计划\ElecKoi-Hanako-Tavern\M0-host-probe.md`

跑完后按以下模板填写：

```markdown
## M0 宿主能力实测报告

| B 编号 | 探针项 | 结果 | 备注 |
|---|---|---|---|
| B11 | defineApp 生命周期 | ✅ / ❌ | … |
| B12 | install-confirmed grants | … | … |
| … | … | … | … |

## 结论

- 已确认能力：…
- 需绕行：…
- M1 可以开工 / M1 需等待
```

## 文件结构

```
eleckoi-tavern/
├─ manifest.json           # V2 manifest · 3 个 capabilities
├─ index.js                # defineApp 入口 · 探针逻辑
├─ assets/
│  ├─ icon.svg             # App icon
│  └─ cover.svg            # Card face
├─ sdk/                    # 宿主 bundle 的本地副本
└─ ui/
   ├─ probe.html           # 探针卡片页面
   └─ assets/
      ├─ probe.css
      ├─ probe.js
      ├─ cover.svg
      └─ sdk.js            # 前端 SDK
```

## 下一步

- M0 探针跑通 → 填 M0-host-probe.md → 交月曦夜拍板 A1
- A1 拍板后 → M1（角色卡 CRUD）开工
