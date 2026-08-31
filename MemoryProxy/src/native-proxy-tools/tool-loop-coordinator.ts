import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  isReplaySafeResponseHeader,
  type ToolExecutionStorageAdapter,
} from "../db/tool-execution-storage-adapter.js";
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
  assertNoNativeToolLeak,
  buildNativeRegistryLeakMarkers,
  mergeNativeToolLeakMarkers,
} from "./anthropic-response-rebuilder.js";
import type { NativeProxyToolDispatcher } from "./native-proxy-tool-dispatcher.js";
import type { NativeProxyToolRegistry } from "./tool-registry.js";
import { nativeToolLeaseDurationMs } from "./types.js";
import type {
  JsonValue,
  NativeProxyToolsConfig,
  NativeToolResult,
  NativeToolLeakMarker,
  ToolCallSlot,
  ToolExecutionContext,
  ToolExecutionScope,
  ToolExecutionStateKey,
  PersistedResponseSnapshot,
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

class CoordinatorFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CoordinatorFailure";
  }
}

function assertSafeClientDispatch(
  bytes: Uint8Array,
  markers: readonly NativeToolLeakMarker[],
): void {
  try {
    assertNoNativeToolLeak(bytes, markers);
  } catch {
    throw new CoordinatorFailure(
      "native_tool_leak_detected",
      "Native Proxy Tool response could not be returned safely",
      500,
    );
  }
}

function slotsFromSnapshot(snapshot: AnthropicStreamSnapshot): ToolCallSlot[] {
  return snapshot.toolCalls.map((call) => ({
    callId: call.callId,
    slotIndex: call.slotIndex,
    contentBlockIndex: call.contentBlockIndex,
    toolName: call.toolName,
    owner: call.owner,
    ...(call.input !== undefined ? { input: structuredClone(call.input) } : {}),
    argumentsComplete: call.argumentsComplete,
    status: "pending",
    executionAttempt: 0,
  }));
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

function genericExecutionError(): NativeToolResult {
  return {
    isError: true,
    value: {
      code: "native_tool_execution_failed",
      message: "Native Proxy Tool execution failed",
      retryable: true,
    },
  };
}

function persistResponseSnapshot(
  bytes: Uint8Array,
  status: number,
  sourceHeaders: Headers,
): PersistedResponseSnapshot {
  const headers: Record<string, string> = {};
  for (const [rawName, value] of sourceHeaders.entries()) {
    const name = rawName.toLowerCase();
    if (isReplaySafeResponseHeader(name)) headers[name] = value;
  }
  return {
    status,
    headers,
    bodyBase64: Buffer.from(bytes).toString("base64"),
  };
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
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly maxStorageAttempts: number;

  constructor(private readonly options: AnthropicToolLoopCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.maxStorageAttempts = options.maxStorageAttempts ?? 8;
  }

  async handleRound(input: ToolLoopRoundInput): Promise<ToolLoopDecision> {
    const decision = await this.handleRoundInternal(input, false);
    try {
      assertNoNativeToolLeak(
        decision.bytes,
        buildNativeRegistryLeakMarkers(this.options.registry),
      );
    } catch {
      return this.errorDecision(
        new CoordinatorFailure(
          "native_tool_leak_detected",
          "Native Proxy Tool response could not be returned safely",
          500,
        ),
        input,
        new AnthropicStreamParser(this.options.registry).snapshot(),
      );
    }
    if (decision.kind === "final" && decision.observationStateKey) {
      const prepared = await this.prepareObservation(
        decision.observationStateKey,
        persistResponseSnapshot(decision.bytes, decision.status, decision.headers),
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

    const fail = async (failure: CoordinatorFailure): Promise<ToolLoopDecision> => {
      if (stateKey) await this.markAborted(stateKey);
      return this.errorDecision(failure, input, parser.snapshot());
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
              const limitFailure = this.checkLimits(input, nativeCalls.length);
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
              const persistOperation = () => this.executeAndPersist(event.call, input.scope, stateKey!);
              const task = (this.options.trackBackgroundOperation
                ? this.options.trackBackgroundOperation(persistOperation)
                : persistOperation()).catch(() => {});
              executionTasks.set(event.call.callId, task);
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
          assertSafeClientDispatch(bytes, [
            ...(input.upstreamSnapshot.nativeLeakMarkers ?? []),
            ...buildNativeRegistryLeakMarkers(this.options.registry),
          ]);
          const pending = await this.transitionClientDispatch(
            stateKey,
            "none",
            "pending",
            persistResponseSnapshot(bytes, input.status, headers),
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
            && await this.transitionClientDispatch(stateKey, "pending", "dispatched");
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

      if (clientCalls.length > 0) {
        const bytes = buildClientVisibleAnthropicSse(
          snapshot,
          new Set(nativeCalls.map((call) => call.contentBlockIndex)),
        );
        const headers = new Headers(input.headers);
        assertSafeClientDispatch(bytes, [
          ...(input.upstreamSnapshot.nativeLeakMarkers ?? []),
          ...nativeCalls,
          ...buildNativeRegistryLeakMarkers(this.options.registry),
        ]);
        const pending = await this.transitionClientDispatch(
          stateKey,
          "none",
          "pending",
          persistResponseSnapshot(bytes, input.status, headers),
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
          && await this.transitionClientDispatch(stateKey, "pending", "dispatched");
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
        nativeLeakMarkers: mergeNativeToolLeakMarkers(
          input.upstreamSnapshot.nativeLeakMarkers ?? [],
          completedState.slots
            .filter((slot) => slot.owner === "proxy")
            .map((slot) => ({
              callId: slot.callId,
              toolName: slot.toolName,
              ...(slot.input !== undefined ? { input: structuredClone(slot.input) } : {}),
            })),
        ),
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
      assertNoNativeToolLeak(
        nextDecision.bytes,
        completedState.slots.filter((slot) => slot.owner === "proxy"),
      );
      const observableDecision = nextDecision.kind === "final"
        && !input.parentStateKey
        && !nextDecision.observationStateKey
        ? { ...nextDecision, observationStateKey: stateKey }
        : nextDecision;
      return this.prependRound(snapshot, observableDecision);
    } catch (error) {
      const failure = error instanceof CoordinatorFailure
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

  private checkLimits(
    input: ToolLoopRoundInput,
    callsThisRound: number,
  ): CoordinatorFailure | null {
    if (
      input.round > this.options.limits.maxRounds
      || callsThisRound > this.options.limits.maxCallsPerRound
      || input.totalCalls + callsThisRound > this.options.limits.maxTotalCalls
    ) {
      return new CoordinatorFailure(
        "native_tool_limit_exceeded",
        "Native Proxy Tool loop limit exceeded",
        400,
      );
    }
    return null;
  }

  private async createBatch(
    input: ToolLoopRoundInput,
    snapshot: AnthropicStreamSnapshot,
  ): Promise<ToolExecutionStateKey> {
    const timestamp = this.now();
    const nativeCount = snapshot.toolCalls.filter((call) => call.owner === "proxy").length;
    const key: ToolExecutionStateKey = {
      ...input.scope,
      toolBatchId: this.createId(),
    };
    const context: ToolExecutionContext = {
      key,
      turnSeq: input.turnSeq,
      protocol: "anthropic",
      round: input.round,
      totalCalls: input.totalCalls + nativeCount,
      assistantSkeleton: skeletonFromSnapshot(snapshot),
      slots: slotsFromSnapshot(snapshot),
      responseStreamStatus: "streaming",
      clientDispatchStatus: "none",
      ...(input.parentStateKey && input.parentReentryAttempt !== undefined
        ? {
            parentStateKey: structuredClone(input.parentStateKey),
            parentReentryAttempt: input.parentReentryAttempt,
          }
        : {}),
      upstreamSnapshot: structuredClone(input.upstreamSnapshot),
      revision: 0,
      expiresAt: new Date(
        timestamp.getTime() + this.options.limits.stateTtlSeconds * 1_000,
      ).toISOString(),
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
    };
    await this.options.storage.create(context);
    return key;
  }

  private async persistSnapshot(
    key: ToolExecutionStateKey,
    snapshot: AnthropicStreamSnapshot,
    responseStreamStatus: "streaming" | "completed",
    totalCalls: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < this.maxStorageAttempts; attempt++) {
      const current = await this.options.storage.get(key);
      if (!current) throw new CoordinatorFailure(
        "native_tool_state_unavailable",
        "Native Proxy Tool state expired or disappeared",
        503,
      );
      if (current.responseStreamStatus === "aborted") {
        throw new CoordinatorFailure(
          "native_tool_state_aborted",
          "Native Proxy Tool batch was aborted",
          409,
        );
      }
      const updated = await this.options.storage.compareAndSetStreamSnapshot({
        key,
        expectedRevision: current.revision,
        assistantSkeleton: skeletonFromSnapshot(snapshot),
        slots: slotsFromSnapshot(snapshot),
        responseStreamStatus,
        totalCalls,
      });
      if (updated) return;
    }
    throw new CoordinatorFailure(
      "native_tool_state_conflict",
      "Native Proxy Tool state could not be updated",
      503,
    );
  }

  private async executeAndPersist(
    call: UnifiedToolCall,
    scope: ToolExecutionScope,
    key: ToolExecutionStateKey,
  ): Promise<void> {
    const leaseOwner = `native-tool-worker-${this.createId()}`;
    const leaseUntil = new Date(
      this.now().getTime() + nativeToolLeaseDurationMs(this.options.limits.toolTimeoutMs),
    ).toISOString();
    let claimed = false;
    for (let attempt = 0; attempt < this.maxStorageAttempts; attempt++) {
      const current = await this.options.storage.get(key);
      if (!current) return;
      const slot = current.slots.find((candidate) => candidate.callId === call.callId);
      if (!slot || slot.status === "succeeded" || slot.status === "failed") return;
      if (slot.status === "running") return;
      claimed = await this.options.storage.tryClaimSlotExecution({
        key,
        callId: call.callId,
        expectedRevision: current.revision,
        leaseOwner,
        leaseUntil,
      });
      if (claimed) break;
    }
    if (!claimed) return;

    let result: NativeToolResult;
    try {
      result = await this.options.dispatcher.execute(call, scope);
    } catch {
      result = genericExecutionError();
    }
    for (let attempt = 0; attempt < this.maxStorageAttempts; attempt++) {
      const current = await this.options.storage.get(key);
      if (!current) return;
      const slot = current.slots.find((candidate) => candidate.callId === call.callId);
      if (!slot || slot.status === "succeeded" || slot.status === "failed") return;
      if (slot.executionLeaseOwner !== leaseOwner) return;
      const saved = await this.options.storage.compareAndSetSlotResult({
        key,
        callId: call.callId,
        expectedRevision: current.revision,
        leaseOwner,
        result: result.value,
        isError: result.isError,
      });
      if (saved) return;
    }
  }

  private async transitionClientDispatch(
    key: ToolExecutionStateKey,
    expectedStatus: ToolExecutionContext["clientDispatchStatus"],
    nextStatus: ToolExecutionContext["clientDispatchStatus"],
    dispatchOutcome?: PersistedResponseSnapshot,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < this.maxStorageAttempts; attempt++) {
      const current = await this.options.storage.get(key);
      if (!current) return false;
      if (current.clientDispatchStatus === nextStatus) return false;
      if (current.clientDispatchStatus !== expectedStatus) return false;
      if (await this.options.storage.compareAndSetClientDispatchStatus({
        key,
        expectedRevision: current.revision,
        expectedStatus,
        nextStatus,
        ...(dispatchOutcome ? { dispatchOutcome } : {}),
      })) return true;
    }
    return false;
  }

  private async prepareObservation(
    key: ToolExecutionStateKey,
    outcome: PersistedResponseSnapshot,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < this.maxStorageAttempts; attempt++) {
      const current = await this.options.storage.get(key);
      if (!current) return false;
      if (current.observationStatus === "pending") {
        return JSON.stringify(current.observationOutcome) === JSON.stringify(outcome);
      }
      if (current.observationStatus && current.observationStatus !== "none") return false;
      if (await this.options.storage.prepareObservation({
        key,
        expectedRevision: current.revision,
        outcome,
      })) return true;
    }
    return false;
  }

  private async markAborted(key: ToolExecutionStateKey): Promise<void> {
    for (let attempt = 0; attempt < this.maxStorageAttempts; attempt++) {
      const current = await this.options.storage.get(key).catch(() => null);
      if (!current || current.responseStreamStatus === "aborted") return;
      if (current.responseStreamStatus !== "streaming") return;
      if (await this.options.storage.markAborted(key, current.revision).catch(() => false)) return;
    }
  }

  private errorDecision(
    failure: CoordinatorFailure,
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
