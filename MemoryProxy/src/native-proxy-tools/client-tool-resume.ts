import { randomUUID } from "node:crypto";

import {
  isToolExecutionContextExpired,
  serializeToolExecutionStateKey,
  type ToolExecutionStorageAdapter,
} from "../db/tool-execution-storage-adapter.js";
import type { UnifiedToolCall } from "../injection/adapters/interface.js";
import { buildToolResultMessage } from "./anthropic-response-rebuilder.js";
import type { NativeProxyToolDispatcher } from "./native-proxy-tool-dispatcher.js";
import type {
  NativeReentryRequest,
  UpstreamRound,
} from "./tool-loop-coordinator.js";
import type {
  JsonValue,
  NativeProxyToolsConfig,
  NativeToolResult,
  ToolCallSlot,
  ToolExecutionContext,
  ToolExecutionScope,
  ToolExecutionStateKey,
  UpstreamRequestSnapshot,
} from "./types.js";

export interface AnthropicClientToolResult {
  callId: string;
  content: JsonValue;
  isError: boolean;
}

export interface ClientToolResumeInput {
  body: Record<string, unknown>;
  scope: ToolExecutionScope;
  storage: ToolExecutionStorageAdapter;
  dispatcher: Pick<NativeProxyToolDispatcher, "execute">;
  limits: NativeProxyToolsConfig;
  reenter(request: NativeReentryRequest): Promise<UpstreamRound>;
  now?: () => Date;
  createId?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  maxStorageAttempts?: number;
}

export type ClientToolResumeDecision =
  | { kind: "not_applicable" }
  | {
      kind: "reentered";
      stateKey: ToolExecutionStateKey;
      upstreamRound: UpstreamRound;
      upstreamSnapshot: UpstreamRequestSnapshot;
      messages: JsonValue[];
      round: number;
      totalCalls: number;
      turnSeq: number;
    }
  | {
      kind: "error";
      code: string;
      message: string;
      status: number;
    };

class ClientToolResumeFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ClientToolResumeFailure";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

/** Extract only the most recent Anthropic user Tool Result turn. */
export function extractAnthropicClientToolResults(
  body: Record<string, unknown>,
): AnthropicClientToolResult[] {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return [];
  const latest = body.messages[body.messages.length - 1];
  if (!isRecord(latest) || latest.role !== "user" || !Array.isArray(latest.content)) return [];

  const results: AnthropicClientToolResult[] = [];
  const seen = new Set<string>();
  for (const block of latest.content) {
    if (!isRecord(block) || block.type !== "tool_result") continue;
    if (typeof block.tool_use_id !== "string" || block.tool_use_id.length === 0) {
      throw new ClientToolResumeFailure(
        "invalid_client_tool_result",
        "Client Tool Result is missing tool_use_id",
        400,
      );
    }
    if (seen.has(block.tool_use_id)) {
      throw new ClientToolResumeFailure(
        "duplicate_client_tool_result",
        "Client request contains a duplicate Tool Result call ID",
        409,
      );
    }
    if (!isJsonValue(block.content)) {
      throw new ClientToolResumeFailure(
        "invalid_client_tool_result",
        "Client Tool Result content is not valid JSON data",
        400,
      );
    }
    if (block.is_error !== undefined && typeof block.is_error !== "boolean") {
      throw new ClientToolResumeFailure(
        "invalid_client_tool_result",
        "Client Tool Result is_error must be boolean",
        400,
      );
    }
    seen.add(block.tool_use_id);
    results.push({
      callId: block.tool_use_id,
      content: structuredClone(block.content),
      isError: block.is_error === true,
    });
  }
  return results;
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

function validateAssistantSkeleton(context: ToolExecutionContext): void {
  const toolBlocks = new Map<string, { position: number; name: string }>();
  for (const [position, value] of context.assistantSkeleton.entries()) {
    if (!isRecord(value) || value.type !== "tool_use") continue;
    if (typeof value.id !== "string" || typeof value.name !== "string" || toolBlocks.has(value.id)) {
      throw new ClientToolResumeFailure(
        "corrupt_assistant_skeleton",
        "Persisted assistant Tool Call skeleton is invalid",
        500,
      );
    }
    toolBlocks.set(value.id, { position, name: value.name });
  }

  let previousPosition = -1;
  for (const slot of [...context.slots].sort((left, right) => left.slotIndex - right.slotIndex)) {
    const block = toolBlocks.get(slot.callId);
    if (!block || block.name !== slot.toolName || block.position <= previousPosition) {
      throw new ClientToolResumeFailure(
        "corrupt_assistant_skeleton",
        "Persisted assistant Tool Call skeleton does not match its slots",
        500,
      );
    }
    previousPosition = block.position;
  }
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

function errorDecision(error: unknown): ClientToolResumeDecision {
  const failure = error instanceof ClientToolResumeFailure
    ? error
    : new ClientToolResumeFailure(
        "native_tool_state_unavailable",
        "Native Proxy Tool state is temporarily unavailable",
        503,
      );
  return {
    kind: "error",
    code: failure.code,
    message: failure.message,
    status: failure.status,
  };
}

export async function resumeClientToolResults(
  input: ClientToolResumeInput,
): Promise<ClientToolResumeDecision> {
  let results: AnthropicClientToolResult[];
  try {
    results = extractAnthropicClientToolResults(input.body);
  } catch (error) {
    return errorDecision(error);
  }
  if (results.length === 0) return { kind: "not_applicable" };

  const now = input.now ?? (() => new Date());
  const createId = input.createId ?? randomUUID;
  const sleep = input.sleep ?? ((milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const pollIntervalMs = Math.max(1, Math.min(
    input.pollIntervalMs ?? 25,
    input.limits.toolTimeoutMs,
  ));
  const maxStorageAttempts = input.maxStorageAttempts ?? 8;

  try {
    const located = await Promise.all(results.map((result) => (
      input.storage.findByCallId(input.scope, result.callId, { includeExpired: true })
    )));
    const known = located.filter((context): context is ToolExecutionContext => context !== null);
    if (known.length === 0) {
      const active = await input.storage.findActiveBySession(input.scope);
      const awaitingClient = active.some((context) => (
        context.responseStreamStatus === "completed"
        && context.clientDispatchStatus === "dispatched"
      ));
      if (awaitingClient) {
        throw new ClientToolResumeFailure(
          "unknown_client_tool_call",
          "Client Tool Result does not belong to the dispatched batch",
          400,
        );
      }
      return { kind: "not_applicable" };
    }
    if (known.some((context) => isToolExecutionContextExpired(context, now()))) {
      throw new ClientToolResumeFailure(
        "expired_tool_batch",
        "Client Tool Result batch has expired",
        410,
      );
    }
    if (known.length !== results.length) {
      throw new ClientToolResumeFailure(
        "unknown_client_tool_call",
        "Client Tool Result contains an unknown call ID",
        400,
      );
    }

    const storageKey = serializeToolExecutionStateKey(known[0].key);
    if (known.some((context) => serializeToolExecutionStateKey(context.key) !== storageKey)) {
      throw new ClientToolResumeFailure(
        "client_tool_batch_mismatch",
        "Client Tool Results span more than one batch",
        400,
      );
    }
    const key = known[0].key;
    let context = await input.storage.get(key);
    if (!context) {
      throw new ClientToolResumeFailure("expired_tool_batch", "Client Tool Result batch has expired", 410);
    }
    if (
      context.responseStreamStatus !== "completed"
      || context.clientDispatchStatus !== "dispatched"
    ) {
      throw new ClientToolResumeFailure(
        "client_tool_batch_not_dispatchable",
        "Client Tool Result batch is not awaiting results",
        409,
      );
    }

    const expectedClientIds = context.slots
      .filter((slot) => slot.owner === "client")
      .map((slot) => slot.callId);
    const resultIds = new Set(results.map((result) => result.callId));
    if (
      expectedClientIds.length !== results.length
      || expectedClientIds.some((callId) => !resultIds.has(callId))
    ) {
      throw new ClientToolResumeFailure(
        "missing_client_tool_result",
        "Client request must return every dispatched Tool Result exactly once",
        400,
      );
    }
    validateAssistantSkeleton(context);
    const clientSlots = context.slots.filter((slot) => slot.owner === "client");
    if (clientSlots.some((slot) => slot.status === "succeeded" || slot.status === "failed")) {
      throw new ClientToolResumeFailure(
        "duplicate_client_tool_result",
        "Client Tool Result has already been accepted",
        409,
      );
    }
    if (clientSlots.some((slot) => slot.status !== "pending")) {
      throw new ClientToolResumeFailure(
        "client_tool_result_conflict",
        "Client Tool Result slot is not pending",
        409,
      );
    }

    for (const result of results) {
      await saveClientResult(input, key, result, maxStorageAttempts);
    }

    context = await waitForAllToolResults({
      ...input,
      now,
      createId,
      sleep,
      pollIntervalMs,
      maxStorageAttempts,
      key,
    });
    await completeClientDispatch(input.storage, key, maxStorageAttempts);

    const messages: JsonValue[] = [
      ...structuredClone(context.upstreamSnapshot.baseMessages),
      asAssistantMessage(context.assistantSkeleton),
      asToolResultMessage(context.slots),
    ];
    const round = context.round + 1;
    let upstreamRound: UpstreamRound;
    try {
      upstreamRound = await input.reenter({
        upstreamSnapshot: structuredClone(context.upstreamSnapshot),
        messages: structuredClone(messages),
        round,
        totalCalls: context.totalCalls,
      });
    } catch {
      throw new ClientToolResumeFailure(
        "native_tool_reentry_failed",
        "Native Proxy Tool re-entry failed",
        502,
      );
    }
    return {
      kind: "reentered",
      stateKey: key,
      upstreamRound,
      upstreamSnapshot: {
        ...structuredClone(context.upstreamSnapshot),
        baseMessages: structuredClone(messages),
      },
      messages,
      round,
      totalCalls: context.totalCalls,
      turnSeq: context.turnSeq,
    };
  } catch (error) {
    return errorDecision(error);
  }
}

async function saveClientResult(
  input: ClientToolResumeInput,
  key: ToolExecutionStateKey,
  result: AnthropicClientToolResult,
  maxStorageAttempts: number,
): Promise<void> {
  for (let attempt = 0; attempt < maxStorageAttempts; attempt++) {
    const context = await input.storage.get(key);
    if (!context) throw new ClientToolResumeFailure(
      "expired_tool_batch",
      "Client Tool Result batch has expired",
      410,
    );
    const slot = context.slots.find((candidate) => candidate.callId === result.callId);
    if (!slot || slot.owner !== "client") {
      throw new ClientToolResumeFailure(
        "unknown_client_tool_call",
        "Client Tool Result does not match a Client-owned slot",
        400,
      );
    }
    if (slot.status === "succeeded" || slot.status === "failed") {
      throw new ClientToolResumeFailure(
        "duplicate_client_tool_result",
        "Client Tool Result has already been accepted",
        409,
      );
    }
    if (slot.status !== "pending") {
      throw new ClientToolResumeFailure(
        "client_tool_result_conflict",
        "Client Tool Result slot is not pending",
        409,
      );
    }
    if (await input.storage.compareAndSetSlotResult({
      key,
      callId: result.callId,
      expectedRevision: context.revision,
      result: result.content,
      isError: result.isError,
    })) return;
  }
  throw new ClientToolResumeFailure(
    "native_tool_state_conflict",
    "Client Tool Result could not be persisted",
    503,
  );
}

interface WaitForResultsInput extends ClientToolResumeInput {
  key: ToolExecutionStateKey;
  now: () => Date;
  createId: () => string;
  sleep: (milliseconds: number) => Promise<void>;
  pollIntervalMs: number;
  maxStorageAttempts: number;
}

async function waitForAllToolResults(input: WaitForResultsInput): Promise<ToolExecutionContext> {
  let remainingWaitMs = input.limits.toolTimeoutMs;
  while (true) {
    const context = await input.storage.get(input.key);
    if (!context) throw new ClientToolResumeFailure(
      "expired_tool_batch",
      "Tool Result batch expired while waiting",
      410,
    );
    const incompleteClients = context.slots.filter((slot) => (
      slot.owner === "client" && slot.status !== "succeeded" && slot.status !== "failed"
    ));
    if (incompleteClients.length > 0) {
      throw new ClientToolResumeFailure(
        "missing_client_tool_result",
        "Client Tool Results were not persisted completely",
        409,
      );
    }
    const incompleteNative = context.slots.filter((slot) => (
      slot.owner === "proxy" && slot.status !== "succeeded" && slot.status !== "failed"
    ));
    if (incompleteNative.length === 0) return context;

    let madeProgress = false;
    for (const slot of incompleteNative) {
      const leaseExpired = slot.status === "running"
        && (!slot.executionLeaseUntil || Date.parse(slot.executionLeaseUntil) <= input.now().getTime());
      if (slot.status === "pending" || leaseExpired) {
        madeProgress = await executeRecoveredSlot(input, slot);
        if (madeProgress) break;
      }
    }
    if (madeProgress) continue;
    if (remainingWaitMs <= 0) {
      throw new ClientToolResumeFailure(
        "native_tool_result_timeout",
        "Timed out waiting for Native Proxy Tool results",
        504,
      );
    }
    const delay = Math.min(input.pollIntervalMs, remainingWaitMs);
    await input.sleep(delay);
    remainingWaitMs -= delay;
  }
}

async function executeRecoveredSlot(
  input: WaitForResultsInput,
  originalSlot: ToolCallSlot,
): Promise<boolean> {
  const leaseOwner = `native-tool-resume-${input.createId()}`;
  const leaseUntil = new Date(
    input.now().getTime() + Math.max(1_000, input.limits.toolTimeoutMs * 2),
  ).toISOString();
  let claimedSlot: ToolCallSlot | undefined;
  for (let attempt = 0; attempt < input.maxStorageAttempts; attempt++) {
    const context = await input.storage.get(input.key);
    if (!context) return false;
    const slot = context.slots.find((candidate) => candidate.callId === originalSlot.callId);
    if (!slot || slot.status === "succeeded" || slot.status === "failed") return false;
    const leaseExpired = slot.status === "running"
      && (!slot.executionLeaseUntil || Date.parse(slot.executionLeaseUntil) <= input.now().getTime());
    if (slot.status !== "pending" && !leaseExpired) return false;
    if (await input.storage.tryClaimSlotExecution({
      key: input.key,
      callId: slot.callId,
      expectedRevision: context.revision,
      leaseOwner,
      leaseUntil,
    })) {
      claimedSlot = slot;
      break;
    }
  }
  if (!claimedSlot) return false;

  const call: UnifiedToolCall = {
    callId: claimedSlot.callId,
    toolName: claimedSlot.toolName,
    owner: "proxy",
    slotIndex: claimedSlot.slotIndex,
    contentBlockIndex: claimedSlot.contentBlockIndex,
    argumentsComplete: true,
    ...(claimedSlot.input !== undefined ? { input: structuredClone(claimedSlot.input) } : {}),
  };
  let result: NativeToolResult;
  try {
    result = await input.dispatcher.execute(call, input.scope);
  } catch {
    result = genericExecutionError();
  }

  for (let attempt = 0; attempt < input.maxStorageAttempts; attempt++) {
    const context = await input.storage.get(input.key);
    if (!context) return false;
    const slot = context.slots.find((candidate) => candidate.callId === call.callId);
    if (!slot || slot.status === "succeeded" || slot.status === "failed") return true;
    if (slot.executionLeaseOwner !== leaseOwner) return false;
    if (await input.storage.compareAndSetSlotResult({
      key: input.key,
      callId: call.callId,
      expectedRevision: context.revision,
      leaseOwner,
      result: result.value,
      isError: result.isError,
    })) return true;
  }
  return false;
}

async function completeClientDispatch(
  storage: ToolExecutionStorageAdapter,
  key: ToolExecutionStateKey,
  maxStorageAttempts: number,
): Promise<void> {
  for (let attempt = 0; attempt < maxStorageAttempts; attempt++) {
    const context = await storage.get(key);
    if (!context) throw new ClientToolResumeFailure(
      "expired_tool_batch",
      "Tool Result batch expired before re-entry",
      410,
    );
    if (context.clientDispatchStatus === "completed") {
      throw new ClientToolResumeFailure(
        "tool_batch_already_resumed",
        "Tool Result batch has already resumed",
        409,
      );
    }
    if (context.clientDispatchStatus !== "dispatched") {
      throw new ClientToolResumeFailure(
        "client_tool_batch_not_dispatchable",
        "Tool Result batch is not dispatchable",
        409,
      );
    }
    if (await storage.compareAndSetClientDispatchStatus({
      key,
      expectedRevision: context.revision,
      expectedStatus: "dispatched",
      nextStatus: "completed",
    })) return;
  }
  throw new ClientToolResumeFailure(
    "native_tool_state_conflict",
    "Tool Result batch could not be claimed for re-entry",
    503,
  );
}
