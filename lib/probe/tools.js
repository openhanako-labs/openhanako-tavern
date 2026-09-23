// lib/probe/tools.js — 业务工具定义
//
// 从 index.js 剥离。每个工具是纯定义，依赖由调用方注入。
// 这样 index.js 只剩"装配"，不再被 300 行工具定义淹没。

/** 统一的工具返回包装。 */
function text(s) {
  return { content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] };
}

/** 统一错误捕获，避免每个工具都写一遍 try/catch。 */
function guard(fn) {
  return async (args) => {
    try {
      return text(await fn(args));
    } catch (e) {
      return text(`Error: ${e?.message || String(e)}`);
    }
  };
}

/** 角色卡工具组。 */
export function createCharacterTools(characterRepo) {
  return [
    {
      name: "tavern_list_characters",
      description: "列出所有角色卡摘要",
      parameters: { type: "object", properties: {} },
      execute: guard(() => characterRepo.list())
    },
    {
      name: "tavern_get_character",
      description: "获取角色卡详情",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "角色卡 ID" } },
        required: ["id"]
      },
      execute: guard(async (args) => {
        const card = await characterRepo.get(args.id);
        return card || "Character not found";
      })
    }
  ];
}

/** 对话工具组。 */
export function createConversationTools({ conversationRepo, characterRepo, settingRepo, llmService, regexRepo = null }) {
  return [
    {
      name: "tavern_create_conversation",
      description: "创建新对话",
      parameters: {
        type: "object",
        properties: { characterId: { type: "string", description: "角色卡 ID" } },
        required: ["characterId"]
      },
      execute: guard((args) => conversationRepo.create(args.characterId))
    },
    {
      name: "tavern_list_conversations",
      description: "列出所有对话",
      parameters: { type: "object", properties: {} },
      execute: guard(() => conversationRepo.list())
    },
    {
      name: "tavern_send_message",
      description: "发送消息并生成回复",
      parameters: {
        type: "object",
        properties: {
          conversationId: { type: "string", description: "对话 ID" },
          content: { type: "string", description: "消息内容" }
        },
        required: ["conversationId", "content"]
      },
      execute: guard(async (args) => {
        const conv = await conversationRepo.get(args.conversationId);
        if (!conv) return "Conversation not found";

        const character = await characterRepo.get(conv.characterId);
        if (!character) return "Character not found";

        await conversationRepo.addMessage(args.conversationId, "user", args.content);

        // ⚠️ 走共享管线——与 HTTP 路由同一条。
        //    之前这里用的是 getActiveSettings + shouldTrigger（纯子串匹配），
        //    与世界书引擎（selectiveLogic / 递归 / 概率 / 分组 / 锚点分流）
        //    完全不是一回事，导致通过工具发消息时新引擎全部不生效。
        let reply = "[LLM not available]";
        if (llmService?.available) {
          try {
            const { prepareGenerationInput } = await import("../conversations/pipeline.js");
            const { input } = await prepareGenerationInput(
              { conversationRepo, characterRepo, settingRepo, regexRepo },
              args.conversationId,
              args.content,
              args.options || {}
            );
            const result = await llmService.generate(input.messages, {
              systemPrompt: input.systemPrompt
            });
            reply = result.content;
          } catch (e) {
            reply = `[LLM error: ${e.message}]`;
          }
        }

        await conversationRepo.addMessage(args.conversationId, "assistant", reply);
        return reply;
      })
    }
  ];
}

/** 变量工具组。 */
export function createVariableTools({ variableRepo, conversationRepo }) {
  const tools = [
    {
      name: "tavern_list_variables",
      description: "列出所有变量定义",
      parameters: { type: "object", properties: {} },
      execute: guard(() => variableRepo.listDefinitions())
    }
  ];

  if (conversationRepo) {
    tools.push({
      name: "tavern_set_variable",
      description: "设置对话变量值",
      parameters: {
        type: "object",
        properties: {
          conversationId: { type: "string", description: "对话 ID" },
          name: { type: "string", description: "变量名" },
          value: { description: "变量值" }
        },
        required: ["conversationId", "name", "value"]
      },
      execute: guard((args) =>
        variableRepo.setConversationVariable(args.conversationId, args.name, args.value)
      )
    });
  }

  return tools;
}

/** 设定库工具组。 */
export function createSettingTools({ settingRepo, conversationRepo }) {
  const tools = [
    {
      name: "tavern_list_settings",
      description: "列出所有设定条目",
      parameters: { type: "object", properties: {} },
      execute: guard(() => settingRepo.list())
    }
  ];

  if (conversationRepo) {
    tools.push({
      name: "tavern_get_active_settings",
      description: "获取基于上下文的活跃设定",
      parameters: {
        type: "object",
        properties: {
          conversationId: { type: "string", description: "对话 ID" },
          text: { type: "string", description: "上下文文本" }
        },
        required: ["conversationId"]
      },
      execute: guard(async (args) => {
        const conv = await conversationRepo.get(args.conversationId);
        if (!conv) return "Conversation not found";
        const context = { text: args.text || "" };

        // 按角色隔离：绑定到别的角色的条目不该出现在结果里。
        const character = conv.characterId
          ? await characterRepo.get(conv.characterId).catch(() => null)
          : null;
        const scope = character
          ? { characterId: conv.characterId, characterName: character.name, characterTags: character.tags }
          : null;

        return settingRepo.getActive(context, conv.variables, scope);
      })
    });
  }

  return tools;
}
