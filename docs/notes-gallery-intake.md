# 图库接入 · 侦察结论

> 2026-09-27 · 侦察：rebecca · 记录：奥菲莉娅
> 对应 `plans/2026-09-25-scene-illustration-and-gallery.md` 第 3 批 3.1
> **结论推翻了该计划 3.2 的默认选型。**

## 一句话

图库是**被动扫盘**的索引器，不是拉取器。Tavern 该做的是**把图放到约定位置**，让图库自己发现——不是让图库来读 Tavern 的台账。

## 结论

出图产物落到：

```
<HANA_HOME>/app-data/eleckoi-tavern/generated/
```

图库下次扫描时自动发现并入索引，**图库侧零改动**。

## 依据

1. 图库扫描集合 = 显式 `scanPaths` ∪ `galleryRoot` ∪ **`<HANA_HOME>/plugin-data/*/generated/`、`<HANA_HOME>/app-data/*/generated/`**。
   `runtime/service.mjs:94, 157-172, 1699-1731`（`discoverGeneratedDirs()` 注释写明「凡存在的一律收录，不再依赖我猜测某个固定目录名」）
2. `gallery_push` 方向相反：`images 表 → 外部目录`，不是外部 → 库。`runtime/service.mjs:2891-2940`
3. 入库去重靠 `images.file_hash` UNIQUE（sha256 文件字节），与「引用了哪条台账」无关。`runtime/schema.mjs:62`、`runtime/service.mjs:1821`
4. 外部入口只有 URL 级（`/import-url`、`/add-external`），且**只注册为 HTTP 路由，没有对应的 Model 工具**。`runtime/service.mjs:2518-2594`、`http/ui.js:265-272`
5. 加一个「读外部清单」的工具要动两处（`lib/register-tools.mjs` + `runtime/service.mjs`），并把 Tavern 的台账 schema 绑死到图库版本上——耦合，不做。

## 落地前提（已验证）

App 的 `sdk.dataDir` 就是 `<HANA_HOME>/app-data/<app-id>/`（`index.js:75, 101`），所以
`path.join(dataDir, "generated")` 天然落在图库的自动发现目录里。**不需要任何越权路径，也不需要 ResourceIO 绕行。**

## 对计划的影响

- **3.2 改走 (a)**，但具体形态是「落盘到 `generated/`」，不是「调某个推送接口」。
- `GET /media/index`（第 1 批）仍然要做，但定位从「给图库读的来源」降为「给界面和其他消费者用」。
- 出图落点：现有 `<dataDir>/media/` 与 `<dataDir>/characters/<id>/avatar.png` 不动；**新增的插图产物写 `<dataDir>/generated/`**（即 `<HANA_HOME>/app-data/eleckoi-tavern/generated/`）。
- **去重不归 Tavern 管**——图库按文件字节 hash 兜住，Tavern 不需要为实现去重而改 schema。
