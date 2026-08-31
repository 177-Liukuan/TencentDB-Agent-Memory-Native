import type { UnifiedToolCall } from "../injection/adapters/interface.js";
import {
  executeMemoryBridge,
  type MemoryBridgeDeps,
  type MemoryBridgeExecutionInput,
  type MemoryBridgeExecutionResult,
} from "../memory/memory-bridge.js";
import type { ProxyConfig } from "../types.js";
import type { NativeProxyToolRegistry } from "./tool-registry.js";
import type {
  JsonValue,
  NativeToolResult,
  ToolExecutionScope,
} from "./types.js";

type ExecuteMemoryBridge = (
  input: MemoryBridgeExecutionInput,
  deps?: MemoryBridgeDeps,
) => Promise<MemoryBridgeExecutionResult>;

export interface NativeProxyToolDispatcherOptions {
  config: ProxyConfig;
  registry: NativeProxyToolRegistry;
  executeBridge?: ExecuteMemoryBridge;
  bridgeDeps?: MemoryBridgeDeps;
}

interface MemoryBridgeEnvelope {
  code?: unknown;
  message?: unknown;
  request_id?: unknown;
  data?: unknown;
}

function errorResult(
  code: string,
  message: string,
  retryable: boolean,
  requestId?: string,
): NativeToolResult {
  return {
    isError: true,
    value: {
      code,
      message,
      ...(requestId ? { request_id: requestId } : {}),
      retryable,
    },
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
    message: "Memory search result exceeded the configured size limit",
    content_omitted: true,
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
  operation: Promise<MemoryBridgeExecutionResult>,
  signal: AbortSignal,
): Promise<MemoryBridgeExecutionResult> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Native tool timed out"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
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
  });
}

export class NativeProxyToolDispatcher {
  private readonly executeBridge: ExecuteMemoryBridge;

  constructor(private readonly options: NativeProxyToolDispatcherOptions) {
    this.executeBridge = options.executeBridge ?? executeMemoryBridge;
  }

  async execute(
    call: UnifiedToolCall,
    context: ToolExecutionScope,
  ): Promise<NativeToolResult> {
    if (call.owner !== "proxy") {
      return errorResult(
        "tool_not_owned_by_proxy",
        "The requested tool is not owned by the proxy",
        false,
      );
    }
    if (call.parseError) {
      return errorResult(
        "invalid_tool_arguments",
        "Tool arguments are not valid JSON",
        false,
      );
    }

    const definition = this.options.registry.get(call.toolName);
    if (!definition) {
      return errorResult(
        "unknown_native_tool",
        "The requested Native Proxy Tool is not registered",
        false,
      );
    }
    const validated = definition.validate(call.input);
    if (!validated.ok) {
      return errorResult(
        "invalid_tool_arguments",
        "Tool arguments do not match the registered schema",
        false,
      );
    }

    const signal = AbortSignal.timeout(this.options.config.nativeProxyTools.toolTimeoutMs);
    let response: MemoryBridgeExecutionResult;
    try {
      response = await waitForBridge(this.executeBridge({
        config: this.options.config,
        subpath: definition.route,
        body: validated.value,
        sessionId: context.sessionId,
        spaceId: context.spaceId,
        signal,
      }, this.options.bridgeDeps ?? {}), signal);
    } catch {
      if (signal.aborted) {
        return errorResult(
          "memory_bridge_timeout",
          "Memory search timed out",
          true,
        );
      }
      return errorResult(
        "memory_bridge_unavailable",
        "Memory search is temporarily unavailable",
        true,
      );
    }

    let envelope: MemoryBridgeEnvelope;
    try {
      const parsed = JSON.parse(response.text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an envelope");
      }
      envelope = parsed as MemoryBridgeEnvelope;
    } catch {
      return errorResult(
        "memory_bridge_invalid_response",
        "Memory search returned an invalid response",
        true,
      );
    }

    const requestId = safeRequestId(envelope.request_id);
    if (response.status < 200 || response.status >= 300) {
      const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
      return retryable
        ? errorResult(
            "memory_bridge_unavailable",
            "Memory search is temporarily unavailable",
            true,
            requestId,
          )
        : errorResult(
            "memory_bridge_rejected",
            "Memory search request was rejected",
            false,
            requestId,
          );
    }

    if (envelope.code !== 0) {
      return errorResult(
        "memory_search_failed",
        "Memory search failed",
        false,
        requestId,
      );
    }
    if (!isJsonValue(envelope.data)) {
      return errorResult(
        "memory_bridge_invalid_response",
        "Memory search returned an invalid response",
        true,
        requestId,
      );
    }

    return {
      isError: false,
      value: boundedResult(
        envelope.data,
        this.options.config.nativeProxyTools.maxResultBytes,
      ),
    };
  }
}
