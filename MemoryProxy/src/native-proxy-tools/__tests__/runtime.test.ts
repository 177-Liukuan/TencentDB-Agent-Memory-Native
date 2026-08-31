import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import { InMemoryToolExecutionStorageAdapter } from "../../db/in-memory-tool-execution-storage-adapter.js";
import {
  __resetNativeProxyToolRuntimeForTests,
  createNativeProxyToolRuntime,
  getNativeProxyToolRuntime,
  initializeNativeProxyToolRuntime,
  NATIVE_RETAINED_TARGET_LIMIT,
  shutdownNativeProxyToolRuntime,
} from "../runtime.js";
import type { NativeReentryRequest, UpstreamRound } from "../tool-loop-coordinator.js";

afterEach(async () => {
  await shutdownNativeProxyToolRuntime();
  __resetNativeProxyToolRuntimeForTests();
});

function config(enabled = true) {
  const value = structuredClone(DEFAULT_CONFIG);
  value.nativeProxyTools.enabled = enabled;
  value.clickhouse.enabled = enabled;
  value.clickhouse.url = enabled ? "http://clickhouse.internal:8123" : "";
  return value;
}

describe("Native Proxy Tool runtime", () => {
  it("returns a lightweight disabled runtime without opening storage", async () => {
    const createStorage = vi.fn(() => new InMemoryToolExecutionStorageAdapter());
    const runtime = createNativeProxyToolRuntime(config(false), { createStorage });

    await expect(runtime.ready()).resolves.toBeUndefined();
    expect(runtime.enabled).toBe(false);
    expect(runtime.storage).toBeNull();
    expect(runtime.dispatcher).toBeNull();
    expect(createStorage).not.toHaveBeenCalled();
  });

  it("probes enabled storage before reporting readiness and closes it", async () => {
    const storage = new InMemoryToolExecutionStorageAdapter();
    const initialize = vi.spyOn(storage, "initializeAndProbe");
    const close = vi.spyOn(storage, "close");
    const runtime = createNativeProxyToolRuntime(config(), { createStorage: () => storage });

    await runtime.ready();
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(runtime.storage).toBe(storage);
    expect(runtime.dispatcher).not.toBeNull();
    await runtime.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent shutdown calls into one storage close", async () => {
    const storage = new InMemoryToolExecutionStorageAdapter();
    const close = vi.spyOn(storage, "close");
    const runtime = createNativeProxyToolRuntime(config(), { createStorage: () => storage });
    await runtime.ready();

    await Promise.all([runtime.close(), runtime.close(), runtime.close()]);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps readiness failure visible and never installs a fallback backend", async () => {
    const storage = new InMemoryToolExecutionStorageAdapter();
    vi.spyOn(storage, "initializeAndProbe").mockRejectedValue(new Error("secret clickhouse detail"));
    const runtime = createNativeProxyToolRuntime(config(), { createStorage: () => storage });

    await expect(runtime.ready()).rejects.toThrow(/unavailable/i);
    expect(runtime.readiness()).toMatchObject({ ready: false, failed: true });
    expect(runtime.readiness().message).not.toContain("secret clickhouse detail");
    expect(runtime.storage).toBe(storage);
  });

  it("allows a later readiness probe to recover after a transient failure", async () => {
    const storage = new InMemoryToolExecutionStorageAdapter();
    const initialize = vi.spyOn(storage, "initializeAndProbe")
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValueOnce();
    const runtime = createNativeProxyToolRuntime(config(), { createStorage: () => storage });

    await expect(runtime.ready()).rejects.toThrow(/unavailable/i);
    await expect(runtime.ready()).resolves.toBeUndefined();
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(runtime.readiness()).toEqual({ ready: true, failed: false });
  });

  it("retains exact transports per batch even when scope and target are identical", async () => {
    let currentTime = Date.parse("2026-08-31T00:00:00.000Z");
    const runtimeConfig = config();
    runtimeConfig.nativeProxyTools.stateTtlSeconds = 2;
    const runtime = createNativeProxyToolRuntime(runtimeConfig, {
      createStorage: () => new InMemoryToolExecutionStorageAdapter(),
      now: () => new Date(currentTime),
    });
    const trustedScope = {
      spaceId: "space-1",
      userId: "user-1",
      agentSource: "claude-code",
      sessionId: "session-1",
      contextVersion: "v1",
    };
    const firstKey = { ...trustedScope, toolBatchId: "batch-1" };
    const secondKey = { ...trustedScope, toolBatchId: "batch-2" };
    const firstTransport = vi.fn(async (_request: NativeReentryRequest): Promise<UpstreamRound> => ({
      stream: new ReadableStream<Uint8Array>(),
      status: 200,
      headers: new Headers(),
    }));
    const secondTransport = vi.fn(async (_request: NativeReentryRequest): Promise<UpstreamRound> => ({
      stream: new ReadableStream<Uint8Array>(),
      status: 200,
      headers: new Headers(),
    }));

    runtime.retainExactTarget(firstKey, firstTransport);
    runtime.retainExactTarget(secondKey, secondTransport);
    expect(runtime.getRetainedExactTarget(firstKey)).toBe(firstTransport);
    expect(runtime.getRetainedExactTarget(secondKey)).toBe(secondTransport);
    expect(runtime.getRetainedExactTarget({ ...firstKey, userId: "other" })).toBeUndefined();

    runtime.releaseExactTarget(firstKey);
    expect(runtime.getRetainedExactTarget(firstKey)).toBeUndefined();
    expect(runtime.getRetainedExactTarget(secondKey)).toBe(secondTransport);

    currentTime += 2_001;
    expect(runtime.getRetainedExactTarget(secondKey)).toBeUndefined();
  });

  it("bounds abandoned retained transports and evicts the oldest batch", () => {
    const runtime = createNativeProxyToolRuntime(config(), {
      createStorage: () => new InMemoryToolExecutionStorageAdapter(),
    });
    const trustedScope = {
      spaceId: "space-1",
      userId: "user-1",
      agentSource: "claude-code",
      sessionId: "session-1",
      contextVersion: "v1",
    };
    const transport = vi.fn(async (_request: NativeReentryRequest): Promise<UpstreamRound> => ({
      stream: new ReadableStream<Uint8Array>(),
      status: 200,
      headers: new Headers(),
    }));
    const keys = Array.from({ length: NATIVE_RETAINED_TARGET_LIMIT + 1 }, (_, index) => ({
      ...trustedScope,
      toolBatchId: `abandoned-${index}`,
    }));

    for (const key of keys) runtime.retainExactTarget(key, transport);

    expect(runtime.getRetainedExactTarget(keys[0])).toBeUndefined();
    expect(runtime.getRetainedExactTarget(keys.at(-1)!)).toBe(transport);
  });

  it("caches by stable relevant config and shuts down every owned runtime", async () => {
    const firstConfig = config(false);
    const first = getNativeProxyToolRuntime(firstConfig);
    const same = getNativeProxyToolRuntime(structuredClone(firstConfig));
    const changedConfig = structuredClone(firstConfig);
    changedConfig.nativeProxyTools.stateStorage.table = "native_proxy_tool_execution_state_v2";
    const changed = getNativeProxyToolRuntime(changedConfig);

    expect(same).toBe(first);
    expect(changed).not.toBe(first);
    await expect(initializeNativeProxyToolRuntime(config(false))).resolves.toMatchObject({
      enabled: false,
    });
    await shutdownNativeProxyToolRuntime();
  });

  it("waits for tracked read-only executions before closing state storage", async () => {
    const storage = new InMemoryToolExecutionStorageAdapter();
    let release!: () => void;
    const execution = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await execution;
      return { isError: false, value: { memories: [] as string[] } };
    });
    const runtime = createNativeProxyToolRuntime(config(), {
      createStorage: () => storage,
      createDispatcher: () => ({ execute }),
    });
    await runtime.ready();

    const running = runtime.dispatcher!.execute({
      callId: "p1",
      toolName: "tdai_memory_search",
      owner: "proxy",
      slotIndex: 0,
      contentBlockIndex: 0,
      argumentsComplete: true,
      input: { query: "rules" },
    }, {
      spaceId: "space-1",
      userId: "user-1",
      agentSource: "claude-code",
      sessionId: "session-1",
      contextVersion: "v1",
    });
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    let closed = false;
    const closing = runtime.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);

    release();
    await running;
    await closing;
    expect(closed).toBe(true);
  });

  it("waits for a tracked coordinator operation before closing storage", async () => {
    const storage = new InMemoryToolExecutionStorageAdapter();
    const close = vi.spyOn(storage, "close");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createNativeProxyToolRuntime(config(), { createStorage: () => storage });
    await runtime.ready();
    const running = runtime.runOperation(async () => {
      await gate;
      return "done";
    });

    const closing = runtime.close();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    release();
    await expect(running).resolves.toBe("done");
    await closing;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("admits and drains child persistence discovered by an already-running coordinator during shutdown", async () => {
    const storage = new InMemoryToolExecutionStorageAdapter();
    const close = vi.spyOn(storage, "close");
    let releaseCoordinator!: () => void;
    let releasePersistence!: () => void;
    const coordinatorGate = new Promise<void>((resolve) => { releaseCoordinator = resolve; });
    const persistenceGate = new Promise<void>((resolve) => { releasePersistence = resolve; });
    const runtime = createNativeProxyToolRuntime(config(), { createStorage: () => storage });
    await runtime.ready();
    let persistence: Promise<string> | undefined;
    const coordinator = runtime.runOperation(async () => {
      await coordinatorGate;
      persistence = runtime.trackBackgroundOperation(async () => {
        await persistenceGate;
        return "persisted";
      });
      return "coordinated";
    });

    const closing = runtime.close();
    releaseCoordinator();
    await expect(coordinator).resolves.toBe("coordinated");
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    expect(persistence).toBeDefined();
    releasePersistence();
    await expect(persistence).resolves.toBe("persisted");
    await closing;
    expect(close).toHaveBeenCalledTimes(1);
  });
});
