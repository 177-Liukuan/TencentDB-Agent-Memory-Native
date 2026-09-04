import type { ToolExecutionStorageAdapter } from "../db/tool-execution-storage-adapter.js";
import type { NativeToolLedgerStorageAdapter } from "../db/native-tool-ledger-storage-adapter.js";
import {
  AnthropicStreamParser,
  type AnthropicStreamSnapshot,
} from "../injection/adapters/anthropic-stream.js";
import type {
  ProtocolStreamEvent,
  UnifiedToolCall,
} from "../injection/adapters/interface.js";
import {
  buildClientVisibleAnthropicSse,
  buildToolResultMessage,
  replayAnthropicBytes,
} from "./anthropic-response-rebuilder.js";
import type { NativeProxyToolDispatcher } from "./native-proxy-tool-dispatcher.js";
import type { NativeProxyToolRegistry } from "./tool-registry.js";
import {
  persistToolLoopResponse,
  ToolLoopCoreFailure,
  ToolLoopExecutionCore,
} from "./tool-loop-execution-core.js";
import type {
  JsonValue,
  NativeProxyToolsConfig,
  ToolCallSlot,
  ToolExecutionScope,
  ToolExecutionStateKey,
  UpstreamRequestSnapshot,
} from "./types.js";

export interface UpstreamRound {
  stream: ReadableStream<Uint8Array>;
  status: number;
  headers: Headers;
}

export interface NativeReentryRequest {
  upstreamSnapshot: UpstreamRequestSnapshot;
  messages: JsonValue[];
  round: number;
  totalCalls: number;
}

export interface ToolLoopRoundInput extends UpstreamRound {
  scope: ToolExecutionScope;
  turnSeq: number;
  upstreamSnapshot: UpstreamRequestSnapshot;
  round: number;
  totalCalls: number;
  /** Durable parent link for a continuation produced while resuming Client results. */
  parentStateKey?: ToolExecutionStateKey;
  parentReentryAttempt?: number;
}

interface ToolLoopBytesDecision {
  bytes: Uint8Array;
  status: number;
  headers: Headers;
  rounds: AnthropicStreamSnapshot[];
}

export type ToolLoopDecision =
  | ({ kind: "replay" } & ToolLoopBytesDecision)
  | ({
      kind: "final";
      /** Last Native batch that durably owns logical-turn writeback. */
      observationStateKey?: ToolExecutionStateKey;
    } & ToolLoopBytesDecision)
  | ({
      kind: "client_dispatch";
      stateKey: ToolExecutionStateKey;
    } & ToolLoopBytesDecision)
  | ({
      kind: "error";
      code: string;
      message: string;
    } & ToolLoopBytesDecision);

export interface AnthropicToolLoopCoordinatorOptions {
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
  /** Fence and extend a parent Client-result lease before each model re-entry. */
  beforeReenter?(): Promise<void>;
  /** Fence the parent lease before exposing a newly persisted Client batch. */
  beforeClientDispatch?(): Promise<void>;
  /** Commit the parent outbox before a prepared child continuation is dispatchable. */
  onClientDispatchPrepared?(dispatch: {
    stateKey: ToolExecutionStateKey;
    bytes: Uint8Array;
    status: number;
    headers: Headers;
  }): Promise<void>;
}

class CoordinatorFailure extends ToolLoopCoreFailure {
  constructor(
    code: string,
    message: string,
    status: number,
  ) {
    super(code, message, status);
    this.name = "CoordinatorFailure";
  }
}

function skeletonFromSnapshot(snapshot: AnthropicStreamSnapshot): JsonValue[] {
  return [...snapshot.blocks]
    .filter((entry) => entry.completed)
    .sort((left, right) => left.index - right.index)
    .map((entry) => structuredClone(entry.block));
}

function asAssistantMessage(skeleton: readonly JsonValue[]): JsonValue {
  return {
    role: "assistant",
    content: structuredClone([...skeleton]),
  };
}

function asToolResultMessage(slots: readonly ToolCallSlot[]): JsonValue {
  return buildToolResultMessage(slots) as unknown as JsonValue;
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  if (right.byteLength === 0) return left;
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left, 0);
  output.set(right, left.byteLength);
  return output;
}

function findSseFrameBoundary(bytes: Uint8Array): number {
  let lineStart = 0;
  for (let index = 0; index < bytes.byteLength; index++) {
    const byte = bytes[index];
    if (byte !== 0x0a && byte !== 0x0d) continue;
    const terminatorEnd = byte === 0x0d && bytes[index + 1] === 0x0a
      ? index + 2
      : index + 1;
    if (index === lineStart) return terminatorEnd;
    lineStart = terminatorEnd;
    index = terminatorEnd - 1;
  }
  return -1;
}

/** Decouple protocol event boundaries from arbitrary network chunking. */
class AnthropicSseFrameFeeder {
  private pending: Uint8Array = new Uint8Array();

  push(chunk: Uint8Array): Uint8Array[] {
    this.pending = appendBytes(this.pending, chunk);
    const frames: Uint8Array[] = [];
    while (true) {
      const boundary = findSseFrameBoundary(this.pending);
      if (boundary < 0) break;
      frames.push(this.pending.slice(0, boundary));
      this.pending = this.pending.slice(boundary);
    }
    return frames;
  }

  flush(): Uint8Array | null {
    if (this.pending.byteLength === 0) return null;
    const remaining = this.pending;
    this.pending = new Uint8Array();
    return remaining;
  }
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

export class AnthropicToolLoopCoordinator {
  private readonly core: ToolLoopExecutionCore;

  constructor(private readonly options: AnthropicToolLoopCoordinatorOptions) {
    this.core = new ToolLoopExecutionCore(options);
  }

  async handleRound(input: ToolLoopRoundInput): Promise<ToolLoopDecision> {
    const decision = await this.handleRoundInternal(input, false);
    if (decision.kind === "final" && decision.observationStateKey) {
      const prepared = await this.core.prepareObservation(
        decision.observationStateKey,
        persistToolLoopResponse(decision.bytes, decision.status, decision.headers),
      ).catch(() => false);
      if (!prepared) {
        return this.errorDecision(
          new CoordinatorFailure(
            "native_tool_state_unavailable",
            "Native Proxy Tool observation could not be prepared",
            503,
          ),
          input,
          new AnthropicStreamParser(this.options.registry).snapshot(),
        );
      }
    }
    return decision;
  }

  private async handleRoundInternal(
    input: ToolLoopRoundInput,
    internalRound: boolean,
  ): Promise<ToolLoopDecision> {
    if (input.status < 200 || input.status >= 300) {
      try {
        await drainStream(input.stream);
        return this.errorDecision(
          new CoordinatorFailure(
            "upstream_non_2xx",
            "Anthropic upstream returned an error response",
            input.status,
          ),
          input,
          new AnthropicStreamParser(this.options.registry).snapshot(),
        );
      } catch {
        return this.errorDecision(
          new CoordinatorFailure(
            "upstream_stream_interrupted",
            "Anthropic upstream error response was interrupted",
            502,
          ),
          input,
          new AnthropicStreamParser(this.options.registry).snapshot(),
        );
      }
    }
    const parser = new AnthropicStreamParser(this.options.registry);
    const feeder = new AnthropicSseFrameFeeder();
    const executionTasks = new Map<string, Promise<void>>();
    let stateKey: ToolExecutionStateKey | undefined;
    let messageCompleted = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    const fail = async (failure: ToolLoopCoreFailure): Promise<ToolLoopDecision> => {
      if (stateKey) await this.core.markAborted(stateKey);
      return this.errorDecision(failure, input, parser.snapshot());
    };

    const scheduleExecution = (call: UnifiedToolCall): void => {
      if (executionTasks.has(call.callId)) return;
      const persistOperation = () => this.core.executeAndPersist(call, input.scope, stateKey!);
      const task = (this.options.trackBackgroundOperation
        ? this.options.trackBackgroundOperation(persistOperation)
        : persistOperation()).catch(() => {});
      executionTasks.set(call.callId, task);
    };

    try {
      reader = input.stream.getReader();
      while (!messageCompleted) {
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await reader.read();
        } catch {
          return fail(new CoordinatorFailure(
            "upstream_stream_interrupted",
            "Anthropic upstream stream was interrupted",
            502,
          ));
        }
        if (next.done) {
          const finishEvents = parser.finish();
          const protocolError = finishEvents.find((event) => event.type === "protocol_error");
          if (protocolError?.type === "protocol_error") {
            return fail(new CoordinatorFailure(
              "upstream_stream_incomplete",
              "Anthropic upstream stream ended before message_stop",
              502,
            ));
          }
          break;
        }

        const frames = feeder.push(next.value);
        for (const rawFrame of frames) {
          const events = parser.push(rawFrame);
          for (const event of events) {
            if (event.type === "protocol_error") {
              await reader.cancel().catch(() => {});
              return fail(new CoordinatorFailure(
                "upstream_stream_invalid",
                "Anthropic upstream returned an invalid event stream",
                502,
              ));
            }
            if (event.type === "tool_call_completed" && event.call.owner === "proxy") {
              const currentSnapshot = parser.snapshot();
              const nativeCalls = currentSnapshot.toolCalls.filter((call) => call.owner === "proxy");
              const limitFailure = this.core.limitFailure({
                round: input.round,
                totalCalls: input.totalCalls,
                callsThisRound: nativeCalls.length,
              });
              if (limitFailure) {
                await reader.cancel().catch(() => {});
                return fail(limitFailure);
              }

              if (!stateKey) {
                stateKey = await this.createBatch(input, currentSnapshot);
              } else {
                await this.persistSnapshot(
                  stateKey,
                  currentSnapshot,
                  "streaming",
                  input.totalCalls + nativeCalls.length,
                );
              }
              if (this.options.registry.require(event.call.toolName).effect === "read") {
                scheduleExecution(event.call);
              }
            }
            if (event.type === "tool_call_completed" && event.call.owner === "client" && stateKey) {
              const currentSnapshot = parser.snapshot();
              await this.persistSnapshot(
                stateKey,
                currentSnapshot,
                "streaming",
                input.totalCalls
                  + currentSnapshot.toolCalls.filter((call) => call.owner === "proxy").length,
              );
            }
            if (event.type === "message_completed") messageCompleted = true;
          }
          if (messageCompleted) break;
        }
      }

      const trailing = feeder.flush();
      if (trailing && !messageCompleted) {
        const events = parser.push(trailing);
        const protocolError = events.find((event) => event.type === "protocol_error");
        if (protocolError) {
          return fail(new CoordinatorFailure(
            "upstream_stream_invalid",
            "Anthropic upstream returned an invalid event stream",
            502,
          ));
        }
      }
      parser.finish();
      const snapshot = parser.snapshot();
      if (!messageCompleted || !snapshot.messageCompleted) {
        return fail(new CoordinatorFailure(
          "upstream_stream_incomplete",
          "Anthropic upstream stream ended before message_stop",
          502,
        ));
      }

      const nativeCalls = snapshot.toolCalls.filter((call) => call.owner === "proxy");
      const clientCalls = snapshot.toolCalls.filter((call) => call.owner === "client");
      if (nativeCalls.length === 0) {
        if (internalRound && clientCalls.length > 0) {
          await this.options.beforeClientDispatch?.();
          stateKey = await this.createBatch(input, snapshot);
          await this.persistSnapshot(stateKey, snapshot, "completed", input.totalCalls);
          const bytes = replayAnthropicBytes(snapshot);
          const headers = new Headers(input.headers);
          const pending = await this.core.transitionClientDispatch(
            stateKey,
            "none",
            "pending",
            persistToolLoopResponse(bytes, input.status, headers),
          );
          if (pending) {
            await this.options.onClientDispatchPrepared?.({
              stateKey,
              bytes,
              status: input.status,
              headers: new Headers(headers),
            });
          }
          const dispatched = pending
            && await this.core.transitionClientDispatch(stateKey, "pending", "dispatched");
          if (!dispatched) {
            return fail(new CoordinatorFailure(
              "client_tool_dispatch_conflict",
              "Client Tool continuation has already been dispatched",
              409,
            ));
          }
          return {
            kind: "client_dispatch",
            stateKey,
            bytes,
            status: input.status,
            headers,
            rounds: [snapshot],
          };
        }
        const bytes = replayAnthropicBytes(snapshot);
        return {
          kind: internalRound ? "final" : "replay",
          bytes,
          status: input.status,
          headers: new Headers(input.headers),
          rounds: [snapshot],
        };
      }

      if (!stateKey) {
        throw new CoordinatorFailure(
          "native_tool_state_unavailable",
          "Native Proxy Tool state was not created",
          503,
        );
      }
      const totalCalls = input.totalCalls + nativeCalls.length;
      if (clientCalls.length > 0) await this.options.beforeClientDispatch?.();
      await this.persistSnapshot(stateKey, snapshot, "completed", totalCalls);
      for (const call of nativeCalls) scheduleExecution(call);

      if (clientCalls.length > 0) {
        const bytes = buildClientVisibleAnthropicSse(
          snapshot,
          new Set(nativeCalls.map((call) => call.contentBlockIndex)),
        );
        const headers = new Headers(input.headers);
        const pending = await this.core.transitionClientDispatch(
          stateKey,
          "none",
          "pending",
          persistToolLoopResponse(bytes, input.status, headers),
        );
        if (pending) {
          await this.options.onClientDispatchPrepared?.({
            stateKey,
            bytes,
            status: input.status,
            headers: new Headers(headers),
          });
        }
        const dispatched = pending
          && await this.core.transitionClientDispatch(stateKey, "pending", "dispatched");
        if (!dispatched) {
          return fail(new CoordinatorFailure(
            "client_tool_dispatch_conflict",
            "Client Tool batch has already been dispatched",
            409,
          ));
        }
        return {
          kind: "client_dispatch",
          stateKey,
          bytes,
          status: input.status,
          headers,
          rounds: [snapshot],
        };
      }

      await Promise.all(executionTasks.values());
      const completedState = await this.options.storage.get(stateKey);
      if (!completedState || completedState.slots.some((slot) => (
        slot.owner === "proxy" && slot.status !== "succeeded" && slot.status !== "failed"
      ))) {
        throw new CoordinatorFailure(
          "native_tool_result_unavailable",
          "Native Proxy Tool result could not be persisted",
          503,
        );
      }

      const messages: JsonValue[] = [
        ...structuredClone(input.upstreamSnapshot.baseMessages),
        asAssistantMessage(completedState.assistantSkeleton),
        asToolResultMessage(completedState.slots),
      ];
      await this.core.persistCompletedHistory(stateKey);
      const nextRoundNumber = input.round + 1;
      await this.options.beforeReenter?.();
      const nextRound = await this.options.reenter({
        upstreamSnapshot: structuredClone(input.upstreamSnapshot),
        messages: structuredClone(messages),
        round: nextRoundNumber,
        totalCalls,
      });
      const nextSnapshot: UpstreamRequestSnapshot = {
        ...structuredClone(input.upstreamSnapshot),
        baseMessages: structuredClone(messages),
      };
      const nextDecision = await this.handleRoundInternal({
        ...nextRound,
        scope: input.scope,
        turnSeq: input.turnSeq,
        upstreamSnapshot: nextSnapshot,
        round: nextRoundNumber,
        totalCalls,
        ...(input.parentStateKey && input.parentReentryAttempt !== undefined
          ? {
              parentStateKey: input.parentStateKey,
              parentReentryAttempt: input.parentReentryAttempt,
            }
          : {}),
      }, true);
      const observableDecision = nextDecision.kind === "final"
        && !input.parentStateKey
        && !nextDecision.observationStateKey
        ? { ...nextDecision, observationStateKey: stateKey }
        : nextDecision;
      return this.prependRound(snapshot, observableDecision);
    } catch (error) {
      const failure = error instanceof ToolLoopCoreFailure
        ? error
        : new CoordinatorFailure(
            "native_tool_state_unavailable",
            "Native Proxy Tool coordination failed",
            503,
          );
      return fail(failure);
    } finally {
      reader?.releaseLock();
    }
  }

  private async createBatch(
    input: ToolLoopRoundInput,
    snapshot: AnthropicStreamSnapshot,
  ): Promise<ToolExecutionStateKey> {
    return this.core.createBatch({
      protocol: "anthropic",
      scope: input.scope,
      turnSeq: input.turnSeq,
      upstreamSnapshot: input.upstreamSnapshot,
      round: input.round,
      totalCalls: input.totalCalls,
      calls: snapshot.toolCalls,
      assistantSkeleton: skeletonFromSnapshot(snapshot),
      responseStreamStatus: "streaming",
      ...(input.parentStateKey && input.parentReentryAttempt !== undefined
        ? {
            parentStateKey: input.parentStateKey,
            parentReentryAttempt: input.parentReentryAttempt,
          }
        : {}),
    });
  }

  private async persistSnapshot(
    key: ToolExecutionStateKey,
    snapshot: AnthropicStreamSnapshot,
    responseStreamStatus: "streaming" | "completed",
    totalCalls: number,
  ): Promise<void> {
    await this.core.persistStreamSnapshot({
      key,
      assistantSkeleton: skeletonFromSnapshot(snapshot),
      calls: snapshot.toolCalls,
      responseStreamStatus,
      totalCalls,
    });
  }

  private errorDecision(
    failure: ToolLoopCoreFailure,
    input: ToolLoopRoundInput,
    snapshot: AnthropicStreamSnapshot,
  ): ToolLoopDecision {
    const bytes = new TextEncoder().encode(JSON.stringify({
      type: "error",
      error: {
        type: failure.status >= 500 ? "api_error" : "invalid_request_error",
        code: failure.code,
        message: failure.message,
      },
    }));
    return {
      kind: "error",
      code: failure.code,
      message: failure.message,
      bytes,
      status: failure.status,
      headers: new Headers({ "content-type": "application/json" }),
      rounds: snapshot.rawBytes.byteLength > 0 ? [snapshot] : [],
    };
  }

  private prependRound(
    snapshot: AnthropicStreamSnapshot,
    decision: ToolLoopDecision,
  ): ToolLoopDecision {
    return {
      ...decision,
      rounds: [snapshot, ...decision.rounds],
    };
  }
}
