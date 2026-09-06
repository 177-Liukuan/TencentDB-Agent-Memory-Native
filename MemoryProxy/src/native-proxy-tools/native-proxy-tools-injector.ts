import type {
  AgentContext,
  ContextBlock,
  InjectionHook,
} from "../injection/types.js";
import { CriticalInjectionHookError } from "../injection/pipeline.js";
import { KNOWLEDGE_CATALOG_OPEN_TAG } from "../injection/injectors/knowledge-catalog-injector.js";
import type { NativeProxyToolRegistry } from "./tool-registry.js";

// 沿用 Baseline 的 Memory 使用规则；只替换传输说明，工具用途交给 description。
// 放在实际工具开放检查之后注入，避免无记忆资产时漏掉规则，或对未开放工具发出调用指令。
const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
这组 TDAI 记忆能力与 Claude Code 原生 Memory/MEMORY.md 具有同等优先级；涉及记忆时不要只查本地 MEMORY.md。
遇到用户问身份/历史/偏好/过往结论/项目约定时，必须先使用 TDAI 记忆工具查询，再基于查询结果回答。
需要查记忆时，直接调用对应的 TDAI Memory Tool。

## 记忆使用规则（遇到以下场景必须先查再答）

L3（persona 长期画像）与 L2 场景索引已直接注入 system。L2 正文按需用 tdai_read_scene 读取；L0/L1（原始对话 / 原子记忆）不再每轮自动召回，需要用工具主动检索。

### 必须先查记忆再回答的场景（命中任一条即触发工具调用）

1. **用户提及历史/过去/之前**：如 "我之前说过 / 我告诉过你 / 上次 / 你还记不记得 / 我们聊过 / 之前那个"
   → 用 \`tdai_conversation_search\`（L0 原文找具体消息）
2. **用户涉及自己身份/偏好/习惯**：如 "我叫什么 / 我的名字 / 我喜欢 / 我的团队 / 我常用 / 我不喜欢 / 我不允许"
   → 用 \`tdai_memory_search\`（L1 原子记忆查偏好/规则）
3. **用户要求你回忆/找**：如 "回忆一下 / 想起 / 找出 / 有没有关于 X 的记录 / 查我们之前"
   → 直接触发工具，不要凭空回答
4. **答案强依赖历史事实**：如 "那个 bug 我们怎么修的 / 上次方案是啥 / 我们的约定是什么"
   → 关键词化后 \`tdai_memory_search\`

**典型流程**（用户："我叫什么"）：
先调用 \`tdai_memory_search\`，参数为 {"query": "用户姓名 name 身份", "limit": 5}，再基于查询结果回答。
若为空，明确告诉用户 "我在记忆里没找到，你叫什么？" —— 不要装作知道。

### 不需要查的场景

- 用户问 "你是谁" / "帮我改代码" / "写个脚本" / 通用编程问题
- 当前会话上下文（同轮消息）里已能回答
- 已经在 \`<l3_core_memory>\` 段落里直接看到答案

### ⚠️ 调用约束

- 这组工具只读，不能用于修改 L1/L2/L3。
- 每轮 \`tdai_memory_search\` + \`tdai_conversation_search\` **合计 ≤ 3 次**（\`tdai_read_scene\` / \`tdai_scenario_ls\` / \`tdai_atomic_query\` 不计入）
- 检索无果时**明确说明**"我在记忆里没找到 X"，不要幻想
- 同一 L2 path 不要重复读
</memory-tools-guide>`;

export class NativeProxyToolNameCollisionError extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super(`Client Tool name collides with Native Proxy Tool: ${toolName}`);
    this.name = "NativeProxyToolNameCollisionError";
    this.toolName = toolName;
  }
}

export interface NativeProxyToolInjectionFailureDescription {
  type: "invalid_request_error";
  message: string;
}

export function describeNativeProxyToolInjectionFailure(
  error: unknown,
): NativeProxyToolInjectionFailureDescription | null {
  if (error instanceof NativeProxyToolNameCollisionError) {
    return {
      type: "invalid_request_error",
      message: `Tool name '${error.toolName}' is reserved by the proxy`,
    };
  }
  if (
    error instanceof CriticalInjectionHookError
    && error.hookId === "native-proxy-tools-injector"
  ) {
    if (error.cause instanceof NativeProxyToolNameCollisionError) {
      return {
        type: "invalid_request_error",
        message: `Tool name '${error.cause.toolName}' is reserved by the proxy`,
      };
    }
    return {
      type: "invalid_request_error",
      message: "Native Proxy Tool injection failed",
    };
  }
  return null;
}

export interface NativeProxyToolsInjectorOptions {
  enabled: boolean;
  registry: NativeProxyToolRegistry;
  memoryEnabled?: boolean;
  skillEnabled?: boolean;
  allowSkillWrite?: boolean;
  knowledgeEnabled?: boolean;
}

export class NativeProxyToolsInjector implements InjectionHook {
  readonly id = "native-proxy-tools-injector";
  readonly point = "tools.append" as const;
  readonly priority = 0;
  readonly description = "Inject structured Native Proxy Tool definitions";
  readonly cacheStrategy = "none" as const;
  readonly critical = true;

  constructor(private readonly options: NativeProxyToolsInjectorOptions) { }

  execute(ctx: AgentContext): ContextBlock[] {
    if (!this.isEligibleRequest(ctx)) return [];

    for (const tool of ctx.tools ?? []) {
      if (this.options.registry.owns(tool.name)) {
        throw new NativeProxyToolNameCollisionError(tool.name);
      }
    }

    if (!this.hasTrustedSession(ctx)) return [];

    const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
    const capabilities = custom?.assetCapabilities as Record<string, unknown> | undefined;
    // Catalog hook 先落到 system，真工具只在至少有一个授权资源时出现。
    // 缓存命中时 hook.execute 不会运行，因此这里直接检查已注入的目录标签。
    const knowledgeCatalogAvailable = ctx.messages.some((message) => (
      message.role === "system"
      && message.blocks.some((block) => (
        block.type === "text" && block.content.includes(KNOWLEDGE_CATALOG_OPEN_TAG)
      ))
    ));
    const visible = this.options.registry.visibleFor({
      memoryEnabled: this.options.memoryEnabled ?? true,
      chatMemory: capabilities?.chat_memory !== false,
      skillEnabled: this.options.skillEnabled ?? false,
      skillCapability: capabilities?.skill !== false,
      allowSkillWrite: this.options.allowSkillWrite ?? false,
      knowledgeEnabled: this.options.knowledgeEnabled ?? false,
      knowledgeCapability:
        capabilities?.llm_wiki !== false || capabilities?.code_graph !== false,
      knowledgeCatalogAvailable,
    });

    // 此 hook 的返回块用于 tools[]，使用规则直接加入 System，不能当成工具定义返回。
    if (visible.some((tool) => tool.backend === "memory")) {
      const block: ContextBlock = {
        type: "text",
        content: MEMORY_TOOLS_GUIDE,
      };
      const system = ctx.messages.find((message) => message.role === "system");
      if (system) {
        // 工具是否开放仍在这里判断，但文案应像 Baseline 一样紧跟记忆正文，
        // 不能因 tools.append 执行较晚而落到 Skill 后面。正文为空时放在 Skill 引导前。
        const profileEnd = "</tdai_profile_memory>";
        const skillHeading = /^## (?:Skills \(mandatory\)|Available Cloud Skills)/m;
        const profile = system.blocks.find((item) => item.type === "text" && item.content.includes(profileEnd));
        const target = profile ?? system.blocks.find((item) => item.type === "text" && skillHeading.test(item.content));
        if (target) {
          const offset = profile
            ? target.content.indexOf(profileEnd) + profileEnd.length
            : target.content.search(skillHeading);
          // 只在原文本块中插入，保留其他内容、分块及 cache_control 等传输信息。
          target.content = `${target.content.slice(0, offset)}\n\n${MEMORY_TOOLS_GUIDE}\n\n${target.content.slice(offset)}`;
        } else {
          system.blocks.push(block);
        }
      } else {
        ctx.messages.unshift({ role: "system", blocks: [block] });
      }
    }

    return visible.map((tool) => ({
      type: "custom" as const,
      content: tool.description,
      metadata: {
        tool_name: tool.name,
        parameters: tool.inputSchema,
        native_proxy_owner: tool.owner,
        native_proxy_backend: tool.backend,
        native_proxy_effect: tool.effect,
        native_proxy_route: tool.route,
      },
    }));
  }

  private isEligibleRequest(ctx: AgentContext): boolean {
    if (
      !this.options.enabled
      || !["anthropic", "openai", "responses"].includes(ctx.metadata.protocol)
      || !ctx.metadata.stream
    ) {
      return false;
    }
    const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
    if (custom?.nativeProxyEligible === false) return false;
    return true;
  }

  private hasTrustedSession(ctx: AgentContext): boolean {
    const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
    const session = custom?.session as Record<string, unknown> | undefined;
    if (!session) return false;
    const required = ["session_id", "team_id", "agent_id", "user_id"] as const;
    if (!required.every((key) => typeof session[key] === "string" && (session[key] as string).length > 0)) {
      return false;
    }
    if (ctx.metadata.userId && session.user_id !== ctx.metadata.userId) return false;
    if (ctx.metadata.sessionKey && session.session_id !== ctx.metadata.sessionKey) return false;
    return true;
  }
}
