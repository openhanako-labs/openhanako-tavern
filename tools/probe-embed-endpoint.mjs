// tools/probe-embed-endpoint.mjs —— 试探一个 OpenAI 兼容端点：能不能出向量
//
// 用途：宿主列表里有 BAAI/bge-m3（SiliconFlow 提供，OpenAI 兼容），
// 也有一个本地中继 http://127.0.0.1:8788/v1。
// 本地那条**不需要 key**——如果它转发 /embeddings，实验台就能直接用它跑。
//
// 打印里**绝不出现 key**：只报状态码、维数、错误消息的摘要。

const CANDIDATES = [
  { name: "本地中继", base: "http://127.0.0.1:8788/v1", key: process.env.LOCAL_RELAY_KEY || "not-needed" },
  { name: "SiliconFlow", base: "https://api.siliconflow.cn/v1", key: process.env.SILICONFLOW_API_KEY || "" }
];
const MODEL = process.argv[2] || "BAAI/bge-m3";

async function tryGet(url, headers) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    const text = (await r.text()).slice(0, 200);
    return { status: r.status, text };
  } catch (e) {
    return { status: 0, text: `(连不上: ${String(e.message).slice(0, 80)})` };
  }
}

async function tryEmbed(base, key) {
  if (!key) return { status: -1, text: "(没有 key，跳过——不试无凭据的远端)" };
  try {
    const r = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, input: "维数探测" }),
      signal: AbortSignal.timeout(20000)
    });
    const text = await r.text();
    let dim = null;
    try {
      const j = JSON.parse(text);
      dim = j?.data?.[0]?.embedding?.length ?? null;
      if (dim === null) return { status: r.status, text: text.slice(0, 160) };
    } catch { return { status: r.status, text: text.slice(0, 160) }; }
    return { status: r.status, text: `✓ 向量维数 = ${dim}` };
  } catch (e) {
    return { status: 0, text: `(出错: ${String(e.message).slice(0, 80)})` };
  }
}

console.log(`\n模型：${MODEL}\n`);
for (const c of CANDIDATES) {
  console.log(`── ${c.name}  ${c.base}`);
  const models = await tryGet(`${c.base}/models`, c.key ? { Authorization: `Bearer ${c.key}` } : {});
  console.log(`   GET /models    → ${models.status}  ${models.text.replace(/\s+/g, " ").slice(0, 120)}`);
  const emb = await tryEmbed(c.base, c.key);
  console.log(`   POST /embeddings → ${emb.status === -1 ? "-" : emb.status}  ${emb.text}`);
  console.log("");
}
