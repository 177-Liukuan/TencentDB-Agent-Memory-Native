import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import { InMemoryToolExecutionStorageAdapter } from "../../db/in-memory-tool-execution-storage-adapter.js";
import {
  __resetNativeProxyToolRuntimeForTests,
  createNativeProxyToolRuntime,
  getNativeProxyToolRuntime,
  initializeNativeProxyToolRuntime,
  shutdownNativeProxyToolRuntime,
} from "../runtime.js";

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

  it("keeps readiness failure visible and never installs a fallback backend", async () => {
    const storage = new InMemoryToolExecutionStorageAdapter();
    vi.spyOn(storage, "initializeAndProbe").mockRejectedValue(new Error("secret clickhouse detail"));
    const runtime = createNativeProxyToolRuntime(config(), { createStorage: () => storage });

    await expect(runtime.ready()).rejects.toThrow(/unavailable/i);
    expect(runtime.readiness()).toMatchObject({ ready: false, failed: true });
    expect(runtime.readiness().message).not.toContain("secret clickhouse detail");
    expect(runtime.storage).toBe(storage);
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
});
