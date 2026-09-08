import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  isReplaySafeResponseHeader,
  type ToolExecutionStorageAdapter,
} from "../db/tool-execution-storage-adapter.js";
import type { NativeToolLedgerStorageAdapter } from "../db/native-tool-ledger-storage-adapter.js";
import type { UnifiedToolCall } from "../injection/adapters/interface.js";
import { buildNativeToolLedgerRound } from "./tool-ledger-round.js";
import type { NativeProxyToolDispatcher } from "./native-proxy-tool-dispatcher.js";
import { nativeToolLeaseDurationMs } from "./types.js";
import type {
  JsonValue,
  NativeProxyToolsConfig,
  NativeToolResult,
  PersistedResponseSnapshot,
  ToolCallSlot,
  ToolExecutionContext,
  ToolExecutionScope,
  ToolExecutionStateKey,
  UpstreamRequestSnapshot,
} from "./types.js";

export class ToolLoopCoreFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ToolLoopCoreFailure";
  }
}

export interface ToolLoopExecutionCoreOptions {
  signal?: AbortSignal;
  storage: ToolExecutionStorageAdapter;
  ledgerStorage?: NativeToolLedgerStorageAdapter;
  dispatcher: Pick<NativeProxyToolDispatcher, "execute">;
  limits: NativeProxyToolsConfig;
  now?: () => Date;
  createId?: () => string;
  maxStorageAttempts?: number;
}

export interface ToolLoopLimitInput {
  round: number;
  totalCalls: number;
  callsThisRound: number;
}

export interface ToolLoopBatchInput {
  protocol: ToolExecutionContext["protocol"];
  scope: ToolExecutionScope;
  turnSeq: number;
  upstreamSnapshot: UpstreamRequestSnapshot;
  round: number;
  totalCalls: number;
  calls: readonly UnifiedToolCall[];
  assistantSkeleton: JsonValue[];
  responseStreamStatus: ToolExecutionContext["responseStreamStatus"];
  parentStateKey?: ToolExecutionStateKey;
  parentReentryAttempt?: number;
}

export interface ToolLoopSnapshotInput {
  key: ToolExecutionStateKey;
  assistantSkeleton: JsonValue[];
  calls: readonly UnifiedToolCall[];
  responseStreamStatus: ToolExecutionContext["responseStreamStatus"];
  totalCalls: number;
}

export function slotsFromUnifiedCalls(
  calls: readonly UnifiedToolCall[],
): ToolCallSlot[] {
  return calls.map((call) => ({
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

export function persistToolLoopResponse(
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

/**
 * Protocol-neutral durable state and execution engine for Native Tool loops.
 * Wire parsing, round completion, response rebuilding, and protocol errors stay
 * in the protocol coordinators.
 */
export class ToolLoopExecutionCore {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly maxStorageAttempts: number;

  constructor(private readonly options: ToolLoopExecutionCoreOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.maxStorageAttempts = options.maxStorageAttempts ?? 8;
  }

  limitFailure(input: ToolLoopLimitInput): ToolLoopCoreFailure | null {
    const { maxRounds, maxCallsPerRound, maxTotalCalls } = this.options.limits;
    if (
      (maxRounds > 0 && input.round > maxRounds)
      || (maxCallsPerRound > 0 && input.callsThisRound > maxCallsPerRound)
      || (maxTotalCalls > 0 && input.totalCalls + input.callsThisRound > maxTotalCalls)
    ) {
      return new ToolLoopCoreFailure(
        "native_tool_limit_exceeded",
        "Native Proxy Tool loop limit exceeded",
        400,
      );
    }
    return null;
  }

  async createBatch(input: ToolLoopBatchInput): Promise<ToolExecutionStateKey> {
    const timestamp = this.now();
    const key: ToolExecutionStateKey = {
      ...input.scope,
      toolBatchId: this.createId(),
    };
    const context: ToolExecutionContext = {
      key,
      turnSeq: input.turnSeq,
      protocol: input.protocol,
      round: input.round,
      totalCalls: input.totalCalls
        + input.calls.filter((call) => call.owner === "proxy").length,
      assistantSkeleton: structuredClone(input.assistantSkeleton),
      slots: slotsFromUnifiedCalls(input.calls),
      responseStreamStatus: input.responseStreamStatus,
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

  async persistStreamSnapshot(input: ToolLoopSnapshotInput): Promise<void> {
    for (let attempt = 0; attempt < this.maxStorageAttempts; attempt++) {
      const current = await this.options.storage.get(input.key);
      if (!current) {
        throw new ToolLoopCoreFailure(
          "native_tool_state_unavailable",
          "Native Proxy Tool state expired or disappeared",
          503,
        );
      }
      if (current.responseStreamStatus === "aborted") {
        throw new ToolLoopCoreFailure(
          "native_tool_state_aborted",
          "Native Proxy Tool batch was aborted",
          409,
        );
      }
      if (await this.options.storage.compareAndSetStreamSnapshot({
        key: input.key,
        expectedRevision: current.revision,
        assistantSkeleton: structuredClone(input.assistantSkeleton),
        slots: slotsFromUnifiedCalls(input.calls),
        responseStreamStatus: input.responseStreamStatus,
        totalCalls: input.totalCalls,
      })) return;
    }
    throw new ToolLoopCoreFailure(
      "native_tool_state_conflict",
      "Native Proxy Tool state could not be updated",
      503,
    );
  }

  async executeAndPersist(
    call: UnifiedToolCall,
    scope: ToolExecutionScope,
    key: ToolExecutionStateKey,
  ): Promise<void> {
    this.options.signal?.throwIfAborted();
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
      this.options.signal?.throwIfAborted();
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
      result = await this.options.dispatcher.execute(call, scope, this.options.signal);
    } catch {
      result = genericExecutionError();
    }
    for (let attempt = 0; attempt < this.maxStorageAttempts; attempt++) {
      const current = await this.options.storage.get(key);
      if (!current) return;
      const slot = current.slots.find((candidate) => candidate.callId === call.callId);
      if (!slot || slot.status === "succeeded" || slot.status === "failed") return;
      if (slot.executionLeaseOwner !== leaseOwner) return;
      if (await this.options.storage.compareAndSetSlotResult({
        key,
        callId: call.callId,
        expectedRevision: current.revision,
        leaseOwner,
        result: result.value,
        isError: result.isError,
      })) return;
    }
  }

  async persistCompletedHistory(key: ToolExecutionStateKey): Promise<void> {
    if (!this.options.ledgerStorage) return;
    const context = await this.options.storage.get(key);
    if (!context) {
      throw new ToolLoopCoreFailure(
        "native_tool_state_unavailable",
        "Native Proxy Tool state expired before history was saved",
        503,
      );
    }
    try {
      await this.options.ledgerStorage.appendRound(buildNativeToolLedgerRound(context));
    } catch {
      throw new ToolLoopCoreFailure(
        "native_tool_history_unavailable",
        "Native Proxy Tool history could not be saved",
        503,
      );
    }
  }

  async transitionClientDispatch(
    key: ToolExecutionStateKey,
    expectedStatus: ToolExecutionContext["clientDispatchStatus"],
    nextStatus: ToolExecutionContext["clientDispatchStatus"],
    dispatchOutcome?: PersistedResponseSnapshot,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < this.maxStorageAttempts; attempt++) {
      const current = await this.options.storage.get(key);
      if (!current || current.clientDispatchStatus !== expectedStatus) return false;
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

  async prepareObservation(
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

  async markAborted(key: ToolExecutionStateKey): Promise<void> {
    for (let attempt = 0; attempt < this.maxStorageAttempts; attempt++) {
      const current = await this.options.storage.get(key).catch(() => null);
      if (!current || current.responseStreamStatus === "aborted") return;
      if (current.responseStreamStatus !== "streaming") return;
      if (await this.options.storage.markAborted(key, current.revision).catch(() => false)) return;
    }
  }
}
