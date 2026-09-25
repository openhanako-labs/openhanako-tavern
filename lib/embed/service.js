// lib/embed/service.js — 用宿主自己的 embedding 模型算向量
//
// 为什么需要这个文件
// ------------------
// 宿主给 App 的模型契约（app-contract/models.d.ts）只有四个成员：
//   list / stream / utility / cancel
// —— **没有 embedding 面**。但"没有那个方法"不等于"算不了"：
//
//   ctx.bus.request("provider:models-by-type", { type: "embedding" })
//   ctx.bus.request("provider:credentials",   { providerId })
//      → { apiKey, baseUrl, api, headers? }
//
// 拿到 baseUrl + apiKey 之后，按 OpenAI 兼容形状 POST {baseUrl}/embeddings
// 就行。所以宿主里那个免费模型（BAAI/bge-m3）**真的能用**，
// 而且不需要用户把 key 交出来——凭据由宿主现场发。
//
// 这个文件的核心是纪律，不是代码
// ------------------------------
//   ① 凭据只在内存里活这一次调用：**不落盘、不进日志、不进返回值**
//   ② 返回值只有 { providerId, model, dimension, vectors }
//   ③ 失败要说清**哪一步**失败（找不到模型 / 没授权 / 端点拒绝 / 形状不对），
//      不要伪装成"算出来是空的"——那是最坏的一种失败。

/** 凭据字段名（要在一起判定，不能只看 apiKey）。 */
const CREDENTIAL_ERROR = "error";

/**
 * 按 id 认 embedding 模型。
 *
 * 为什么需要这个启发式：宿主解析类型时会**退回默认值 "chat"**
 * （bundle/index.js:196003 那段：
 *   `type resolution: model entry type field → known-models.json type → default "chat"`），
 * 而服务端自带的 default-models.json 里根本没有 bge。
 * 于是 `provider:models-by-type` 问 "embedding" 得到 **0 条**——
 * 不是配置错，是宿主没有为它建立类型。
 *
 * 表情包插件当年也是按 id 认的（biaoqingbao/lib/shared.js:getAvailableEmbeddingModels），
 * 排除项也是照它来的：重排、多模态 embedding 都不算。
 */
const EMBED_ID_RE = /(bge|embed)/i;
const NOT_EMBED_ID_RE = /(rerank|vl-embed|vision-embed|image-embed|audio-embed|video-embed)/i;

function idOf(m) {
  return String(m?.id ?? m?.modelId ?? m?.model ?? m?.name ?? m?.model_id ?? "").trim();
}

export function isEmbeddingCandidate(m) {
  const id = idOf(m);
  if (!id) return false;
  if (NOT_EMBED_ID_RE.test(id)) return false;
  return EMBED_ID_RE.test(id);
}

/**
 * 从一堆模型元数据里挑一个 embedding 模型。
 *
 * `AppPublicModelMetadataV2` 是 `Record<string, unknown>`——**字段名不保证**，
 * 所以这里不猜死一个 key，而是把几个常见字段都看一遍。
 * 优先 `prefer` 命中（按 id 或 name，忽略大小写与斜杠），否则取第一个。
 */
export function pickEmbeddingModel(models, prefer = null) {
  if (!Array.isArray(models) || models.length === 0) return null;

  const norm = (s) => String(s || "").toLowerCase().replace(/[/_-]/g, "");

  // 只在这个集合里挑：`prefer` 不能越过“它得像个 embedding 模型”这条线。
  // 不然 prefer="bge" 会把 "BAAI/bge-reranker-v2-m3" 也用 includes 命中，
  // 然后拿重排模型去打 /embeddings → 400，而报错看着像 key 不对。
  const pool = models.filter(isEmbeddingCandidate);
  const from = pool.length > 0 ? pool : models;

  if (prefer) {
    const want = norm(prefer);
    const exact = from.find((m) => norm(idOf(m)) === want);
    if (exact) return exact;
    const loose = from.find((m) => norm(idOf(m)).includes(want));
    if (loose) return loose;
  }
  return from[0];
}

/**
 * 问宿主“有哪些 embedding 模型”，空的话回退到扫目录。
 *
 * 两条路的区别要报出来（`how`）——将来宿主补上类型声明后，
 * 应该能看到它从 `scan` 变成 `by-type`；看不到就说明我去追错了地方。
 */
async function listEmbeddingModels(bus, providerId) {
  let byType = [];
  let typeError = null;
  try {
    const res = await bus.request("provider:models-by-type", {
      type: "embedding",
      ...(providerId ? { providerId } : {})
    });
    // 与 provider:credentials 同一套信封约定：失败是 {error}。
    // 不拆的话，“没授权”会被说成“没有 embedding 模型”——最难查的那种错。
    if (res && typeof res === "object" && res.error) {
      typeError = `宿主拒了按类型查：${res.error}`;
    }
    byType = Array.isArray(res?.models) ? res.models : [];
  } catch (e) {
    typeError = e?.message || String(e);
  }

  if (byType.length > 0) return { models: byType, how: "by-type", typeError };

  // 回退：扫模型目录，按 id 认。
  let all = [];
  try {
    const res = await bus.request("model:list");
    all = Array.isArray(res?.models) ? res.models : [];
  } catch (e) {
    if (typeError) {
      // 两条都挂——最常见的原因就是缺授权。这句提示有诊断价值，不能丢。
      throw new Error(
        `按类型查与扫目录都失败（缺 app/models.read 授权？）——按类型：${typeError}；扫目录：${e?.message || e}`
      );
    }
    throw new Error(`扫模型目录失败（缺 app/models.read 授权？）：${e?.message || e}`);
  }

  const hit = all.filter(isEmbeddingCandidate);
  return { models: hit, how: "scan", typeError, scanned: all.length };
}

/** 把一个模型元数据归一成 { providerId, modelId }。 */
export function normalizeTarget(model, fallbackProviderId = null) {
  if (!model) return null;
  const providerId =
    model.providerId ?? model.provider ?? model.provider_id ?? fallbackProviderId ?? null;
  const modelId = model.id ?? model.modelId ?? model.model ?? model.name ?? null;
  if (!modelId) return null;
  return { providerId, modelId: String(modelId) };
}

/**
 * 问宿主要凭据。
 *
 * 返回值**只在内部流转**：调用方（embedTexts）用完即弃，
 * 绝不出现在任何 return / console.log / 落盘里。
 */
async function fetchCredentials(bus, providerId) {
  if (!bus?.request) {
    throw new Error("sdk.bus.request 不可用——这个 App 没有 bus 面");
  }
  if (!providerId) {
    throw new Error("解析不出 providerId，无法取凭据");
  }

  const res = await bus.request("provider:credentials", { providerId });

  // ⚠️ 这个返回是**联合类型**：成功 {apiKey, baseUrl, …} / 失败 {error}。
  //    "信封没拆"在这个仓库里已经栽过三次——这里按字段判，不按真值判。
  if (!res || typeof res !== "object" || Array.isArray(res)) {
    // 数组也是 "object"——只判 typeof 会把它放过，然后在下一句报
    // “凭据里没有 apiKey”，把“宿主返回了畸形数据”说成“宿主没给钥匙”。
    throw new Error(`取凭据返回了非对象：${Array.isArray(res) ? "数组" : typeof res}`);
  }
  if (CREDENTIAL_ERROR in res && res[CREDENTIAL_ERROR]) {
    throw new Error(`取凭据被拒：${res[CREDENTIAL_ERROR]}`);
  }
  if (!res.apiKey) {
    throw new Error("凭据里没有 apiKey（宿主没给，或这个 provider 不需要？）");
  }
  return {
    apiKey: res.apiKey,
    baseUrl: res.baseUrl || null,
    api: res.api || null,
    headers: res.headers || null
  };
}

/** 把 baseUrl 归一（去掉尾斜杠；已经有 /v1 就不再补）。 */
function embeddingsUrl(baseUrl) {
  if (!baseUrl) return null;
  const base = String(baseUrl).replace(/\/+$/, "");
  return `${base}/embeddings`;
}

/**
 * 真的去调一次 embedding 端点。
 *
 * 形状校验是必须的：`data` 个数与输入不符、或维数不一致，
 * 都比"抛异常"更难发现——所以这里逐条对。
 */
export async function embedTexts(texts, { baseUrl, apiKey, headers, modelId, fetchImpl = globalThis.fetch, timeoutMs = 60000 } = {}) {
  const inputs = Array.isArray(texts) ? texts.map((t) => String(t ?? "")) : [String(texts ?? "")];
  if (inputs.length === 0) throw new Error("输入为空——没有要算的文本");

  const url = embeddingsUrl(baseUrl);
  if (!url) throw new Error("凭据里没有 baseUrl——不知道往哪发");
  if (typeof fetchImpl !== "function") throw new Error("这个运行时没有 fetch");

  const body = { model: modelId, input: inputs.length === 1 ? inputs[0] : inputs };
  const safeHeaders = Object.fromEntries(
    Object.entries(headers || {}).filter(([k]) => !/^(authorization|proxy-authorization)$/i.test(k))
  );
  // ⚠️ 顺序很重要：宿主给的 headers 先展开，**authorization 最后写**。
  // 反过来的话，宿主只要带一个 authorization 字段就把它覆盖掉——
  // 要么用错凭据，要么用了不该用的值。而且 key 大小写不同挡不住，
  // 所以上面要先显式滤掉。
  const hdrs = {
    "content-type": "application/json",
    ...safeHeaders,
    authorization: `Bearer ${apiKey}`
  };

  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;

  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined
    });
  } catch (e) {
    // 只报 origin，不报整个 URL：baseUrl 是宿主给的，
    // 万一它把令牌塞在查询串里（非标准，但确实有人这么干），整串回显就是泄漏。
    let where = "(URL 无法解析)";
    try { where = new URL(url).origin; } catch { /* 保持兜底文案 */ }
    // undici 把真正的原因全塞在 cause 里（DNS / TLS / 连接 / 白名单拒绝），
    // 只报 e.message 的话，“网络不通”和“这个域名不许访问”长得一模一样——
    // 而这两件事的修法完全相反（一个查网络，一个改白名单）。
    // 所以把 cause 挖出来一起报。
    const cause = e?.cause;
    const detail = cause
      ? `${e?.message || e}（cause: ${cause?.code || cause?.name || "?"} ${cause?.message || cause}）`
      : (e?.message || String(e));
    throw new Error(`连不上 embedding 端点（${where}）：${detail}`);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    // 端点拒绝时把状态码与它说的话带上——但**不回显 authorization**。
    // 限幅不是脱敏：先把长串（令牌、ID）打掉，再截。
    const brief = raw.replace(/\s+/g, " ").replace(/[A-Za-z0-9_\-]{24,}/g, "…").slice(0, 160);
    throw new Error(`端点拒绝（HTTP ${res.status}）：${brief}`);
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`端点返回的不是 JSON：${raw.slice(0, 160)}`);
  }

  const data = json?.data;
  if (!Array.isArray(data)) {
    throw new Error(`返回里没有 data 数组：${raw.slice(0, 160)}`);
  }
  if (data.length !== inputs.length) {
    throw new Error(`返回条数对不上：给了 ${inputs.length} 条文本，回来 ${data.length} 条向量`);
  }

  const vectors = data.map((d, i) => {
    const v = d?.embedding;
    if (!Array.isArray(v) || v.length === 0) {
      throw new Error(`第 ${i} 条没有 embedding 数组`);
    }
    return v;
  });

  const dim = vectors[0].length;
  for (let i = 1; i < vectors.length; i++) {
    if (vectors[i].length !== dim) {
      throw new Error(`维数不一致：第 0 条 ${dim} 维，第 ${i} 条 ${vectors[i].length} 维`);
    }
  }

  return {
    dimension: dim,
    vectors,
    usage: json?.usage ?? null
  };
}

/**
 * 一站式：找模型 → 取凭据 → 算向量。
 *
 * 返回里**没有凭据**。要诊断哪一步失败，看抛出来的那句话——
 * 每一层都写了自己是谁。
 */
export async function embed(bus, texts, { providerId = null, model = null, modelsFace = null, net = null, fetchImpl = globalThis.fetch } = {}) {
  // ⓪ 宿主长出 `models.embed` 这条面了吗？长了就用它。
  //
  // 为什么该优先走它：能力收窄（只给向量，不给钥匙）、端点差异由宿主抹平。
  // 现在这条路是“自己取一份完整凭据 + 拼一次 OpenAI 形状的请求”——能跑，
  // 但 App 手里多了一把不必要的钥匙（bge-m3 不吃 dimensions 那个坑也得自己记）。
  //
  // 宿主契约里目前只有 list/stream/utility/cancel，所以现在走的是下面那条。
  // 这条分支是**留着**的：哪天宿主长出 embed，这里不用再改一行。
  const hostEmbed = modelsFace && typeof modelsFace.embed === "function" ? modelsFace.embed : null;
  if (hostEmbed) {
    const listedHost = await listEmbeddingModels(bus, providerId);
    const pickedHost = pickEmbeddingModel(listedHost.models, model);
    const targetHost = normalizeTarget(pickedHost, providerId);
    if (!targetHost) throw new Error("挑出来的模型没有 id，无法调用");
    const res = await hostEmbed({
      requestId: `embed-${Date.now()}`,
      provider: targetHost.providerId,
      model: targetHost.modelId,
      input: Array.isArray(texts) ? texts : [texts]
    });
    return {
      providerId: targetHost.providerId,
      model: targetHost.modelId,
      dimension: res?.dimension ?? (res?.vectors?.[0]?.length || 0),
      vectors: res?.vectors || [],
      candidates: listedHost.models.length,
      foundBy: listedHost.how,
      via: "host"
    };
  }

  // ① 问宿主：有哪些 embedding 模型（按类型查，空就扫目录）
  const listed = await listEmbeddingModels(bus, providerId);
  const models = listed.models;

  if (models.length === 0) {
    throw new Error(
      "宿主里没有 embedding 模型（按类型查空，扫目录也没找到 id 含 bge/embed 的）"
    );
  }

  // ② 挑一个
  const picked = pickEmbeddingModel(models, model);
  const target = normalizeTarget(picked, providerId);
  if (!target) throw new Error("挑出来的模型没有 id，无法调用");

  /*
   * 出网必须走宿主那条门：`sdk.network.fetch`。
   *
   * 为什么不能直接用 globalThis.fetch：App 入口跑在独立的 AppHost 子进程里，
   * **原始网络被 Node 权限模型拒掉**（实测：getaddrinfo ERR_ACCESS_DENIED）。
   * 宿主那条门会跨 IPC 替 App 做检查（白名单 → 私网/HTTPS → 方法 → 超时 → 字节上限），
   * 检查用的就是 manifest 里的 `network.allowedHosts`。
   *
   * 留 `fetchImpl` 只是给测试注入用；线上两个调用点传的都是 `sdk.network`。
   */
  const doFetch = net?.fetch ? net.fetch.bind(net) : fetchImpl;

  // ③ 取凭据
  const creds = await fetchCredentials(bus, target.providerId);

  // ④ 算
  const out = await embedTexts(texts, {
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    headers: creds.headers,
    modelId: target.modelId,
    fetchImpl: doFetch
  });

  return {
    providerId: target.providerId,
    model: target.modelId,
    dimension: out.dimension,
    vectors: out.vectors,
    candidates: models.length,
    foundBy: listed.how,
    via: "direct"
  };
}

/** 只看“能不能用”，不真的算——诊断用。 */
export async function status(bus, { model = null, providerId = null } = {}) {
  const out = { ok: false, step: null, note: null, providerId: null, model: null, candidates: 0, foundBy: null };
  try {
    const listed = await listEmbeddingModels(bus, providerId);
    out.foundBy = listed.how;
    out.candidates = listed.models.length;
    if (listed.scanned != null) out.scanned = listed.scanned;
    if (listed.typeError) out.typeError = listed.typeError;

    // 按类型查空是**正常的**（宿主把没写 type 的模型一律算 chat）——
    // 但要说出来，不然看的人会以为“宿主里没有这个模型”。
    if (listed.how === "scan") {
      out.note = `宿主按类型查 embedding 是 0 条（它把没写 type 的模型一律算 chat），改扫目录：${listed.scanned} 条里认出 ${listed.models.length} 条`;
    }

    if (listed.models.length === 0) {
      out.step = "models";
      out.note = out.note || "扫目录也没找到 id 含 bge/embed 的模型";
      return out;
    }

    const target = normalizeTarget(pickEmbeddingModel(listed.models, model), providerId);
    out.providerId = target?.providerId ?? null;
    out.model = target?.modelId ?? null;

    // provider 推不出来这件事要说清楚：扫目录拿到的条目未必带 provider 字段。
    if (!target?.providerId) {
      out.step = "provider";
      out.note = `${out.note ? out.note + "；" : ""}挑出来的模型条目里没有 provider 字段，无法取凭据`;
      return out;
    }

    const creds = await fetchCredentials(bus, target.providerId);
    out.step = "credentials";
    out.note = `${out.note ? out.note + "；" : ""}拿到凭据（baseUrl=${creds.baseUrl ? "有" : "无"}，api=${creds.api || "未标"}）`;
    out.ok = true;
    return out;
  } catch (e) {
    out.step = out.step || "unknown";
    out.note = e?.message || String(e);
    return out;
  }
}
