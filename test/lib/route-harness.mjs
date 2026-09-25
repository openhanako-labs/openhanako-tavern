// test/lib/route-harness.mjs — 离线跑路由的小台子
//
// 为什么需要：整条 HTTP 面（路由注册 + handler + 状态码 + 响应形状）此前
// 在任何测试里都没被跑过。静态检查只能证明「路由写在那儿」，证明不了
// 「打过去会有正确的回应」。而宿主把 App 的 HTTP 面锁在鉴权后面
//（直接打 /api/apps/<id>/... 是 403），所以真环境也点不着。
//
// 这个台子按 Hono 的语义做最小复刻：
//   - 按注册顺序匹配，先匹配先赢（与 Hono 一致）
//   - 段数不同不匹配；:param 吃一整段
//   - c.req.query / c.req.param / c.req.json / c.json / c.body 够路由用
//
// route() 包装过的 handler 会调 c.json(payload, status)，这里收下来，
// 于是「状态码 + {ok,data} 响应形状」也能被断言——那是 respond.js 的契约，
// 前端按它解析，破了会全线静默失效。

export function makeApp() {
  const routes = [];
  const app = {};

  for (const method of ["get", "post", "put", "delete", "patch"]) {
    app[method] = (routePath, handler) => {
      routes.push({ method: method.toUpperCase(), path: routePath, handler });
    };
  }

  app.routes = routes;

  /** 找第一条能匹配的路由。返回 { route, params } 或 null。 */
  app.match = (method, reqPath) => {
    const segs = String(reqPath).split("/").filter(Boolean);
    for (const r of routes) {
      if (r.method !== String(method).toUpperCase()) continue;
      const rs = r.path.split("/").filter(Boolean);
      if (rs.length !== segs.length) continue;

      const params = {};
      let hit = true;
      for (let i = 0; i < rs.length; i++) {
        if (rs[i].startsWith(":")) { params[rs[i].slice(1)] = decodeURIComponent(segs[i]); continue; }
        if (rs[i] !== segs[i]) { hit = false; break; }
      }
      if (hit) return { route: r, params };
    }
    return null;
  };

  return app;
}

export function makeCtx({ query = {}, params = {}, body, headers = {}, formData } = {}) {
  const out = { payload: undefined, status: 200, headers: undefined };

  const ctx = {
    req: {
      query: (k) => (k === undefined ? { ...query } : query[k]),
      param: (k) => (k === undefined ? { ...params } : params[k]),
      json: async () => {
        if (body === undefined) throw new Error("no body");
        return body;
      },
      /*
       * header / formData 是路由真在用的两样：
       *   · characters 与 migration 的导入都先看 Content-Type 分流（JSON vs multipart）
       *   · 上传的备份文件走 c.req.formData()
       * 台子不提供它们，这两条路就根本跑不起来——而它们恰恰是
       * “界面能点、但一按就错”的重灾区。
       */
      header: (name) => {
        const want = String(name).toLowerCase();
        for (const [k, v] of Object.entries(headers)) {
          if (String(k).toLowerCase() === want) return v;
        }
        return undefined;
      },
      formData: async () => {
        if (!formData) throw new Error("no formData");
        return formData;
      }
    },
    json: (payload, status = 200) => { out.payload = payload; out.status = status; return out; },
    body: (payload, status = 200, headers) => {
      out.payload = payload; out.status = status; out.headers = headers; return out;
    }
  };

  return { ctx, out };
}

/**
 * 打一次请求。
 * @returns {Promise<{status:number, ok:boolean, data:any, error?:string, code?:string}|null>}
 *          找不到路由返回 null（而不是断言失败）——「路由没注册」本身就是一种结论。
 */
export async function request(app, method, reqPath, opts = {}) {
  const hit = app.match(method, reqPath);
  if (!hit) return null;

  const { ctx, out } = makeCtx({ ...opts, params: hit.params });
  const returned = await hit.route.handler(ctx);

  // 响应有两种落地方式，别只接一种：
  //   · 走 c.json / c.body 的 → 落在 out.payload
  //   · raw(Response) 的 → **作为返回值**（respond.js 对 `body instanceof Response`
  //     直接 return body，绕过 c.body）
  //
  // 注意：假 c.json() 自己也返回一个对象（out），所以**只认 Response**——
  // 把「任何非空返回值」都当 payload 会把 c.json 的返回值抓进来，全线崩。
  let payload = out.payload;
  let status = out.status;
  if (returned instanceof Response) {
    payload = returned;
    status = returned.status;
  }

  // SSE 端点返回的是 Response（body 是一条流）。**必须把流读干净**：
  // 不读的话 handler 会在后台继续跑，与测试后续动作抢同一个对话，
  // 制造出假的报错噪音（也会让「流式路径到底跑没跑过」变得说不清）。
  if (payload && typeof payload.text === "function" && !(payload instanceof Response && !payload.body)) {
    try { await payload.text(); } catch { /* 读完就行 */ }
  }

  const isEnvelope = payload && typeof payload === "object" && !(payload instanceof Response) && "ok" in payload;
  const env = isEnvelope ? payload : {};
  return {
    status,
    ok: env.ok === true,
    data: env.data,
    error: env.error,
    code: env.code,
    payload
  };
}
