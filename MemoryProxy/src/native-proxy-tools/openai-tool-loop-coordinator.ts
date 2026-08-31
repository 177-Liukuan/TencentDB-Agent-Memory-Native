import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { isReplaySafeResponseHeader, type ToolExecutionStorageAdapter } from "../db/tool-execution-storage-adapter.js";
import { OpenAIStreamParser, type OpenAIStreamSnapshot } from "../injection/adapters/openai-stream.js";
import type { UnifiedToolCall } from "../injection/adapters/interface.js";
import { assertNoNativeToolLeak, buildNativeRegistryLeakMarkers, mergeNativeToolLeakMarkers } from "./anthropic-response-rebuilder.js";
import type { NativeProxyToolDispatcher } from "./native-proxy-tool-dispatcher.js";
import { buildClientVisibleOpenAISse, buildOpenAIToolMessages } from "./openai-response-rebuilder.js";
import type { NativeProxyToolRegistry } from "./tool-registry.js";
import { nativeToolLeaseDurationMs } from "./types.js";
import type {
  JsonValue, NativeProxyToolsConfig, NativeToolResult, PersistedResponseSnapshot,
  ToolCallSlot, ToolExecutionContext, ToolExecutionScope, ToolExecutionStateKey,
  UpstreamRequestSnapshot,
} from "./types.js";
import type { NativeReentryRequest, UpstreamRound } from "./tool-loop-coordinator.js";

export interface OpenAIToolLoopRoundInput extends UpstreamRound {
  scope: ToolExecutionScope;
  turnSeq: number;
  upstreamSnapshot: UpstreamRequestSnapshot;
  round: number;
  totalCalls: number;
  parentStateKey?: ToolExecutionStateKey;
  parentReentryAttempt?: number;
}

export type OpenAIToolLoopDecision =
  | { kind: "replay" | "final"; bytes: Uint8Array; status: number; headers: Headers; rounds: OpenAIStreamSnapshot[]; observationStateKey?: ToolExecutionStateKey }
  | { kind: "client_dispatch"; stateKey: ToolExecutionStateKey; bytes: Uint8Array; status: number; headers: Headers; rounds: OpenAIStreamSnapshot[] }
  | { kind: "error"; code: string; message: string; bytes: Uint8Array; status: number; headers: Headers; rounds: OpenAIStreamSnapshot[] };

export interface OpenAIToolLoopCoordinatorOptions {
  registry: NativeProxyToolRegistry;
  storage: ToolExecutionStorageAdapter;
  dispatcher: Pick<NativeProxyToolDispatcher, "execute">;
  limits: NativeProxyToolsConfig;
  reenter(request: NativeReentryRequest): Promise<UpstreamRound>;
  now?: () => Date;
  createId?: () => string;
  maxStorageAttempts?: number;
  trackBackgroundOperation?(operation: () => Promise<void>): Promise<void>;
  beforeReenter?(): Promise<void>;
  beforeClientDispatch?(): Promise<void>;
  onClientDispatchPrepared?(dispatch: {
    stateKey: ToolExecutionStateKey;
    bytes: Uint8Array;
    status: number;
    headers: Headers;
  }): Promise<void>;
}

class OpenAICoordinatorFailure extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

function slots(calls: readonly UnifiedToolCall[]): ToolCallSlot[] {
  return calls.map((call) => ({
    callId: call.callId, slotIndex: call.slotIndex, contentBlockIndex: call.contentBlockIndex,
    toolName: call.toolName, owner: call.owner,
    ...(call.input !== undefined ? { input: structuredClone(call.input) } : {}),
    argumentsComplete: true, status: "pending", executionAttempt: 0,
  }));
}

function assistantSkeleton(calls: readonly UnifiedToolCall[]): JsonValue[] {
  return [...calls].sort((a, b) => a.slotIndex - b.slotIndex).map((call) => ({
    id: call.callId, type: "function", function: {
      name: call.toolName, arguments: JSON.stringify(call.input ?? {}),
    },
  }));
}

function persistedResponse(bytes: Uint8Array, status: number, source: Headers): PersistedResponseSnapshot {
  const headers: Record<string, string> = {};
  for (const [name, value] of source) if (isReplaySafeResponseHeader(name.toLowerCase())) headers[name.toLowerCase()] = value;
  return { status, headers, bodyBase64: Buffer.from(bytes).toString("base64") };
}

function genericExecutionError(): NativeToolResult {
  return { isError: true, value: { code: "native_tool_execution_failed", message: "Native Proxy Tool execution failed", retryable: true } };
}

export class OpenAIToolLoopCoordinator {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly maxStorageAttempts: number;

  constructor(private readonly options: OpenAIToolLoopCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.maxStorageAttempts = options.maxStorageAttempts ?? 8;
  }

  async handleRound(input: OpenAIToolLoopRoundInput): Promise<OpenAIToolLoopDecision> {
    const decision = await this.handleRoundInternal(input, false);
    try {
      assertNoNativeToolLeak(decision.bytes, buildNativeRegistryLeakMarkers(this.options.registry));
    } catch {
      return this.error("native_tool_leak_detected", "Native Proxy Tool response could not be returned safely", 500, []);
    }
    if (decision.kind === "final" && decision.observationStateKey) {
      const ok = await this.prepareObservation(
        decision.observationStateKey,
        persistedResponse(decision.bytes, decision.status, decision.headers),
      ).catch(() => false);
      if (!ok) return this.error("native_tool_state_unavailable", "Native Proxy Tool observation could not be prepared", 503, decision.rounds);
    }
    return decision;
  }

  private async handleRoundInternal(input: OpenAIToolLoopRoundInput, internal: boolean): Promise<OpenAIToolLoopDecision> {
    if (input.status < 200 || input.status >= 300) {
      await this.drain(input.stream).catch(() => {});
      return this.error("upstream_non_2xx", "OpenAI upstream returned an error response", input.status, []);
    }
    const parser = new OpenAIStreamParser(this.options.registry);
    try {
      const reader = input.stream.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          const events = parser.push(next.value);
          if (events.some((event) => event.type === "protocol_error")) {
            await reader.cancel().catch(() => {});
            return this.error("upstream_stream_invalid", "OpenAI upstream returned an invalid event stream", 502, [parser.snapshot()]);
          }
        }
      } catch {
        return this.error("upstream_stream_interrupted", "OpenAI upstream stream was interrupted", 502, [parser.snapshot()]);
      } finally {
        reader.releaseLock();
      }
      const finishEvents = parser.finish();
      if (finishEvents.some((event) => event.type === "protocol_error")) {
        return this.error("upstream_stream_incomplete", "OpenAI upstream stream ended before the round boundary", 502, [parser.snapshot()]);
      }
      const snapshot = parser.snapshot();
      const nativeCalls = snapshot.toolCalls.filter((call) => call.owner === "proxy");
      const clientCalls = snapshot.toolCalls.filter((call) => call.owner === "client");
      if (nativeCalls.length === 0) {
        return {
          kind: internal ? "final" : "replay", bytes: snapshot.rawBytes, status: input.status,
          headers: new Headers(input.headers), rounds: [snapshot],
        };
      }
      if (
        input.round > this.options.limits.maxRounds
        || nativeCalls.length > this.options.limits.maxCallsPerRound
        || input.totalCalls + nativeCalls.length > this.options.limits.maxTotalCalls
      ) return this.error("native_tool_limit_exceeded", "Native Proxy Tool loop limit exceeded", 400, [snapshot]);

      const stateKey = await this.createBatch(input, snapshot.toolCalls);
      const executionTasks = new Map<string, Promise<void>>();
      for (const call of nativeCalls) {
        const operation = () => this.executeAndPersist(call, input.scope, stateKey);
        const task = (this.options.trackBackgroundOperation
          ? this.options.trackBackgroundOperation(operation)
          : operation()).catch(() => {});
        executionTasks.set(call.callId, task);
      }
      const totalCalls = input.totalCalls + nativeCalls.length;
      if (clientCalls.length > 0) {
        await this.options.beforeClientDispatch?.();
        const bytes = buildClientVisibleOpenAISse(snapshot.rawBytes, new Set(nativeCalls.map((call) => call.contentBlockIndex)));
        assertNoNativeToolLeak(bytes, [...nativeCalls, ...buildNativeRegistryLeakMarkers(this.options.registry)]);
        const outcome = persistedResponse(bytes, input.status, input.headers);
        const pending = await this.transitionDispatch(stateKey, "none", "pending", outcome);
        if (pending) {
          await this.options.onClientDispatchPrepared?.({
            stateKey,
            bytes,
            status: input.status,
            headers: new Headers(input.headers),
          });
        }
        const dispatched = pending && await this.transitionDispatch(stateKey, "pending", "dispatched");
        if (!dispatched) return this.error("client_tool_dispatch_conflict", "Client Tool batch has already been dispatched", 409, [snapshot]);
        return { kind: "client_dispatch", stateKey, bytes, status: input.status, headers: new Headers(input.headers), rounds: [snapshot] };
      }

      await Promise.all(executionTasks.values());
      const context = await this.options.storage.get(stateKey);
      if (!context || context.slots.some((slot) => slot.owner === "proxy" && !["succeeded", "failed"].includes(slot.status))) {
        return this.error("native_tool_result_unavailable", "Native Proxy Tool result could not be persisted", 503, [snapshot]);
      }
      const messages = [
        ...structuredClone(input.upstreamSnapshot.baseMessages),
        ...buildOpenAIToolMessages(context.slots),
      ];
      await this.options.beforeReenter?.();
      const next = await this.options.reenter({
        upstreamSnapshot: structuredClone(input.upstreamSnapshot), messages: structuredClone(messages),
        round: input.round + 1, totalCalls,
      });
      const nextDecision = await this.handleRoundInternal({
        ...next, scope: input.scope, turnSeq: input.turnSeq,
        upstreamSnapshot: {
          ...structuredClone(input.upstreamSnapshot), baseMessages: structuredClone(messages),
          nativeLeakMarkers: mergeNativeToolLeakMarkers(
            input.upstreamSnapshot.nativeLeakMarkers ?? [],
            nativeCalls.map((call) => ({ callId: call.callId, toolName: call.toolName, ...(call.input !== undefined ? { input: call.input } : {}) })),
          ),
        },
        round: input.round + 1, totalCalls,
        ...(input.parentStateKey && input.parentReentryAttempt !== undefined
          ? { parentStateKey: input.parentStateKey, parentReentryAttempt: input.parentReentryAttempt }
          : {}),
      }, true);
      assertNoNativeToolLeak(nextDecision.bytes, context.slots.filter((slot) => slot.owner === "proxy"));
      const observable = nextDecision.kind === "final" && !nextDecision.observationStateKey
        ? { ...nextDecision, observationStateKey: stateKey }
        : nextDecision;
      return { ...observable, rounds: [snapshot, ...observable.rounds] };
    } catch (error) {
      if (error instanceof OpenAICoordinatorFailure) return this.error(error.code, error.message, error.status, [parser.snapshot()]);
      return this.error("native_tool_state_unavailable", "Native Proxy Tool coordination failed", 503, [parser.snapshot()]);
    }
  }

  private async createBatch(input: OpenAIToolLoopRoundInput, calls: readonly UnifiedToolCall[]): Promise<ToolExecutionStateKey> {
    const timestamp = this.now();
    const key = { ...input.scope, toolBatchId: this.createId() };
    const context: ToolExecutionContext = {
      key, turnSeq: input.turnSeq, protocol: "openai", round: input.round,
      totalCalls: input.totalCalls + calls.filter((call) => call.owner === "proxy").length,
      assistantSkeleton: assistantSkeleton(calls), slots: slots(calls), responseStreamStatus: "completed",
      clientDispatchStatus: "none", upstreamSnapshot: structuredClone(input.upstreamSnapshot), revision: 0,
      ...(input.parentStateKey && input.parentReentryAttempt !== undefined
        ? { parentStateKey: structuredClone(input.parentStateKey), parentReentryAttempt: input.parentReentryAttempt }
        : {}),
      expiresAt: new Date(timestamp.getTime() + this.options.limits.stateTtlSeconds * 1_000).toISOString(),
      createdAt: timestamp.toISOString(), updatedAt: timestamp.toISOString(),
    };
    await this.options.storage.create(context);
    return key;
  }

  private async executeAndPersist(call: UnifiedToolCall, scope: ToolExecutionScope, key: ToolExecutionStateKey): Promise<void> {
    const leaseOwner = `native-tool-worker-${this.createId()}`;
    const leaseUntil = new Date(this.now().getTime() + nativeToolLeaseDurationMs(this.options.limits.toolTimeoutMs)).toISOString();
    let claimed = false;
    for (let attempt = 0; attempt < this.maxStorageAttempts; attempt++) {
      const context = await this.options.storage.get(key);
      if (!context) return;
      const slot = context.slots.find((value) => value.callId === call.callId);
      if (!slot || ["succeeded", "failed", "running"].includes(slot.status)) return;
      claimed = await this.options.storage.tryClaimSlotExecution({ key, callId: call.callId, expectedRevision: context.revision, leaseOwner, leaseUntil });
      if (claimed) break;
    }
    if (!claimed) return;
    let result: NativeToolResult;
    try { result = await this.options.dispatcher.execute(call, scope); } catch { result = genericExecutionError(); }
    for (let attempt = 0; attempt < this.maxStorageAttempts; attempt++) {
      const context = await this.options.storage.get(key);
      if (!context) return;
      const slot = context.slots.find((value) => value.callId === call.callId);
      if (!slot || ["succeeded", "failed"].includes(slot.status) || slot.executionLeaseOwner !== leaseOwner) return;
      if (await this.options.storage.compareAndSetSlotResult({
        key, callId: call.callId, expectedRevision: context.revision, leaseOwner,
        result: result.value, isError: result.isError,
      })) return;
    }
  }

  private async transitionDispatch(
    key: ToolExecutionStateKey,
    expectedStatus: ToolExecutionContext["clientDispatchStatus"],
    nextStatus: ToolExecutionContext["clientDispatchStatus"],
    dispatchOutcome?: PersistedResponseSnapshot,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < this.maxStorageAttempts; attempt++) {
      const context = await this.options.storage.get(key);
      if (!context || context.clientDispatchStatus !== expectedStatus) return false;
      if (await this.options.storage.compareAndSetClientDispatchStatus({
        key, expectedRevision: context.revision, expectedStatus, nextStatus,
        ...(dispatchOutcome ? { dispatchOutcome } : {}),
      })) return true;
    }
    return false;
  }

  private async prepareObservation(key: ToolExecutionStateKey, outcome: PersistedResponseSnapshot): Promise<boolean> {
    for (let attempt = 0; attempt < this.maxStorageAttempts; attempt++) {
      const context = await this.options.storage.get(key);
      if (!context) return false;
      if (context.observationStatus === "pending") return JSON.stringify(context.observationOutcome) === JSON.stringify(outcome);
      if (context.observationStatus && context.observationStatus !== "none") return false;
      if (await this.options.storage.prepareObservation({ key, expectedRevision: context.revision, outcome })) return true;
    }
    return false;
  }

  private async drain(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try { while (!(await reader.read()).done) { /* consume */ } } finally { reader.releaseLock(); }
  }

  private error(code: string, message: string, status: number, rounds: OpenAIStreamSnapshot[]): OpenAIToolLoopDecision {
    return {
      kind: "error", code, message, status, rounds,
      bytes: new TextEncoder().encode(JSON.stringify({ error: { type: status >= 500 ? "api_error" : "invalid_request_error", code, message } })),
      headers: new Headers({ "content-type": "application/json" }),
    };
  }
}
