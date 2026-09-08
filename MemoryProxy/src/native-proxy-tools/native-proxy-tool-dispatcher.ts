import type { UnifiedToolCall } from "../injection/adapters/interface.js";
import type {
  MemoryBridgeDeps,
  MemoryBridgeExecutionInput,
  MemoryBridgeExecutionResult,
} from "../memory/memory-bridge.js";
import type { ProxyConfig } from "../types.js";
import {
  createBridgeToolExecutors,
  type BridgeToolExecutionResult,
  type BridgeToolExecutors,
} from "./bridge-tool-executors.js";
import type { NativeProxyToolDefinition, NativeProxyToolRegistry } from "./tool-registry.js";
import type { JsonValue, NativeToolResult, ToolExecutionScope } from "./types.js";

type ExecuteMemoryBridge = (
  input: MemoryBridgeExecutionInput,
  deps?: MemoryBridgeDeps,
) => Promise<MemoryBridgeExecutionResult>;

export interface NativeProxyToolDispatcherOptions {
  config: ProxyConfig;
  registry: NativeProxyToolRegistry;
  executors?: BridgeToolExecutors;
  /** Compatibility seam retained for existing Memory Bridge unit tests. */
  executeBridge?: ExecuteMemoryBridge;
  bridgeDeps?: MemoryBridgeDeps;
}

interface BridgeEnvelope {
  code?: unknown;
  message?: unknown;
  request_id?: unknown;
  data?: unknown;
}

function errorResult(code: string, message: string, retryable: boolean, requestId?: string): NativeToolResult {
  return {
    isError: true,
    value: { code, message, ...(requestId ? { request_id: requestId } : {}), retryable },
  };
}

function safeRequestId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 128) return undefined;
  return /^[A-Za-z0-9._:-]+$/.test(value) ? value : undefined;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedResult(value: JsonValue, maxBytes: number): JsonValue {
  const serialized = JSON.stringify(value);
  const originalBytes = utf8Bytes(serialized);
  if (originalBytes <= maxBytes) return value;

  const base = {
    code: "result_too_large",
    message: "Native tool result exceeded the configured size limit",
    content_omitted: true,
    truncated: true,
    original_bytes: originalBytes,
    preview: "",
  };
  const characters = Array.from(serialized);
  let low = 0;
  let high = characters.length;
  let best = base;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = { ...base, preview: characters.slice(0, middle).join("") };
    if (utf8Bytes(JSON.stringify(candidate)) <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function waitForBridge(
  operation: Promise<BridgeToolExecutionResult>,
  signal: AbortSignal,
): Promise<BridgeToolExecutionResult> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Native tool timed out"));
    };
    // The operation may have started before cancellation; always consume its rejection.
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function labels(definition: NativeProxyToolDefinition): {
  prefix: "memory" | "skill" | "knowledge";
  operation: string;
} {
  if (definition.backend === "memory") return { prefix: "memory", operation: "Memory search" };
  if (definition.backend === "skill") return { prefix: "skill", operation: "Skill operation" };
  return { prefix: "knowledge", operation: "Knowledge operation" };
}

function responseIsRetryable(response: BridgeToolExecutionResult): boolean {
  return response.status === 408 || response.status === 429 || response.status >= 500;
}

export class NativeProxyToolDispatcher {
  private readonly executors: BridgeToolExecutors;

  constructor(private readonly options: NativeProxyToolDispatcherOptions) {
    this.executors = options.executors ?? createBridgeToolExecutors(options.config, {
      memory: options.bridgeDeps,
    });
    if (options.executeBridge) {
      const executeBridge = options.executeBridge;
      this.executors = {
        ...this.executors,
        memory: async ({ definition, body, scope, signal }) => executeBridge({
          config: options.config,
          subpath: definition.route,
          body,
          sessionId: scope.sessionId,
          spaceId: scope.spaceId,
          signal,
        }, options.bridgeDeps ?? {}),
      };
    }
  }

  async execute(call: UnifiedToolCall, context: ToolExecutionScope, requestSignal?: AbortSignal): Promise<NativeToolResult> {
    const cancelled = () => errorResult("native_tool_cancelled", "Native Proxy Tool request was cancelled; execution may already have started", false);
    if (requestSignal?.aborted) return cancelled();
    if (call.owner !== "proxy") {
      return errorResult("tool_not_owned_by_proxy", "The requested tool is not owned by the proxy", false);
    }
    if (call.parseError) {
      return errorResult("invalid_tool_arguments", "Tool arguments are not valid JSON", false);
    }

    const definition = this.options.registry.get(call.toolName);
    if (!definition) {
      return errorResult("unknown_native_tool", "The requested Native Proxy Tool is not registered", false);
    }
    const validated = definition.validate(call.input);
    if (!validated.ok) {
      return errorResult("invalid_tool_arguments", "Tool arguments do not match the registered schema", false);
    }

    const label = labels(definition);
    const timeout = AbortSignal.timeout(this.options.config.nativeProxyTools.toolTimeoutMs);
    const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
    const executor = this.executors[definition.backend];
    const maxAttempts = definition.effect === "read" ? 2 : 1;
    let response: BridgeToolExecutionResult | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        signal.throwIfAborted();
        response = await waitForBridge(executor({
          callId: call.callId,
          definition,
          body: validated.value,
          scope: context,
          signal,
        }), signal);
      } catch {
        if (requestSignal?.aborted) return cancelled();
        if (signal.aborted) {
          return errorResult(`${label.prefix}_bridge_timeout`, `${label.operation} timed out`, true);
        }
        if (attempt < maxAttempts) continue;
        return errorResult(
          `${label.prefix}_bridge_unavailable`,
          `${label.operation} is temporarily unavailable`,
          true,
        );
      }
      if (requestSignal?.aborted) return cancelled();
      if (responseIsRetryable(response) && attempt < maxAttempts) continue;
      break;
    }

    if (!response) {
      return errorResult(`${label.prefix}_bridge_unavailable`, `${label.operation} is temporarily unavailable`, true);
    }

    let envelope: BridgeEnvelope;
    try {
      const parsed = JSON.parse(response.text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an envelope");
      envelope = parsed as BridgeEnvelope;
    } catch {
      return errorResult(`${label.prefix}_bridge_invalid_response`, `${label.operation} returned an invalid response`, true);
    }

    const requestId = safeRequestId(envelope.request_id);
    if (response.status < 200 || response.status >= 300) {
      const retryable = responseIsRetryable(response);
      return errorResult(
        retryable ? `${label.prefix}_bridge_unavailable` : `${label.prefix}_bridge_rejected`,
        retryable ? `${label.operation} is temporarily unavailable` : `${label.operation} was rejected`,
        retryable,
        requestId,
      );
    }

    if (envelope.code !== 0) {
      const failureCode = definition.backend === "memory"
        ? "memory_search_failed"
        : definition.backend === "skill"
          ? "skill_operation_failed"
          : "knowledge_operation_failed";
      return errorResult(
        failureCode,
        `${label.operation} failed`,
        false,
        requestId,
      );
    }

    const data = envelope.data === undefined ? null : envelope.data;
    if (!isJsonValue(data)) {
      return errorResult(`${label.prefix}_bridge_invalid_response`, `${label.operation} returned an invalid response`, true, requestId);
    }
    return {
      isError: false,
      value: boundedResult(data, this.options.config.nativeProxyTools.maxResultBytes),
    };
  }
}
