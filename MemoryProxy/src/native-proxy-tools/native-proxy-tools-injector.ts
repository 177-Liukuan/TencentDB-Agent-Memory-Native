import type {
  AgentContext,
  ContextBlock,
  InjectionHook,
} from "../injection/types.js";
import { CriticalInjectionHookError } from "../injection/pipeline.js";
import { KNOWLEDGE_CATALOG_OPEN_TAG } from "../injection/injectors/knowledge-catalog-injector.js";
import type { NativeProxyToolRegistry } from "./tool-registry.js";

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

    // 选择引导随实际开放的工具写入 System，不依赖 Skill 目录或 L2/L3 正文是否为空。
    // 此 hook 的返回块用于 tools[]，说明文字直接加入上下文，不能当成工具定义返回。
    const usage: string[] = [];
    if (visible.some((tool) => tool.backend === "skill")) {
      usage.push("- **Skill：** 当任务属于某类可重复、标准化的工作流程或需要特定 SOP/专业方法时，应利用skill tool调用 Skill。");
    }
    if (visible.some((tool) => tool.backend === "memory")) {
      usage.push("- **Memory：** 当当前任务需要依赖用户和团队过去的偏好、历史约定、项目决策或之前发生过的具体信息时，应利用TDAI Memory Tools调用云端Memory。");
    }
    if (usage.length > 0) {
      const block: ContextBlock = {
        type: "text",
        content: ["<native_tool_usage>", ...usage, "</native_tool_usage>"].join("\n"),
      };
      const system = ctx.messages.find((message) => message.role === "system");
      if (system) system.blocks.push(block);
      else ctx.messages.unshift({ role: "system", blocks: [block] });
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
