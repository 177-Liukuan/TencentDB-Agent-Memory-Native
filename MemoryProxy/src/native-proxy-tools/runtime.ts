import { createHash } from "node:crypto";

import { ClickHouseToolExecutionStorageAdapter } from "../db/clickhouse-tool-execution-storage-adapter.js";
import { ClickHouseNativeToolLedgerStorageAdapter } from "../db/clickhouse-native-tool-ledger-storage-adapter.js";
import { InMemoryNativeToolLedgerStorageAdapter } from "../db/in-memory-native-tool-ledger-storage-adapter.js";
import type { NativeToolLedgerStorageAdapter } from "../db/native-tool-ledger-storage-adapter.js";
import type { ToolExecutionStorageAdapter } from "../db/tool-execution-storage-adapter.js";
import type { UnifiedToolCall } from "../injection/adapters/interface.js";
import type { ProxyConfig } from "../types.js";
import { NativeProxyToolDispatcher } from "./native-proxy-tool-dispatcher.js";
import {
  createDefaultNativeProxyToolRegistry,
  type NativeProxyToolRegistry,
} from "./tool-registry.js";
import type {
  NativeToolResult,
  ToolExecutionScope,
  ToolExecutionStateKey,
} from "./types.js";
import type { NativeReentryRequest, UpstreamRound } from "./tool-loop-coordinator.js";

export type NativeReentryTransport = (
  request: NativeReentryRequest,
) => Promise<UpstreamRound>;

/** Hard bound for credential-bearing exact-target transports retained in-process. */
export const NATIVE_RETAINED_TARGET_LIMIT = 1_024;

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
  ledgerStorage: NativeToolLedgerStorageAdapter | null;
  dispatcher: NativeProxyToolExecutor | null;
  ready(): Promise<void>;
  readiness(): NativeProxyToolRuntimeReadiness;
  retainExactTarget(
    key: ToolExecutionStateKey,
    transport: NativeReentryTransport,
  ): void;
  getRetainedExactTarget(
    key: ToolExecutionStateKey,
  ): NativeReentryTransport | undefined;
  releaseExactTarget(key: ToolExecutionStateKey): void;
  runOperation<T>(operation: () => Promise<T>): Promise<T>;
  trackBackgroundOperation<T>(operation: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface NativeProxyToolRuntimeDependencies {
  createStorage?(config: ProxyConfig): ToolExecutionStorageAdapter;
  createLedgerStorage?(config: ProxyConfig): NativeToolLedgerStorageAdapter;
  createRegistry?(): NativeProxyToolRegistry;
  createDispatcher?(input: {
    config: ProxyConfig;
    registry: NativeProxyToolRegistry;
  }): NativeProxyToolExecutor;
  now?(): Date;
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
    knowledge: config.knowledge,
    tdai: config.tdai,
  };
  return createHash("sha256")
    .update(JSON.stringify(stableValue(relevant)))
    .digest("hex");
}

function retainedTargetKey(key: ToolExecutionStateKey): string {
  return JSON.stringify([
    key.spaceId,
    key.userId,
    key.agentSource,
    key.sessionId,
    key.contextVersion,
    key.toolBatchId,
  ]);
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
      ledgerStorage: null,
      dispatcher: null,
      ready: async () => {},
      readiness: () => ({ ready: true, failed: false }),
      retainExactTarget: () => {},
      getRetainedExactTarget: () => undefined,
      releaseExactTarget: () => {},
      runOperation: (operation) => operation(),
      trackBackgroundOperation: (operation) => operation(),
      close: async () => {},
    };
  }

  // 短期 storage 管理执行中的状态和租约；ledgerStorage 保存完成后仍需补给模型的隐藏历史。
  // 生产环境两者都使用 ClickHouse，任一探测失败都会关闭 Native Tool 能力，不能降级到进程内状态。
  const storage = dependencies.createStorage?.(config)
    ?? new ClickHouseToolExecutionStorageAdapter(config);
  const ledgerStorage = dependencies.createLedgerStorage?.(config)
    ?? (dependencies.createStorage
      ? new InMemoryNativeToolLedgerStorageAdapter()
      : new ClickHouseNativeToolLedgerStorageAdapter(config));
  const baseDispatcher = dependencies.createDispatcher?.({ config, registry })
    ?? new NativeProxyToolDispatcher({ config, registry });
  const pendingExecutions = new Set<Promise<NativeToolResult>>();
  const pendingOperations = new Set<Promise<unknown>>();
  const retainedTargets = new Map<string, {
    transport: NativeReentryTransport;
    expiresAt: number;
  }>();
  const now = dependencies.now ?? (() => new Date());
  const sweepRetainedTargets = (currentTime: number): void => {
    for (const [key, retained] of retainedTargets) {
      if (retained.expiresAt <= currentTime) retainedTargets.delete(key);
    }
  };
  let initialization: Promise<void> | undefined;
  let initialized = false;
  let failed = false;
  let closed = false;
  let admitting = true;
  let closing: Promise<void> | undefined;

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
    if (closed || !admitting) throw new NativeProxyToolRuntimeUnavailableError();
    if (!initialization) {
      const probe = Promise.all([
        storage.initializeAndProbe(),
        ledgerStorage.initializeAndProbe(),
      ]).then(
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
      initialization = probe;
      void probe.catch(() => {
        if (initialization === probe) initialization = undefined;
      });
    }
    await initialization;
  };

  const trackOperation = <T>(
    operation: () => Promise<T>,
    requireAdmission: boolean,
  ): Promise<T> => {
    if (closed || (requireAdmission && !admitting)) {
      return Promise.reject(new NativeProxyToolRuntimeUnavailableError());
    }
    let running: Promise<T>;
    try {
      running = operation();
    } catch (error) {
      return Promise.reject(error);
    }
    pendingOperations.add(running);
    void running.then(
      () => pendingOperations.delete(running),
      () => pendingOperations.delete(running),
    );
    return running;
  };
  const runOperation = <T>(operation: () => Promise<T>): Promise<T> => (
    trackOperation(operation, true)
  );
  const close = (): Promise<void> => {
    if (closing) return closing;
    admitting = false;
    closing = (async () => {
      await initialization?.catch(() => {});
      while (pendingOperations.size > 0) {
        await Promise.allSettled([...pendingOperations]);
      }
      while (pendingExecutions.size > 0) {
        await Promise.allSettled([...pendingExecutions]);
      }
      retainedTargets.clear();
      closed = true;
      await Promise.all([storage.close(), ledgerStorage.close()]);
    })();
    return closing;
  };

  return {
    enabled: true,
    registry,
    storage,
    ledgerStorage,
    dispatcher,
    ready,
    readiness: () => ({
      ready: initialized,
      failed,
      ...(!initialized && failed
        ? { message: "Native Proxy Tool state storage is unavailable" }
        : {}),
    }),
    retainExactTarget: (key, transport) => {
      if (!admitting || closed) return;
      const currentTime = now().getTime();
      sweepRetainedTargets(currentTime);
      const serializedKey = retainedTargetKey(key);
      retainedTargets.delete(serializedKey);
      while (retainedTargets.size >= NATIVE_RETAINED_TARGET_LIMIT) {
        const oldestKey = retainedTargets.keys().next().value as string | undefined;
        if (oldestKey === undefined) break;
        retainedTargets.delete(oldestKey);
      }
      retainedTargets.set(serializedKey, {
        transport,
        expiresAt: currentTime + config.nativeProxyTools.stateTtlSeconds * 1_000,
      });
    },
    getRetainedExactTarget: (stateKey) => {
      const currentTime = now().getTime();
      sweepRetainedTargets(currentTime);
      const key = retainedTargetKey(stateKey);
      const retained = retainedTargets.get(key);
      if (!retained) return undefined;
      return retained.transport;
    },
    releaseExactTarget: (stateKey) => {
      retainedTargets.delete(retainedTargetKey(stateKey));
    },
    runOperation,
    // A coordinator admitted before shutdown may discover Native work only
    // after content_block_stop. Admit that child operation and let close()
    // drain it; new top-level requests still fail through runOperation().
    trackBackgroundOperation: (operation) => trackOperation(operation, false),
    close,
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
