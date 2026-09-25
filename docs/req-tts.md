# 需求：宿主侧缺 TTS（文字转语音）这条媒体能力

> **状态更新（同日晚）——不再是阻塞项。**
>
> 用户定下的做法改了：**不等宿主补 TTS，App 自己把这根管子做出来，水由用户填**。
> 已经落地的是 `lib/tts/`：两根水龙头（微软 Azure 语音为默认、OpenAI 兼容／本机服务），
> key / region / baseUrl 全部由用户在设置里自己填，`sdk.network.fetch` 走不通就退到 App 运行时网络，
> 本机服务靠 `allowLocalhost`。默认提供方按用户指定用的是**微软**。
>
> 所以下面这份需求**降级为参考**：宿主哪天补上 TTS，可以再把某一根水龙头换成"用宿主的"。
> 现在不需要 mozi 为它做任何事。卡片的展示内容以本节为准。

日期：2026-09-25
提出者：奥菲莉娅（eleckoi-tavern 的开发侧）
状态：待转给 mozi

## 一句话

宿主的**应用媒体面**里有出图、出视频、语音识别（ASR），**没有文字转语音（TTS）**。
酒馆这类要做"角色开口说话"的 App 拿不到这条能力。

## 证据（读的是在跑的构建，不是文档）

在跑的宿主：`C:\Users\Administrator\.hanako\artifacts\server\0.1013.2-win32-x64-0c4a512d36b007db-g2e0c3830bec82168\bundle\index.js`

1. **能力枚举只有三个**（`AppMediaCapabilityV2` 与 `AppMediaModelCapabilityV2` 同款）：

   ```
   "image_generation" | "video_generation" | "speech_recognition"
   ```

   出处：`sdk/app-contract/bus-requests.d.ts:236`、`sdk/app-contract/media.d.ts:65`

2. **应用可用的媒体动词只有四个**（由一个能力 `app/media.generate` 门控）：

   ```
   media:generate · media:generate-image · media:generate-video · media:transcribe-audio
   ```

   出处：bundle 第 104524-104528 行（`const UA = "app/media.generate"` 紧跟这四项）

3. **全 SDK 搜不到 TTS 的任何痕迹**：`tts` / `speech_synthesis` / `text_to_speech` / `voice`
   在 `sdk/**/*.d.ts` 里零命中（只有 speech_recognition 那一族）。

4. `AppMediaGenerateRequestV2` 的 `kind` 里虽然列了 `"audio"`，但
   `AppMediaGenerationInputV2` 的 `audio` / `referenceAudios` 都是**输入引用**，
   不是"输出一段语音"——所以它不等于 TTS。

## 想要什么

最小可用的一条：**给一段文字，拿回一个音频文件**，与现有媒体动词同形。

建议形状（供参考，具体按宿主内部一致的做法定）：

- 动词：`media:generate-speech`（或把 `media:generate` 的 `kind` 扩一个 `"speech"` /
  `"tts"`，与 `image`/`video` 并列）
- 能力：沿用 `app/media.generate` 即可（同族能力，不必再加一条）
- 输入：`{ text, voice?, speed?, language?, model?, provider?, delivery: { mode } }`
- 输出：与出图一致的文件交付（应用域走 `delivery: { mode: "response" }`）
- 模型面：`AppMediaModelCapabilityV2` 增一个 `"speech_synthesis"`，
  这样 `provider:media-providers` 的 capability 过滤也能查 TTS

## 为什么值得做（具体用途）

酒馆里要做的是**给角色配音**，而且是多角色的：

- 单人对话：把角色的回复读出来
- 群聊：**每个说话人一个声音**（宿主要是能把 voice 参数透传给供应商就能做）
- 与已存在的 ASR 合成闭环：说的能转成字，写的能读出来——这两半现在只有一半

## 已知的替代路径（也算给 mozi 的信息）

宿主的应用面里有 `app/media.provide` 与 `media.registerAdapter` / `media.registerCapabilitySource`
——也就是说**一个 App 可以自己注册媒体适配器**。所以 TTS 也能由第三方 App 提供。

但从酒馆角度，这条路的成本高得多（要自己接供应商、管凭据、处理各家协议差异），
而宿主统一提供的话，所有做角色扮演/阅读类的 App 一起受益。

## 附：顺带确认可用的部分（不用动）

- 出图：`media:generate-image` — 本机已配好（provider `agnes`，模型 `agnes-image-2.5-flash`
  带 `image: true`），实测提交成功
- 出视频：`media:generate-video` — 同上（`agnes-video-2.5-flash`）
- ASR：`media:transcribe-audio` — 契约完整，含 `listSpeechRecognitionProviders()`
