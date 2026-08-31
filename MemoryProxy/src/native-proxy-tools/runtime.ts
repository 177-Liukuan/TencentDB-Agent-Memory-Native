import { createHash } from "node:crypto";

import { ClickHouseToolExecutionStorageAdapter } from "../db/clickhouse-tool-execution-storage-adapter.js";
import type { ToolExecutionStorageAdapter } from "../db/tool-execution-storage-adapter.js";
import type { UnifiedToolCall } from "../injection/adapters/interface.js";
import type { ProxyConfig } from "../types.js";
import { NativeProxyToolDispatcher } from "./native-proxy-tool-dispatcher.js";
import {
  createDefaultNativeProxyToolRegistry,
  type NativeProxyToolRegistry,
} from "./tool-registry.js";
import type { NativeToolResult, ToolExecutionScope } from "./types.js";

export interface NativeProxyToolExecutor {
  execute(call: UnifiedToolCall, scope: ToolExecutionScope): Promise<NativeToolResult>;
}

export interface NativeProxyToolRuntimeReadiness {
  ready: boolean;
  failed: boolean;
  message?: string;
}

export interface NativeProxyToolRuntime {
  enabled: boolean;
  registry: NativeProxyToolRegistry;
  storage: ToolExecutionStorageAdapter | null;
  dispatcher: NativeProxyToolExecutor | null;
  ready(): Promise<void>;
  readiness(): NativeProxyToolRuntimeReadiness;
  close(): Promise<void>;
}

export interface NativeProxyToolRuntimeDependencies {
  createStorage?(config: ProxyConfig): ToolExecutionStorageAdapter;
  createRegistry?(): NativeProxyToolRegistry;
  createDispatcher?(input: {
    config: ProxyConfig;
    registry: NativeProxyToolRegistry;
  }): NativeProxyToolExecutor;
}

class NativeProxyToolRuntimeUnavailableError extends Error {
  constructor() {
    super("Native Proxy Tool state storage is unavailable");
    this.name = "NativeProxyToolRuntimeUnavailableError";
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function runtimeKey(config: ProxyConfig): string {
  const relevant = {
    nativeProxyTools: config.nativeProxyTools,
    clickhouse: config.clickhouse,
    coreSkill: config.coreSkill,
    tdai: config.tdai,
  };
  return createHash("sha256")
    .update(JSON.stringify(stableValue(relevant)))
    .digest("hex");
}

export function createNativeProxyToolRuntime(
  config: ProxyConfig,
  dependencies: NativeProxyToolRuntimeDependencies = {},
): NativeProxyToolRuntime {
  const registry = dependencies.createRegistry?.() ?? createDefaultNativeProxyToolRegistry();
  if (!config.nativeProxyTools.enabled) {
    return {
      enabled: false,
      registry,
      storage: null,
      dispatcher: null,
      ready: async () => {},
      readiness: () => ({ ready: true, failed: false }),
      close: async () => {},
    };
  }

  const storage = dependencies.createStorage?.(config)
    ?? new ClickHouseToolExecutionStorageAdapter(config);
  const baseDispatcher = dependencies.createDispatcher?.({ config, registry })
    ?? new NativeProxyToolDispatcher({ config, registry });
  const pendingExecutions = new Set<Promise<NativeToolResult>>();
  let initialization: Promise<void> | undefined;
  let initialized = false;
  let failed = false;
  let closed = false;

  const dispatcher: NativeProxyToolExecutor = {
    execute(call, scope) {
      if (closed) return Promise.reject(new NativeProxyToolRuntimeUnavailableError());
      const operation = baseDispatcher.execute(call, scope);
      pendingExecutions.add(operation);
      void operation.then(
        () => pendingExecutions.delete(operation),
        () => pendingExecutions.delete(operation),
      );
      return operation;
    },
  };

  const ready = async (): Promise<void> => {
    if (closed) throw new NativeProxyToolRuntimeUnavailableError();
    if (!initialization) {
      initialization = storage.initializeAndProbe().then(
        () => {
          initialized = true;
          failed = false;
        },
        () => {
          initialized = false;
          failed = true;
          throw new NativeProxyToolRuntimeUnavailableError();
        },
      );
    }
    await initialization;
  };

  return {
    enabled: true,
    registry,
    storage,
    dispatcher,
    ready,
    readiness: () => ({
      ready: initialized,
      failed,
      ...(!initialized && failed
        ? { message: "Native Proxy Tool state storage is unavailable" }
        : {}),
    }),
    close: async () => {
      if (closed) return;
      closed = true;
      await initialization?.catch(() => {});
      while (pendingExecutions.size > 0) {
        await Promise.allSettled([...pendingExecutions]);
      }
      await storage.close();
    },
  };
}

const runtimes = new Map<string, NativeProxyToolRuntime>();
let testRuntime: NativeProxyToolRuntime | undefined;

export function getNativeProxyToolRuntime(config: ProxyConfig): NativeProxyToolRuntime {
  if (testRuntime) return testRuntime;
  const key = runtimeKey(config);
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = createNativeProxyToolRuntime(config);
    runtimes.set(key, runtime);
  }
  return runtime;
}

export async function initializeNativeProxyToolRuntime(
  config: ProxyConfig,
): Promise<NativeProxyToolRuntime> {
  const runtime = getNativeProxyToolRuntime(config);
  await runtime.ready();
  return runtime;
}

export async function shutdownNativeProxyToolRuntime(): Promise<void> {
  const owned = new Set(runtimes.values());
  if (testRuntime) owned.add(testRuntime);
  runtimes.clear();
  testRuntime = undefined;
  await Promise.all([...owned].map((runtime) => runtime.close().catch(() => {})));
}

/** Inject an explicitly constructed runtime without enabling a fallback. */
export function __setNativeProxyToolRuntimeForTests(
  runtime: NativeProxyToolRuntime,
): void {
  testRuntime = runtime;
}

export function __resetNativeProxyToolRuntimeForTests(): void {
  runtimes.clear();
  testRuntime = undefined;
}
