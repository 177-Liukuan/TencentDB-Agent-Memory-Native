import type {
  AgentContext,
  ContextBlock,
  InjectionHook,
} from "../injection/types.js";
import { CriticalInjectionHookError } from "../injection/pipeline.js";
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
}

export class NativeProxyToolsInjector implements InjectionHook {
  readonly id = "native-proxy-tools-injector";
  readonly point = "tools.append" as const;
  readonly priority = 0;
  readonly description = "Inject structured Native Proxy Tool definitions";
  readonly cacheStrategy = "none" as const;
  readonly critical = true;

  constructor(private readonly options: NativeProxyToolsInjectorOptions) {}

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
    const visible = this.options.registry.visibleFor({
      memoryEnabled: this.options.memoryEnabled ?? true,
      chatMemory: capabilities?.chat_memory !== false,
      skillEnabled: this.options.skillEnabled ?? false,
      skillCapability: capabilities?.skill !== false,
      allowSkillWrite: this.options.allowSkillWrite ?? false,
    });

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
    if (!this.options.enabled || ctx.metadata.protocol !== "anthropic" || !ctx.metadata.stream) {
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
