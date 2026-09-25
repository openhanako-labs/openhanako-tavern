// tools/flows/group.js —— 群聊地基：在真的数据上建一场、看真装出来的 prompt
//
// 数据落在临时宿主副本上（%TEMP%\eleckoi-ui-host-data，每次启动重拷）。
const api = (p, opt) => fetch(`/__api/${p}`, opt).then((r) => r.json());
const post = (p, body) =>
  api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const out = {};
const chars = (await api("characters"))?.data || [];
out["① 有几个角色"] = chars.length;
out["① 都是谁"] = chars.map((c) => c.name).join(" / ");

if (chars.length >= 2) {
  const created = await post("conversations", {
    characterIds: [chars[0].id, chars[1].id],
    greeting: false
  });
  const conv = created?.data || created;
  out["② 建群聊：characterId"] = conv?.characterId;
  out["② 建群聊：characterIds"] = JSON.stringify(conv?.characterIds);
  out["② 名字"] = conv?.characterName;

  const pv = await post(`conversations/${conv.id}/prompt-preview`, { text: "你们两个都在？" });
  const d = pv?.data || pv;
  const sp = d?.systemPrompt || "";
  out["③ 预览里有名册吗"] = sp.includes("## 同场角色");
  out["③ 名册那段"] = (sp.split("## 同场角色")[1] || "").split("## ")[0].replace(/\n+/g, " | ").trim().slice(0, 200);
  out["③ 有「本轮发言者」吗"] = sp.includes("## 本轮发言者");
  out["③ 发言者那段"] = ((sp.split("## 本轮发言者")[1] || "").split("## ")[0] || "").replace(/\n+/g, " | ").trim().slice(0, 120);
  out["③ 账：cast / turn"] = (d?.audit?.included || [])
    .filter((i) => i.kind === "cast" || i.kind === "turn")
    .map((i) => `${i.kind}(${i.note})`)
    .join(" | ");
  out["③ 前缀组成"] = (d?.audit?.prefix?.parts || []).map((p) => p.kind).join(",");
  out["③ 名册排在第几段"] = sp.indexOf("## 同场角色") < sp.indexOf("## 本轮发言者") ? "前" : "后";
}

return out;
