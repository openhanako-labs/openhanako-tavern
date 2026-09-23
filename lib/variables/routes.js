// lib/variables/routes.js — 变量 HTTP 路由

import { route, notFound, httpError } from "../respond.js";
import { replaceVariables, parseVariableReferences } from "./model.js";
import { validatePatch, PatchPolicy, applyPatchToDefinitions } from "./patch.js";

export function registerVariableRoutes(app, varRepo, conversationRepo, characterRepo) {
  // 列出变量定义
  app.get("/variables", route(async () => {
    return varRepo.listDefinitions();
  }));

  // 获取变量定义
  app.get("/variables/:id", route(async (c) => {
    const def = await varRepo.getDefinition(c.req.param("id"));
    if (!def) throw notFound("Variable not found");
    return def;
  }));

  // 创建变量定义
  app.post("/variables", route(async (c) => {
    return varRepo.createDefinition(await c.req.json());
  }));

  // 更新变量定义
  app.put("/variables/:id", route(async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    return varRepo.updateDefinition(id, body);
  }));

  // 删除变量定义
  app.delete("/variables/:id", route(async (c) => {
    await varRepo.deleteDefinition(c.req.param("id"));
    return true;
  }));

  // 导入变量定义
  app.post("/variables/import", route(async (c) => {
    const { variables } = await c.req.json();
    if (!Array.isArray(variables)) {
      throw new Error("variables array is required");
    }
    return varRepo.importDefinitions(variables);
  }));

  // 获取对话变量
  app.get("/conversations/:id/variables", route(async (c) => {
    return varRepo.getConversationVariables(c.req.param("id"));
  }));

  // 设置对话变量（批量）——写入前过 D3 校验
  app.put("/conversations/:id/variables", route(async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const { variables, policy } = body;

    const definitions = await varRepo.listDefinitions();
    const validation = validatePatch(variables, definitions, {
      policy: policy || PatchPolicy.STRICT
    });

    const saved = await varRepo.setConversationVariables(id, validation.accepted);

    return {
      variables: saved,
      validation: {
        accepted: Object.keys(validation.accepted),
        rejected: validation.rejected,
        coerced: validation.coerced,
        unknown: validation.unknown
      }
    };
  }));

  // 设置单个对话变量
  app.put("/conversations/:id/variables/:name", route(async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    const { value } = await c.req.json();

    const definitions = await varRepo.listDefinitions();
    const validation = validatePatch({ [name]: value }, definitions);

    if (validation.rejected.length > 0) {
      const reason = validation.rejected[0].reason;
      throw httpError(`变量 ${name} 校验失败：${reason}`, 400);
    }
    if (validation.unknown.includes(name)) {
      // 单变量写入时，未知变量直接拒绝（比批量更严格——这里只改一个，意图明确）
      throw httpError(`未知变量：${name}`, 400);
    }

    const saved = await varRepo.setConversationVariable(id, name, validation.accepted[name]);
    return { name, value: validation.accepted[name], variables: saved };
  }));

  // 应用补丁（带校验与回执）——给模型输出用
  app.post("/conversations/:id/variables/patch", route(async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();

    const definitions = await varRepo.listDefinitions();
    const patch = body.patch || body.variables || {};

    const result = applyPatchToDefinitions(definitions, patch, {
      policy: body.policy || PatchPolicy.STRICT
    });

    const saved = await varRepo.setConversationVariables(id, result.accepted);

    return {
      variables: saved,
      accepted: Object.keys(result.accepted),
      rejected: result.rejected,
      coerced: result.coerced,
      unknown: result.unknown
    };
  }));

  // 测试变量替换
  app.post("/variables/test-replace", route(async (c) => {
    const { text, variables } = await c.req.json();
    if (!text) throw new Error("text is required");

    return {
      result: replaceVariables(text, variables || {}),
      references: parseVariableReferences(text)
    };
  }));
}
