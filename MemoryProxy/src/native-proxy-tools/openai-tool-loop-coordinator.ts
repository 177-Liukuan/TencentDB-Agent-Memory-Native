import type { ToolExecutionStorageAdapter } from "../db/tool-execution-storage-adapter.js";
import type { NativeToolLedgerStorageAdapter } from "../db/native-tool-ledger-storage-adapter.js";
import { OpenAIStreamParser } from "../injection/adapters/openai-stream.js";
import type { ProtocolStreamEvent, UnifiedToolCall } from "../injection/adapters/interface.js";
import type { NativeProxyToolDispatcher } from "./native-proxy-tool-dispatcher.js";
import {
  buildClientVisibleOpenAISse,
  buildOpenAIAssistantSkeleton,
  buildOpenAIToolMessages,
} from "./openai-response-rebuilder.js";
import type { NativeProxyToolRegistry } from "./tool-registry.js";
import {
  persistToolLoopResponse,
  ToolLoopCoreFailure,
  ToolLoopExecutionCore,
} from "./tool-loop-execution-core.js";
import type {
  JsonValue, NativeProxyToolsConfig, ToolCallSlot, ToolExecutionContext,
  ToolExecutionScope, ToolExecutionStateKey,
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

export interface ToolStreamSnapshot {
  rawBytes: Uint8Array;
  messageCompleted: boolean;
  toolCalls: UnifiedToolCall[];
  assistantContent?: string | null;
  assistantExtras?: Record<string, JsonValue>;
}

export interface ToolStreamParser {
  push(chunk: Uint8Array): ProtocolStreamEvent[];
  finish(): ProtocolStreamEvent[];
  snapshot(): ToolStreamSnapshot;
}

export interface ToolLoopProtocolCodec {
  protocol: "openai" | "responses";
  createParser(registry: NativeProxyToolRegistry): ToolStreamParser;
  assistantSkeleton(snapshot: ToolStreamSnapshot): JsonValue[];
  buildToolMessages(snapshot: ToolStreamSnapshot, slots: readonly ToolCallSlot[]): JsonValue[];
  buildClientVisibleSse(rawBytes: Uint8Array, proxyIndexes: ReadonlySet<number>): Uint8Array;
  /** Convert an otherwise replayable successful upstream stream for the client. */
  buildReplaySse?(rawBytes: Uint8Array): Uint8Array;
  /** Override the protocol-specific error envelope returned to the client. */
  buildError?(code: string, message: string, status: number): { bytes: Uint8Array; headers: Headers };
}

export type OpenAIToolLoopDecision =
  | { kind: "replay" | "final"; bytes: Uint8Array; status: number; headers: Headers; rounds: ToolStreamSnapshot[]; observationStateKey?: ToolExecutionStateKey }
  | { kind: "client_dispatch"; stateKey: ToolExecutionStateKey; bytes: Uint8Array; status: number; headers: Headers; rounds: ToolStreamSnapshot[] }
  | { kind: "error"; code: string; message: string; bytes: Uint8Array; status: number; headers: Headers; rounds: ToolStreamSnapshot[] };

export interface OpenAIToolLoopCoordinatorOptions {
  registry: NativeProxyToolRegistry;
  storage: ToolExecutionStorageAdapter;
  ledgerStorage?: NativeToolLedgerStorageAdapter;
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
  /** Internal extension point used by the distinct OpenAI Responses adapter. */
  codec?: ToolLoopProtocolCodec;
}

function assistantSkeleton(calls: readonly UnifiedToolCall[]): JsonValue[] {
  return buildOpenAIAssistantSkeleton({ calls });
}

export class OpenAIToolLoopCoordinator {
  private readonly core: ToolLoopExecutionCore;
  private readonly codec: ToolLoopProtocolCodec;

  constructor(private readonly options: OpenAIToolLoopCoordinatorOptions) {
    this.core = new ToolLoopExecutionCore(options);
    this.codec = options.codec ?? {
      protocol: "openai",
      createParser: (registry) => new OpenAIStreamParser(registry),
      assistantSkeleton: (snapshot) => buildOpenAIAssistantSkeleton({
        calls: snapshot.toolCalls,
        content: snapshot.assistantContent,
        extras: snapshot.assistantExtras,
      }),
      buildToolMessages: (snapshot, persistedSlots) => buildOpenAIToolMessages(
        persistedSlots,
        buildOpenAIAssistantSkeleton({
          calls: snapshot.toolCalls,
          content: snapshot.assistantContent,
          extras: snapshot.assistantExtras,
        }),
      ),
      buildClientVisibleSse: buildClientVisibleOpenAISse,
    };
  }

  async handleRound(input: OpenAIToolLoopRoundInput): Promise<OpenAIToolLoopDecision> {
    const decision = await this.handleRoundInternal(input, false);
    if (decision.kind === "final" && decision.observationStateKey) {
      const ok = await this.core.prepareObservation(
        decision.observationStateKey,
        persistToolLoopResponse(decision.bytes, decision.status, decision.headers),
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
    const parser = this.codec.createParser(this.options.registry);
    let streamingStateKey: ToolExecutionStateKey | undefined;
    const executionTasks = new Map<string, Promise<void>>();
    const scheduleExecution = (call: UnifiedToolCall): void => {
      if (!streamingStateKey || executionTasks.has(call.callId)) return;
      const operation = () => this.core.executeAndPersist(call, input.scope, streamingStateKey!);
      const task = (this.options.trackBackgroundOperation
        ? this.options.trackBackgroundOperation(operation)
        : operation()).catch(() => {});
      executionTasks.set(call.callId, task);
    };
    try {
      const reader = input.stream.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          const events = parser.push(next.value);
          if (events.some((event) => event.type === "protocol_error")) {
            await reader.cancel().catch(() => {});
            if (streamingStateKey) await this.core.markAborted(streamingStateKey);
            return this.error("upstream_stream_invalid", "OpenAI upstream returned an invalid event stream", 502, [parser.snapshot()]);
          }
          // Responses 有单次函数参数完成事件，可提前执行只读调用；Chat Completions
          // 没有同等可靠的边界，只在整轮结束后统一确认并执行。
          if (this.codec.protocol === "responses") {
            for (const event of events) {
              if (event.type !== "tool_call_completed") continue;
              const partial = parser.snapshot();
              const nativeCount = partial.toolCalls.filter((call) => call.owner === "proxy").length;
              const limitFailure = this.core.limitFailure({
                round: input.round,
                totalCalls: input.totalCalls,
                callsThisRound: nativeCount,
              });
              if (limitFailure) {
                await reader.cancel().catch(() => {});
                return this.error(limitFailure.code, limitFailure.message, limitFailure.status, [partial]);
              }
              if (event.call.owner === "proxy" && !streamingStateKey) {
                streamingStateKey = await this.createBatch(input, partial.toolCalls, partial, "streaming");
              } else if (streamingStateKey) {
                await this.persistStreamSnapshot(streamingStateKey, partial, "streaming", input.totalCalls + nativeCount);
              }
              if (
                event.call.owner === "proxy"
                && this.options.registry.require(event.call.toolName).effect === "read"
              ) scheduleExecution(event.call);
            }
          }
        }
      } catch {
        if (streamingStateKey) await this.core.markAborted(streamingStateKey);
        return this.error("upstream_stream_interrupted", "OpenAI upstream stream was interrupted", 502, [parser.snapshot()]);
      } finally {
        reader.releaseLock();
      }
      const finishEvents = parser.finish();
      if (finishEvents.some((event) => event.type === "protocol_error")) {
        if (streamingStateKey) await this.core.markAborted(streamingStateKey);
        return this.error("upstream_stream_incomplete", "OpenAI upstream stream ended before the round boundary", 502, [parser.snapshot()]);
      }
      const snapshot = parser.snapshot();
      const nativeCalls = snapshot.toolCalls.filter((call) => call.owner === "proxy");
      const clientCalls = snapshot.toolCalls.filter((call) => call.owner === "client");
      if (nativeCalls.length === 0) {
        return {
          kind: internal ? "final" : "replay",
          bytes: this.codec.buildReplaySse?.(snapshot.rawBytes) ?? snapshot.rawBytes,
          status: input.status,
          headers: new Headers(input.headers), rounds: [snapshot],
        };
      }
      const limitFailure = this.core.limitFailure({
        round: input.round,
        totalCalls: input.totalCalls,
        callsThisRound: nativeCalls.length,
      });
      if (limitFailure) {
        return this.error(limitFailure.code, limitFailure.message, limitFailure.status, [snapshot]);
      }

      const stateKey = streamingStateKey ?? await this.createBatch(input, snapshot.toolCalls, snapshot);
      if (streamingStateKey) {
        await this.persistStreamSnapshot(stateKey, snapshot, "completed", input.totalCalls + nativeCalls.length);
      }
      for (const call of nativeCalls) {
        if (!executionTasks.has(call.callId)) {
          streamingStateKey = stateKey;
          // 这里同时补启动写/archive 调用，以及 Chat Completions 到轮末才确认的全部调用。
          scheduleExecution(call);
        }
      }
      const totalCalls = input.totalCalls + nativeCalls.length;
      if (clientCalls.length > 0) {
        await this.options.beforeClientDispatch?.();
        const bytes = this.codec.buildClientVisibleSse(snapshot.rawBytes, new Set(nativeCalls.map((call) => call.contentBlockIndex)));
        const outcome = persistToolLoopResponse(bytes, input.status, input.headers);
        const pending = await this.core.transitionClientDispatch(stateKey, "none", "pending", outcome);
        if (pending) {
          await this.options.onClientDispatchPrepared?.({
            stateKey,
            bytes,
            status: input.status,
            headers: new Headers(input.headers),
          });
        }
        const dispatched = pending && await this.core.transitionClientDispatch(stateKey, "pending", "dispatched");
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
        ...this.codec.buildToolMessages(snapshot, context.slots),
      ];
      await this.core.persistCompletedHistory(stateKey);
      await this.options.beforeReenter?.();
      const next = await this.options.reenter({
        upstreamSnapshot: structuredClone(input.upstreamSnapshot), messages: structuredClone(messages),
        round: input.round + 1, totalCalls,
      });
      const nextDecision = await this.handleRoundInternal({
        ...next, scope: input.scope, turnSeq: input.turnSeq,
        upstreamSnapshot: {
          ...structuredClone(input.upstreamSnapshot), baseMessages: structuredClone(messages),
        },
        round: input.round + 1, totalCalls,
        ...(input.parentStateKey && input.parentReentryAttempt !== undefined
          ? { parentStateKey: input.parentStateKey, parentReentryAttempt: input.parentReentryAttempt }
          : {}),
      }, true);
      const observable = nextDecision.kind === "final" && !nextDecision.observationStateKey
        ? { ...nextDecision, observationStateKey: stateKey }
        : nextDecision;
      return { ...observable, rounds: [snapshot, ...observable.rounds] };
    } catch (error) {
      if (streamingStateKey) await this.core.markAborted(streamingStateKey);
      if (error instanceof ToolLoopCoreFailure) return this.error(error.code, error.message, error.status, [parser.snapshot()]);
      return this.error("native_tool_state_unavailable", "Native Proxy Tool coordination failed", 503, [parser.snapshot()]);
    }
  }

  private async createBatch(
    input: OpenAIToolLoopRoundInput,
    calls: readonly UnifiedToolCall[],
    snapshot?: ToolStreamSnapshot,
    responseStreamStatus: ToolExecutionContext["responseStreamStatus"] = "completed",
  ): Promise<ToolExecutionStateKey> {
    return this.core.createBatch({
      protocol: this.codec.protocol,
      scope: input.scope,
      turnSeq: input.turnSeq,
      upstreamSnapshot: input.upstreamSnapshot,
      round: input.round,
      totalCalls: input.totalCalls,
      calls,
      assistantSkeleton: snapshot
        ? this.codec.assistantSkeleton(snapshot)
        : assistantSkeleton(calls),
      responseStreamStatus,
      ...(input.parentStateKey && input.parentReentryAttempt !== undefined
        ? { parentStateKey: input.parentStateKey, parentReentryAttempt: input.parentReentryAttempt }
        : {}),
    });
  }

  private async persistStreamSnapshot(
    key: ToolExecutionStateKey,
    snapshot: ToolStreamSnapshot,
    responseStreamStatus: ToolExecutionContext["responseStreamStatus"],
    totalCalls: number,
  ): Promise<void> {
    await this.core.persistStreamSnapshot({
      key,
      assistantSkeleton: this.codec.assistantSkeleton(snapshot),
      calls: snapshot.toolCalls,
      responseStreamStatus,
      totalCalls,
    });
  }

  private async drain(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try { while (!(await reader.read()).done) { /* consume */ } } finally { reader.releaseLock(); }
  }

  private error(code: string, message: string, status: number, rounds: ToolStreamSnapshot[]): OpenAIToolLoopDecision {
    const custom = this.codec.buildError?.(code, message, status);
    return {
      kind: "error", code, message, status, rounds,
      bytes: custom?.bytes ?? new TextEncoder().encode(JSON.stringify({ error: { type: status >= 500 ? "api_error" : "invalid_request_error", code, message } })),
      headers: custom?.headers ?? new Headers({ "content-type": "application/json" }),
    };
  }
}
