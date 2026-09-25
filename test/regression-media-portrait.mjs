// test/regression-media-portrait.mjs — 出图：立绘写回角色卡
//
// 这一份锁三件事：
//   ① 调用形状必须是宿主规定的那个——**scope:"app" + delivery.mode:"response"**。
//      宿主原话：`app-scoped media generation requires response delivery`。
//      形状写错了在真机上只会得到一句"出图失败"，而原因藏在宿主里。
//   ② 结果里的文件挑不出来时**要报错**，不能把空数组当成功
//      （用户看到的是"完成"，头像却没变）。
//   ③ 落盘那一步真的写进了 avatar.<ext>，并且头像接口取得到。

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeApp, request } from "./lib/route-harness.mjs";

const { CharacterRepo } = await import("../lib/characters/repo.js");
const { CharacterTransfer } = await import("../lib/characters/transfer.js");
const { registerCharacterRoutes } = await import("../lib/characters/routes.js");
const { registerMediaRoutes } = await import("../lib/media/routes.js");
const { portraitPrompt } = await import("../lib/media/prompt.js");
const { status, pickPaths, pickImageFile, isAbsolutePath } = await import("../lib/media/service.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 出图 · 立绘写回卡 ===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-media-"));
const charRepo = new CharacterRepo(tmp);
await charRepo.init();
const transfer = new CharacterTransfer(charRepo);

const card = await charRepo.create({
  name: "薇拉·霜语",
  description: "守夜法师，银灰长发，深蓝斗篷上有霜纹",
  personality: "话少，习惯先看再开口",
  scenario: "雪夜城墙",
  first_mes: "「又是你。」",
  tags: ["守夜", "法师"]
});

/** 造一个假图片文件，让路由真的去读磁盘。 */
const fakeImg = path.join(tmp, "out.png");
fs.writeFileSync(fakeImg, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));

/** 记录收到的请求，便于断言"形状"。
 *
 * 默认返回形状按**真实观察到的那次**来（2026-09-25 一次真出图）：
 *   files 里是**裸文件名**，完整路径在 sessionFiles[].filePath。
 * 用真形状当默认值，是为了让后面的路由用例真的走过挑路径那一步；
 * 否则测试会在一个比真机宽松的假世界上绿。
 */
function makeSdk(files = [path.basename(fakeImg)], ok = true) {
  const calls = [];
  return {
    calls,
    media: {
      async generateImage(req) {
        calls.push(req);
        if (!ok) return { ok: false, error: "上游 429" };
        // files 为空 = 一张都没出，那就不要挂 sessionFiles——
        // 否则“空文件列表”那个用例会看到一个不是空的世界。
        return {
          ok: true,
          files,
          ...(files.length ? { sessionFiles: [{ filePath: fakeImg, realPath: fakeImg }] } : {})
        };
      }
    }
  };
}

const app = makeApp();
const sdk = makeSdk();
registerMediaRoutes(app, { sdk, characterRepo: charRepo, transfer });

// ── 提示词（纯函数）─────────────────────────────────────

await okAsync("① 提示词只用卡里已有的字段，不编外貌", () => {
  const { prompt, parts, hasCharacter } = portraitPrompt(card);
  assert.ok(prompt.includes("薇拉·霜语"), "名字没进去");
  assert.ok(prompt.includes("守夜法师"), "描述没进去");
  assert.ok(prompt.includes("雪夜城墙"), "场景没进去");
  assert.ok(prompt.includes("守夜"), "标签没进去");
  assert.ok(!/金发|蓝眼|红瞳/.test(prompt), "编了卡里没有的外貌");
  assert.ok(parts.length >= 5, "parts 该能看清由什么拼成");
  assert.strictEqual(hasCharacter, true, "卡里有描述/性格/场景/标签，该说有角色信息");
});

await okAsync("② 卡里没写的东西不会凭空出现（空卡的提示词只有风格）", () => {
  const { prompt, parts, hasCharacter } = portraitPrompt({ name: "" });
  assert.ok(!/「」/.test(prompt), "空名字不该拼出空的引号");
  assert.ok(prompt.length > 0, "至少要留下风格那一句");
  // 光有"非空"不算判据：真正要锁的是"卡里没东西时只剩风格那一句"，
  // 而且要能告诉调用方"这段里没有这个人"（复核指出过）。
  assert.strictEqual(parts.length, 1, `空卡该只剩风格，实为 ${parts.length} 段：${parts.join(" | ")}`);
  assert.strictEqual(hasCharacter, false, "空卡不该说自己有角色信息");
  // 只有名字（没有描述/性格/场景/标签）同理：名字不算"这个人"
  const onlyName = portraitPrompt({ name: "林默" });
  assert.strictEqual(onlyName.hasCharacter, false, "只有名字就算有角色信息了？");
  assert.strictEqual(onlyName.cardParts, 1);
});

// 结构级判据：每个 part 都要能追回卡里的原文。
// 为什么不用黑名单（金发|蓝眼）——那种写法在真出问题时也会过：
// 卡里写着"银灰长发"，实现真去"提炼外貌"，提炼出来的也是银灰，命中不了黑名单。
await okAsync("① 每个 part 都能追回卡里的原文（结构级，不靠黑名单）", () => {
  const cardLike = {
    name: "薇拉·霜语",
    description: "守夜法师，银灰长发，深蓝斗篷上有霜纹",
    personality: "话少，习惯先看再开口",
    scenario: "雪夜城墙",
    tags: ["守夜", "法师"]
  };
  const { parts } = portraitPrompt(cardLike);
  const source = [cardLike.name, cardLike.description, cardLike.personality, cardLike.scenario, ...cardLike.tags]
    .map((v) => String(v ?? "").replace(/\s+/g, " ").trim())
    .join("︴");

  const probes = [];
  for (const p of parts) {
    const m = /^角色「(.+)」的半身立绘$/.exec(p);
    if (m) { probes.push(m[1]); continue; }           // 名字那一段
    if (p === parts[parts.length - 1]) continue;       // 最后一段是风格，允许外来
    probes.push(p.replace(/^(?:性格|场景|标签)：/, ""));
  }
  assert.ok(probes.length >= 3, `该有名字/描述/性格…几段可追，实为 ${probes.length}`);
  for (const t of probes) {
    // 标签那一段是"守夜、法师"这样拼起来的，拆开逐个追
    const pieces = t.includes("、") ? t.split("、") : [t];
    for (const piece of pieces) {
      assert.ok(source.includes(piece), `这个 part 在卡里找不到原文，就是自己编的：「${piece}」`);
    }
  }
});

await okAsync("①b 卡里没有外貌词时，提示词里也不许冒出来", () => {
  const bare = { name: "林默", description: "守夜法师", personality: "话少", scenario: "雪夜城墙", tags: ["守夜"] };
  const { prompt } = portraitPrompt(bare);
  assert.ok(!/(金|银|红|蓝|绿|黑|棕|紫|粉|灰)(发|发色|瞳|眼睛|眼|肤)/.test(prompt), "自造了外貌：" + prompt);
  assert.ok(!/(长|短|卷|直|披肩|马尾)(发|发丝|发丝)/.test(prompt), "自造了发型：" + prompt);
});

// ── status ─────────────────────────────────────────────

await okAsync("③ 没给 sdk / sdk 没 media 时，明确说清缺什么", () => {
  assert.strictEqual(status(null).available, false);
  assert.ok(/app\/media\.generate/.test(status(null).reason), "没提示缺的能力：" + status(null).reason);
  assert.strictEqual(status({ media: {} }).available, false);
  assert.ok(/generateImage/.test(status({ media: {} }).reason), "契约对不上时该说清是哪个方法缺：" + status({ media: {} }).reason);
  assert.strictEqual(status({ media: { generateImage: () => {} } }).available, true);
});

await okAsync("④ pickPaths：认得字符串与几种对象形状，读不出的丢掉", () => {
  // 注意传的是**整个返回**（不是 files 数组）——
  // 因为真返里路径可能在 sessionFiles，不看整体就会漏。
  assert.deepStrictEqual(
    pickPaths({ files: ["a.png", { path: "b.png" }, { filePath: "c.png" }, { nope: 1 }, null] }),
    ["a.png", "b.png", "c.png"]
  );
  assert.deepStrictEqual(pickPaths(null), []);
  assert.deepStrictEqual(pickPaths({}), []);
});

// 这一条是墓碑：真实返回里 files 给的是**裸文件名**。
// 只认 files、拿名字去 readFile 的写法会 ENOENT，
// 而那句错只会说"找不到文件"，看不出是"我没找对地方"。
await okAsync("④b 真实形状：路径在 sessionFiles，files 里只是文件名", () => {
  const real = {
    ok: true,
    files: ["vera-frostwhisper-nightwatch-9db672bb.png"],
    sessionFiles: [{ filePath: "W:\\Games\\Hanako\\Work\\OH-媒体库\\vera.png", realPath: "W:\\Games\\Hanako\\Work\\OH-媒体库\\vera.png" }]
  };
  assert.deepStrictEqual(pickPaths(real)[0], "W:\\Games\\Hanako\\Work\\OH-媒体库\\vera.png",
    "sessionFiles 里的完整路径该排在前面");
  assert.strictEqual(pickImageFile(real), "W:\\Games\\Hanako\\Work\\OH-媒体库\\vera.png");
  assert.strictEqual(isAbsolutePath("vera.png"), false, "裸文件名不算路径");
  assert.strictEqual(isAbsolutePath("W:\\a\\b.png"), true);
  assert.strictEqual(isAbsolutePath("/tmp/a.png"), false, "这个 App 只跑在 Windows 上");
  // Windows 的绝对路径不止盘符一种写法（复核指出过）：
  // Node 处理长路径会给 \\?\ 前缀，网络盘是 UNC。
  assert.strictEqual(isAbsolutePath("\\\\?\\C:\\a\\b.png"), true, "长路径前缀该认");
  assert.strictEqual(isAbsolutePath("\\\\server\\share\\b.png"), true, "UNC 该认");

  // 只有裸文件名 → 挑不出可读路径（要报错，不能当成路径用）
  assert.strictEqual(pickImageFile({ files: ["only-a-name.png"] }), null);
});

// ── 路由 ───────────────────────────────────────────────

await okAsync("⑤ GET /media/status", async () => {
  const r = await request(app, "GET", "/media/status");
  assert.strictEqual(r.status, 200, `状态 ${r.status}`);
  assert.strictEqual(r.data.available, true);

  // 契约对不上的那条分支也要走过（策略是 fail closed，不是“没有就当能用”）：
  const halfApp = makeApp();
  registerMediaRoutes(halfApp, { sdk: { media: {} }, characterRepo: charRepo, transfer });
  const half = await request(halfApp, "GET", "/media/status");
  assert.strictEqual(half.status, 200);
  assert.strictEqual(half.data.available, false, "宿主给了 media 但没 generateImage，不该判可用");
  assert.ok(/generateImage/.test(half.data.reason || ""), "理由该指到具体方法：" + half.data.reason);
});

await okAsync("⑥ POST /media/portrait：调用形状对（scope=app + response 交付）", async () => {
  sdk.calls.length = 0;
  const r = await request(app, "POST", "/media/portrait", { body: { characterId: card.id } });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.ok, true);
  assert.strictEqual(r.data.avatarExt, "png");

  const call = sdk.calls[0];
  assert.ok(call, "宿主一次都没被调到");
  assert.strictEqual(call.scope, "app", "必须带 scope=app");
  assert.strictEqual(call.input?.delivery?.mode, "response",
    "宿主原话：app-scoped media generation requires response delivery");
  assert.ok(String(call.input?.prompt || "").includes("薇拉"), "提示词没带上");
  // 应用域不能走异步交付：把不该出现的字段钉住，防日后手滑加回来
  assert.ok(!("task" in (call.input || {})), "input 里不该有 task");
  assert.ok(!("taskId" in (call.input || {})), "input 里不该有 taskId");
});

await okAsync("⑦ 立绘真的落到了 avatar.<ext>，头像接口取得到", async () => {
  const read = await transfer.readAvatar(card.id);
  assert.ok(read, "读不到头像");
  assert.strictEqual(read.ext, "png");
  assert.ok(read.buffer.length > 0, "头像文件是空的");

  const app2 = makeApp();
  registerCharacterRoutes(app2, charRepo, transfer, null);
  const img = await request(app2, "GET", `/characters/${card.id}/avatar`);
  assert.strictEqual(img.status, 200, `状态 ${img.status}`);
});

// 扩展名换了（png→webp）不能留孤儿；认不得的扩展名不许落到盘上。
await okAsync("⑦b 换扩展名清旧文件；认不得的扩展名一律当 png", async () => {
  const webp = path.join(tmp, "out.webp");
  fs.writeFileSync(webp, Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]));
  const appW = makeApp();
  const sdkW = { media: { async generateImage() { return { ok: true, files: [], sessionFiles: [{ filePath: webp }] }; } } };
  registerMediaRoutes(appW, { sdk: sdkW, characterRepo: charRepo, transfer });
  const r = await request(appW, "POST", "/media/portrait", { body: { characterId: card.id } });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.avatarExt, "webp");
  assert.strictEqual(r.data.file, "avatar.webp");
  const dir = path.join(charRepo.dir, card.id);
  const after = fs.readdirSync(dir).filter((f) => f.startsWith("avatar."));
  assert.deepStrictEqual(after, ["avatar.webp"], `旧头像没清干净：${after.join(",")}`);

  // 怪扩展名（比如被人塞成 png.exe）不进盘
  const evil = path.join(tmp, "portrait.png.exe");
  fs.writeFileSync(evil, Buffer.from([1, 2, 3, 4]));
  const appE = makeApp();
  const sdkE = { media: { async generateImage() { return { ok: true, files: [], sessionFiles: [{ filePath: evil }] }; } } };
  registerMediaRoutes(appE, { sdk: sdkE, characterRepo: charRepo, transfer });
  const rE = await request(appE, "POST", "/media/portrait", { body: { characterId: card.id } });
  assert.strictEqual(rE.status, 200, `状态 ${rE.status}：${rE.error || ""}`);
  assert.strictEqual(rE.data.avatarExt, "png", "怪扩展名该被换成 png");
  assert.strictEqual(rE.data.file, "avatar.png");
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith(".exe")), "盘上不该出现 .exe");
});

// 空卡：不能默默出一张不相干的图，得在返回里把话说出来。
// create 对 description/first_mes 有必填校验，而**导入来的老卡真会字段为空**——
// 所以用不校验的 restore 造这种卡（它本来就是导入那条路在用的）。
await okAsync("⑦c 卡里没角色信息 → 返回里带 warning", async () => {
  const hollow = await charRepo.restore({
    name: "未命名的某人", description: " ", first_mes: " ", personality: "", scenario: "", tags: []
  });
  const appH = makeApp();
  registerMediaRoutes(appH, { sdk: makeSdk(), characterRepo: charRepo, transfer });
  const r = await request(appH, "POST", "/media/portrait", { body: { characterId: hollow.id } });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.ok(/不会像这个角色/.test(r.data.warning || ""), "该提醒“图不会像她”：" + r.data.warning);

  // 有角色信息的卡就不该报这句
  const appOk = makeApp();
  registerMediaRoutes(appOk, { sdk: makeSdk(), characterRepo: charRepo, transfer });
  const rOk = await request(appOk, "POST", "/media/portrait", { body: { characterId: card.id } });
  assert.strictEqual(rOk.status, 200);
  assert.strictEqual(rOk.data.warning, undefined, "有内容的卡不该报警：" + rOk.data.warning);
});

await okAsync("⑧ 宿主返回空文件列表 → 报错，不当成功", async () => {
  const app3 = makeApp();
  const emptySdk = makeSdk([]);
  registerMediaRoutes(app3, { sdk: emptySdk, characterRepo: charRepo, transfer });
  const r = await request(app3, "POST", "/media/portrait", { body: { characterId: card.id } });
  assert.strictEqual(r.status, 400, `状态该是 400，实为 ${r.status}`);
  assert.ok(/没拿到文件/.test(r.error || ""), "错误话不对：" + r.error);
});

await okAsync("⑨ 宿主报失败 → 把原因带出来", async () => {
  const app4 = makeApp();
  const badSdk = makeSdk([fakeImg], false);
  registerMediaRoutes(app4, { sdk: badSdk, characterRepo: charRepo, transfer });
  const r = await request(app4, "POST", "/media/portrait", { body: { characterId: card.id } });
  assert.strictEqual(r.status, 400);
  assert.ok(/上游 429/.test(r.error || ""), "原因被吞了：" + r.error);
});

await okAsync("⑩ 缺 characterId / 卡不存在 → 各自的错", async () => {
  const a = await request(app, "POST", "/media/portrait", { body: {} });
  assert.strictEqual(a.status, 400);
  assert.ok(/characterId/.test(a.error || ""), a.error);

  const b = await request(app, "POST", "/media/portrait", { body: { characterId: "nope" } });
  assert.strictEqual(b.status, 404, `状态 ${b.status}`);
});

// 宿主只回裸文件名（没有 sessionFiles）：不能把名字当路径读、也不能报一句看不懂的 ENOENT。
await okAsync("⑪ 只有裸文件名 → 报错要说清拿到了什么", async () => {
  const app5 = makeApp();
  const bareSdk = {
    media: {
      async generateImage() { return { ok: true, files: ["bare-name.png"] }; }
    }
  };
  registerMediaRoutes(app5, { sdk: bareSdk, characterRepo: charRepo, transfer });
  const r = await request(app5, "POST", "/media/portrait", { body: { characterId: card.id } });
  assert.strictEqual(r.status, 400, `状态该是 400，实为 ${r.status}`);
  assert.ok(/可读的路径/.test(r.error || ""), "错误话没把拿到的东西写出来：" + r.error);
  assert.ok(/bare-name\.png/.test(r.error || ""), "该把文件名当线索列出来：" + r.error);
});

console.log(`\n${fail === 0 ? "✅" : "❌"} 出图立绘：${pass} 过 / ${fail} 败\n`);
process.exit(fail === 0 ? 0 : 1);
