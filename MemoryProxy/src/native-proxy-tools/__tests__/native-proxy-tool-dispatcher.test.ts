import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import type { UnifiedToolCall } from "../../injection/adapters/interface.js";
import type { MemoryBridgeExecutionResult } from "../../memory/memory-bridge.js";
import type { ToolExecutionScope } from "../types.js";
import { NativeProxyToolDispatcher } from "../native-proxy-tool-dispatcher.js";
import { createDefaultNativeProxyToolRegistry } from "../tool-registry.js";

function config() {
  const value = structuredClone(DEFAULT_CONFIG);
  value.nativeProxyTools.enabled = true;
  value.nativeProxyTools.toolTimeoutMs = 100;
  value.nativeProxyTools.maxResultBytes = 1_024;
  return value;
}

function memoryCall(input: unknown = { query: "rules" }): UnifiedToolCall {
  return {
    callId: "call-1",
    toolName: "tdai_memory_search",
    owner: "proxy",
    slotIndex: 0,
    contentBlockIndex: 0,
    argumentsComplete: true,
    input: input as UnifiedToolCall["input"],
  };
}

function trustedContext(): ToolExecutionScope {
  return {
    spaceId: "space-1",
    userId: "user-1",
    agentSource: "claude-code",
    sessionId: "session-1",
    contextVersion: "v1",
  };
}

function bridgeResult(body: unknown, status = 200): MemoryBridgeExecutionResult {
  return {
    status,
    contentType: "application/json",
    text: JSON.stringify(body),
  };
}

function dispatcherWithBridge(
  executeBridge: ConstructorParameters<typeof NativeProxyToolDispatcher>[0]["executeBridge"],
) {
  return new NativeProxyToolDispatcher({
    config: config(),
    registry: createDefaultNativeProxyToolRegistry(),
    executeBridge,
  });
}

describe("NativeProxyToolDispatcher", () => {
  it("validates and defaults input through the Registry before invoking Memory Bridge", async () => {
    const executeBridge = vi.fn(async () => bridgeResult({
      code: 0,
      message: "ok",
      request_id: "request-1",
      data: { items: [{ id: "memory-1", content: "rule" }] },
    }));
    const dispatcher = dispatcherWithBridge(executeBridge);

    const result = await dispatcher.execute(memoryCall({ query: "  rules  " }), trustedContext());

    expect(executeBridge).toHaveBeenCalledWith(expect.objectContaining({
      subpath: "atomic/search",
      body: { query: "rules", limit: 5 },
      sessionId: "session-1",
      spaceId: "space-1",
      signal: expect.any(AbortSignal),
    }), expect.anything());
    expect(result).toEqual({
      isError: false,
      value: { items: [{ id: "memory-1", content: "rule" }] },
    });
  });

  it("rejects invalid schema input without invoking Memory Bridge", async () => {
    const executeBridge = vi.fn();
    const result = await dispatcherWithBridge(executeBridge)
      .execute(memoryCall({ query: "rules", user_id: "attacker" }), trustedContext());

    expect(result.isError).toBe(true);
    expect(result.value).toMatchObject({
      code: "invalid_tool_arguments",
      retryable: false,
    });
    expect(executeBridge).not.toHaveBeenCalled();
  });

  it("returns a sanitized error without an exception stack", async () => {
    const dispatcher = dispatcherWithBridge(async () => {
      throw new Error("secret stack detail and Bearer service-token");
    });
    const result = await dispatcher.execute(memoryCall(), trustedContext());

    expect(result.isError).toBe(true);
    expect(result.value).toMatchObject({
      code: "memory_bridge_unavailable",
      message: "Memory search is temporarily unavailable",
      retryable: true,
    });
    expect(JSON.stringify(result.value)).not.toContain("secret stack detail");
    expect(JSON.stringify(result.value)).not.toContain("service-token");
  });

  it("enforces the configured timeout even when the Bridge ignores abort", async () => {
    const dispatcher = dispatcherWithBridge(async () => new Promise<MemoryBridgeExecutionResult>(() => {}));
    const startedAt = Date.now();
    const result = await dispatcher.execute(memoryCall(), trustedContext());

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result).toEqual({
      isError: true,
      value: {
        code: "memory_bridge_timeout",
        message: "Memory search timed out",
        retryable: true,
      },
    });
  });

  it("maps HTTP and business envelope failures to stable errors", async () => {
    const httpFailure = await dispatcherWithBridge(async () => bridgeResult({
      code: 50301,
      message: "internal endpoint and secret",
      request_id: "request-http",
    }, 502)).execute(memoryCall(), trustedContext());
    const businessFailure = await dispatcherWithBridge(async () => bridgeResult({
      code: 42001,
      message: "internal validation detail",
      request_id: "request-business",
    })).execute(memoryCall(), trustedContext());

    expect(httpFailure).toEqual({
      isError: true,
      value: {
        code: "memory_bridge_unavailable",
        message: "Memory search is temporarily unavailable",
        request_id: "request-http",
        retryable: true,
      },
    });
    expect(businessFailure).toEqual({
      isError: true,
      value: {
        code: "memory_search_failed",
        message: "Memory search failed",
        request_id: "request-business",
        retryable: false,
      },
    });
  });

  it("returns a bounded UTF-8-safe omission object for oversized results", async () => {
    const dispatcher = dispatcherWithBridge(async () => bridgeResult({
      code: 0,
      data: { items: [{ content: "记忆🧠".repeat(2_000) }] },
    }));

    const result = await dispatcher.execute(memoryCall(), trustedContext());
    const serialized = JSON.stringify(result.value);

    expect(result.isError).toBe(false);
    expect(result.value).toMatchObject({
      code: "result_too_large",
      content_omitted: true,
      original_bytes: expect.any(Number),
      preview: expect.any(String),
    });
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(1_024);
    expect(serialized).not.toContain("�");
  });

  it("rejects parse errors and non-proxy calls before Registry dispatch", async () => {
    const executeBridge = vi.fn();
    const dispatcher = dispatcherWithBridge(executeBridge);
    const malformed = memoryCall();
    malformed.parseError = { code: "invalid_tool_input_json", message: "bad JSON" };
    const clientCall = { ...memoryCall(), owner: "client" as const };

    expect(await dispatcher.execute(malformed, trustedContext())).toMatchObject({ isError: true });
    expect(await dispatcher.execute(clientCall, trustedContext())).toMatchObject({ isError: true });
    expect(executeBridge).not.toHaveBeenCalled();
  });
});
