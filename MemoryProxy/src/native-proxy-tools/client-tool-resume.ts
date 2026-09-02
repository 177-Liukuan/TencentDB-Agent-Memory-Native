import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  isReplaySafeResponseHeader,
  isToolExecutionContextExpired,
  serializeToolExecutionStateKey,
  type ToolExecutionStorageAdapter,
} from "../db/tool-execution-storage-adapter.js";
import type { NativeToolHistoryStorageAdapter } from "../db/native-tool-history-storage-adapter.js";
import type { UnifiedToolCall } from "../injection/adapters/interface.js";
import {
  buildToolResultMessage,
  mergeNativeToolLeakMarkers,
} from "./anthropic-response-rebuilder.js";
import { NativeToolTargetUnavailableError } from "./exact-target-transport.js";
import { openAIAssistantMessageFromSkeleton } from "./openai-response-rebuilder.js";
import { buildNativeToolHistoryRecord } from "./native-tool-history-record.js";
import type { NativeProxyToolDispatcher } from "./native-proxy-tool-dispatcher.js";
import type {
  NativeReentryRequest,
  UpstreamRound,
} from "./tool-loop-coordinator.js";
import type {
  JsonValue,
  NativeProxyToolsConfig,
  NativeToolLeakMarker,
  NativeToolResult,
  PersistedReentryOutcome,
  ToolCallSlot,
  ToolExecutionContext,
  ToolExecutionScope,
  ToolExecutionStateKey,
  UpstreamRequestSnapshot,
} from "./types.js";
import { nativeToolLeaseDurationMs } from "./types.js";

export interface AnthropicClientToolResult {
  callId: string;
  content: JsonValue;
  isError: boolean;
}

export interface ClientToolResumeInput {
  body: Record<string, unknown>;
  scope: ToolExecutionScope;
  storage: ToolExecutionStorageAdapter;
  historyStorage?: NativeToolHistoryStorageAdapter;
  dispatcher: Pick<NativeProxyToolDispatcher, "execute">;
  limits: NativeProxyToolsConfig;
  reenter(request: NativeReentryRequest, stateKey: ToolExecutionStateKey): Promise<UpstreamRound>;
  now?: () => Date;
  createId?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  maxStorageAttempts?: number;
  /** Bound the durable re-entry lease to the actual upstream request window. */
  reentryLeaseMs?: number;
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
      reentryLeaseOwner: string;
      reentryAttempt: number;
      logicalMessages: JsonValue[];
      nativeLeakMarkers: NativeToolLeakMarker[];
    }
  | {
      kind: "replay";
      stateKey: ToolExecutionStateKey;
      bytes: Uint8Array;
      status: number;
      headers: Headers;
      outcomeKind: PersistedReentryOutcome["kind"];
      childStateKey?: ToolExecutionStateKey;
      turnSeq: number;
      logicalMessages: JsonValue[];
      nativeLeakMarkers: NativeToolLeakMarker[];
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

export function createPersistedClientReentryOutcome(input: {
  kind: PersistedReentryOutcome["kind"];
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  childStateKey?: ToolExecutionStateKey;
}): PersistedReentryOutcome {
  const headers: Record<string, string> = {};
  for (const [rawName, value] of input.headers.entries()) {
    const name = rawName.toLowerCase();
    if (isReplaySafeResponseHeader(name)) {
      headers[name] = value;
    }
  }
  return {
    kind: input.kind,
    status: input.status,
    headers,
    bodyBase64: Buffer.from(input.bytes).toString("base64"),
    ...(input.childStateKey ? { childStateKey: structuredClone(input.childStateKey) } : {}),
  };
}

function restorePersistedClientReentryOutcome(outcome: PersistedReentryOutcome): {
  bytes: Uint8Array;
  status: number;
  headers: Headers;
  outcomeKind: PersistedReentryOutcome["kind"];
  childStateKey?: ToolExecutionStateKey;
} {
  return {
    bytes: new Uint8Array(Buffer.from(outcome.bodyBase64, "base64")),
    status: outcome.status,
    headers: new Headers(outcome.headers),
    outcomeKind: outcome.kind,
    ...(outcome.childStateKey ? { childStateKey: structuredClone(outcome.childStateKey) } : {}),
  };
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

function extractOpenAIClientToolResults(body: Record<string, unknown>): AnthropicClientToolResult[] {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return [];
  const suffix: Record<string, unknown>[] = [];
  for (let index = body.messages.length - 1; index >= 0; index--) {
    const message = body.messages[index];
    if (!isRecord(message) || message.role !== "tool") break;
    suffix.push(message);
  }
  suffix.reverse();
  const seen = new Set<string>();
  return suffix.map((message) => {
    if (typeof message.tool_call_id !== "string" || message.tool_call_id.length === 0) {
      throw new ClientToolResumeFailure(
        "invalid_client_tool_result",
        "Client Tool Result is missing tool_call_id",
        400,
      );
    }
    if (seen.has(message.tool_call_id)) {
      throw new ClientToolResumeFailure(
        "duplicate_client_tool_result",
        "Client request contains a duplicate Tool Result call ID",
        409,
      );
    }
    if (!isJsonValue(message.content)) {
      throw new ClientToolResumeFailure(
        "invalid_client_tool_result",
        "Client Tool Result content is not valid JSON data",
        400,
      );
    }
    seen.add(message.tool_call_id);
    return {
      callId: message.tool_call_id,
      content: structuredClone(message.content),
      isError: false,
    };
  });
}

function extractResponsesClientToolResults(body: Record<string, unknown>): AnthropicClientToolResult[] {
  if (!Array.isArray(body.input) || body.input.length === 0) return [];
  const suffix: Record<string, unknown>[] = [];
  for (let index = body.input.length - 1; index >= 0; index--) {
    const item = body.input[index];
    if (!isRecord(item) || item.type !== "function_call_output") break;
    suffix.push(item);
  }
  suffix.reverse();
  const seen = new Set<string>();
  return suffix.map((item) => {
    if (typeof item.call_id !== "string" || item.call_id.length === 0) {
      throw new ClientToolResumeFailure("invalid_client_tool_result", "Client Tool Result is missing call_id", 400);
    }
    if (seen.has(item.call_id)) {
      throw new ClientToolResumeFailure("duplicate_client_tool_result", "Client request contains a duplicate Tool Result call ID", 409);
    }
    if (!isJsonValue(item.output)) {
      throw new ClientToolResumeFailure("invalid_client_tool_result", "Client Tool Result output is not valid JSON data", 400);
    }
    seen.add(item.call_id);
    return { callId: item.call_id, content: structuredClone(item.output), isError: false };
  });
}

/** Extract the current protocol's most recent Client Tool Result batch. */
export function extractClientToolResults(body: Record<string, unknown>): AnthropicClientToolResult[] {
  if (Array.isArray(body.input)) return extractResponsesClientToolResults(body);
  const latest = Array.isArray(body.messages) ? body.messages.at(-1) : undefined;
  return isRecord(latest) && latest.role === "tool"
    ? extractOpenAIClientToolResults(body)
    : extractAnthropicClientToolResults(body);
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
  if (context.protocol === "responses") {
    const toolCalls = new Map<string, { position: number; name: string }>();
    for (const [position, value] of context.assistantSkeleton.entries()) {
      if (!isRecord(value) || value.type !== "function_call") continue;
      if (typeof value.call_id !== "string" || typeof value.name !== "string" || toolCalls.has(value.call_id)) {
        throw new ClientToolResumeFailure("corrupt_assistant_skeleton", "Persisted assistant Tool Call skeleton is invalid", 500);
      }
      toolCalls.set(value.call_id, { position, name: value.name });
    }
    let previousPosition = -1;
    for (const slot of [...context.slots].sort((left, right) => left.slotIndex - right.slotIndex)) {
      const call = toolCalls.get(slot.callId);
      if (!call || call.name !== slot.toolName || call.position <= previousPosition) {
        throw new ClientToolResumeFailure("corrupt_assistant_skeleton", "Persisted assistant Tool Call skeleton does not match its slots", 500);
      }
      previousPosition = call.position;
    }
    return;
  }
  if (context.protocol === "openai") {
    const toolCalls = new Map<string, { position: number; name: string }>();
    for (const [position, value] of context.assistantSkeleton.entries()) {
      if (!isRecord(value) || value.type !== "function" || !isRecord(value.function)) continue;
      const fn = value.function;
      if (
        typeof value.id !== "string"
        || typeof fn.name !== "string"
        || toolCalls.has(value.id)
      ) throw new ClientToolResumeFailure(
        "corrupt_assistant_skeleton",
        "Persisted assistant Tool Call skeleton is invalid",
        500,
      );
      toolCalls.set(value.id, { position, name: fn.name });
    }
    let previousPosition = -1;
    for (const slot of [...context.slots].sort((left, right) => left.slotIndex - right.slotIndex)) {
      const call = toolCalls.get(slot.callId);
      if (!call || call.name !== slot.toolName || call.position <= previousPosition) {
        throw new ClientToolResumeFailure(
          "corrupt_assistant_skeleton",
          "Persisted assistant Tool Call skeleton does not match its slots",
          500,
        );
      }
      previousPosition = call.position;
    }
    return;
  }
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

function asAssistantMessages(context: ToolExecutionContext): JsonValue[] {
  if (context.protocol === "responses") return structuredClone(context.assistantSkeleton);
  if (context.protocol === "openai") {
    return [openAIAssistantMessageFromSkeleton(context.assistantSkeleton)];
  }
  return [{
    role: "assistant",
    content: structuredClone(context.assistantSkeleton),
  }];
}

function asToolResultMessages(context: ToolExecutionContext): JsonValue[] {
  if (context.protocol === "responses") {
    return [...context.slots].sort((left, right) => left.slotIndex - right.slotIndex).map((slot) => ({
      type: "function_call_output",
      call_id: slot.callId,
      output: typeof slot.result === "string" ? slot.result : JSON.stringify(slot.result ?? null),
    }));
  }
  if (context.protocol === "openai") {
    return [...context.slots]
      .sort((left, right) => left.slotIndex - right.slotIndex)
      .map((slot) => ({
        role: "tool",
        tool_call_id: slot.callId,
        content: typeof slot.result === "string" ? slot.result : JSON.stringify(slot.result ?? null),
      }));
  }
  return [buildToolResultMessage(context.slots) as unknown as JsonValue];
}

function logicalMessages(context: ToolExecutionContext): JsonValue[] {
  return structuredClone(
    context.upstreamSnapshot.logicalBaseMessages
      ?? context.upstreamSnapshot.baseMessages,
  );
}

function nativeLeakMarkers(context: ToolExecutionContext): NativeToolLeakMarker[] {
  return mergeNativeToolLeakMarkers(
    context.upstreamSnapshot.nativeLeakMarkers ?? [],
    context.slots
      .filter((slot) => slot.owner === "proxy")
      .map((slot) => ({
        callId: slot.callId,
        toolName: slot.toolName,
        ...(slot.input !== undefined ? { input: structuredClone(slot.input) } : {}),
      })),
  );
}

function samePersistedReentryOutcome(
  left: PersistedReentryOutcome,
  right: PersistedReentryOutcome,
): boolean {
  if (
    left.kind !== right.kind
    || left.status !== right.status
    || left.bodyBase64 !== right.bodyBase64
    || !isRecord(left.headers)
    || !isRecord(right.headers)
  ) return false;
  const leftHeaders = Object.entries(left.headers).sort(([a], [b]) => a.localeCompare(b));
  const rightHeaders = Object.entries(right.headers).sort(([a], [b]) => a.localeCompare(b));
  if (
    leftHeaders.length !== rightHeaders.length
    || leftHeaders.some(([name, value], index) => (
      name !== rightHeaders[index]?.[0] || value !== rightHeaders[index]?.[1]
    ))
  ) return false;
  if (!left.childStateKey || !right.childStateKey) {
    return left.childStateKey === right.childStateKey;
  }
  return serializeToolExecutionStateKey(left.childStateKey)
    === serializeToolExecutionStateKey(right.childStateKey);
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
    results = extractClientToolResults(input.body);
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
      input.storage.findByCallId(input.scope, result.callId, {
        includeExpired: true,
        dispatchableOnly: true,
      })
    )));
    const known = located.filter((context): context is ToolExecutionContext => context !== null);
    if (known.length === 0) {
      const active = await input.storage.findActiveBySession(input.scope);
      const awaitingClient = active.some((context) => (
        context.responseStreamStatus === "completed"
        && (context.clientDispatchStatus === "dispatched"
          || context.clientDispatchStatus === "resuming")
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
      || (context.clientDispatchStatus !== "dispatched"
        && context.clientDispatchStatus !== "resuming"
        && context.clientDispatchStatus !== "completed")
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
    if (clientSlots.some((slot) => (
      slot.status !== "pending" && slot.status !== "succeeded" && slot.status !== "failed"
    ))) {
      throw new ClientToolResumeFailure(
        "client_tool_result_conflict",
        "Client Tool Result slot is not pending",
        409,
      );
    }
    for (const result of results) {
      const slot = clientSlots.find((candidate) => candidate.callId === result.callId)!;
      if (
        (slot.status === "succeeded" || slot.status === "failed")
        && !sameAcceptedClientResult(slot, result)
      ) {
        throw new ClientToolResumeFailure(
          "duplicate_client_tool_result",
          "Client Tool Result conflicts with the already accepted value",
          409,
        );
      }
    }

    if (context.clientDispatchStatus === "completed") {
      if (!context.reentryOutcome) {
        throw new ClientToolResumeFailure(
          "tool_batch_already_resumed",
          "Tool Result batch has already resumed without a replayable outcome",
          409,
        );
      }
      if (context.reentryOutcome.kind === "client_dispatch") {
        await ensureClientDispatchReady(
          input.storage,
          key,
          context.reentryOutcome,
          maxStorageAttempts,
        );
      }
      return {
        kind: "replay",
        stateKey: key,
        ...restorePersistedClientReentryOutcome(context.reentryOutcome),
        turnSeq: context.turnSeq,
        logicalMessages: logicalMessages(context),
        nativeLeakMarkers: nativeLeakMarkers(context),
      };
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
    const reentryClaim = await claimClientReentry({
      storage: input.storage,
      key,
      now,
      createId,
      limits: input.limits,
      reentryLeaseMs: input.reentryLeaseMs,
      maxStorageAttempts,
    });

    const messages: JsonValue[] = [
      ...structuredClone(context.upstreamSnapshot.baseMessages),
      ...asAssistantMessages(context),
      ...asToolResultMessages(context),
    ];
    if (input.historyStorage) {
      try {
        await input.historyStorage.appendCompletedBatch(buildNativeToolHistoryRecord(context));
      } catch {
        throw new ClientToolResumeFailure(
          "native_tool_history_unavailable",
          "Native Proxy Tool history could not be saved",
          503,
        );
      }
    }
    const round = context.round + 1;
    let upstreamRound: UpstreamRound;
    try {
      upstreamRound = await input.reenter({
        upstreamSnapshot: structuredClone(context.upstreamSnapshot),
        messages: structuredClone(messages),
        round,
        totalCalls: context.totalCalls,
      }, key);
    } catch (error) {
      if (error instanceof NativeToolTargetUnavailableError) {
        throw new ClientToolResumeFailure(
          "native_tool_target_unavailable",
          "The persisted Native Proxy Tool upstream target is unavailable",
          503,
        );
      }
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
        nativeLeakMarkers: nativeLeakMarkers(context),
      },
      messages,
      round,
      totalCalls: context.totalCalls,
      turnSeq: context.turnSeq,
      reentryLeaseOwner: reentryClaim.leaseOwner,
      reentryAttempt: reentryClaim.attempt,
      logicalMessages: logicalMessages(context),
      nativeLeakMarkers: nativeLeakMarkers(context),
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
      if (sameAcceptedClientResult(slot, result)) return;
      throw new ClientToolResumeFailure(
        "duplicate_client_tool_result",
        "Client Tool Result conflicts with the already accepted value",
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
  const startedAt = input.now().getTime();
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
    const currentTime = input.now().getTime();
    const activeLeaseDeadline = incompleteNative.reduce((latest, slot) => {
      const leaseUntil = slot.executionLeaseUntil
        ? Date.parse(slot.executionLeaseUntil)
        : Number.NaN;
      return Number.isFinite(leaseUntil) && leaseUntil > currentTime
        ? Math.max(latest, leaseUntil + input.limits.toolTimeoutMs)
        : latest;
    }, startedAt + input.limits.toolTimeoutMs);
    const deadline = Math.min(Date.parse(context.expiresAt), activeLeaseDeadline);
    const remainingWaitMs = deadline - currentTime;
    if (remainingWaitMs <= 0) {
      throw new ClientToolResumeFailure(
        "native_tool_result_timeout",
        "Timed out waiting for Native Proxy Tool results",
        504,
      );
    }
    const delay = Math.min(input.pollIntervalMs, remainingWaitMs);
    await input.sleep(delay);
  }
}

async function executeRecoveredSlot(
  input: WaitForResultsInput,
  originalSlot: ToolCallSlot,
): Promise<boolean> {
  const leaseOwner = `native-tool-resume-${input.createId()}`;
  const leaseUntil = new Date(
    input.now().getTime() + nativeToolLeaseDurationMs(input.limits.toolTimeoutMs),
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

function stableJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, child]) => [name, stableJson(child)]),
    );
  }
  return value;
}

function sameAcceptedClientResult(
  slot: ToolCallSlot,
  result: AnthropicClientToolResult,
): boolean {
  return slot.isError === result.isError
    && slot.result !== undefined
    && JSON.stringify(stableJson(slot.result)) === JSON.stringify(stableJson(result.content));
}

interface ClaimClientReentryInput {
  storage: ToolExecutionStorageAdapter;
  key: ToolExecutionStateKey;
  now: () => Date;
  createId: () => string;
  limits: NativeProxyToolsConfig;
  reentryLeaseMs?: number;
  maxStorageAttempts: number;
}

async function claimClientReentry(
  input: ClaimClientReentryInput,
): Promise<{ leaseOwner: string; attempt: number }> {
  const leaseOwner = `native-tool-reentry-${input.createId()}`;
  const leaseUntil = new Date(
    input.now().getTime() + Math.max(
      nativeToolLeaseDurationMs(input.limits.toolTimeoutMs),
      input.reentryLeaseMs ?? 0,
    ),
  ).toISOString();
  for (let attempt = 0; attempt < input.maxStorageAttempts; attempt++) {
    const context = await input.storage.get(input.key);
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
    if (
      context.clientDispatchStatus === "resuming"
      && context.reentryLeaseUntil
      && Date.parse(context.reentryLeaseUntil) > input.now().getTime()
    ) {
      throw new ClientToolResumeFailure(
        "native_tool_reentry_in_progress",
        "Tool Result batch re-entry is already in progress",
        409,
      );
    }
    if (
      context.clientDispatchStatus !== "dispatched"
      && context.clientDispatchStatus !== "resuming"
    ) {
      throw new ClientToolResumeFailure(
        "client_tool_batch_not_dispatchable",
        "Tool Result batch is not dispatchable",
        409,
      );
    }
    if (await input.storage.tryClaimReentry({
      key: input.key,
      expectedRevision: context.revision,
      leaseOwner,
      leaseUntil,
    })) return {
      leaseOwner,
      attempt: (context.reentryAttempt ?? 0) + 1,
    };
  }
  throw new ClientToolResumeFailure(
    "native_tool_state_conflict",
    "Tool Result batch could not be claimed for re-entry",
    503,
  );
}

function sameResponseSnapshot(
  context: ToolExecutionContext,
  outcome: PersistedReentryOutcome,
): boolean {
  const childOutcome = context.clientDispatchOutcome;
  return childOutcome !== undefined
    && childOutcome.status === outcome.status
    && childOutcome.bodyBase64 === outcome.bodyBase64
    && JSON.stringify(Object.entries(childOutcome.headers).sort())
      === JSON.stringify(Object.entries(outcome.headers).sort());
}

/**
 * Finish the prepared child dispatch after a crash between parent outbox commit
 * and the child's pending -> dispatched transition.
 */
export async function ensureClientDispatchReady(
  storage: ToolExecutionStorageAdapter,
  parentKey: ToolExecutionStateKey,
  outcome: PersistedReentryOutcome,
  maxStorageAttempts = 8,
): Promise<void> {
  if (outcome.kind !== "client_dispatch" || !outcome.childStateKey) return;
  for (let attempt = 0; attempt < maxStorageAttempts; attempt++) {
    const child = await storage.get(outcome.childStateKey);
    if (!child) throw new ClientToolResumeFailure(
      "native_tool_child_state_unavailable",
      "Client Tool continuation state is unavailable",
      503,
    );
    if (
      !child.parentStateKey
      || serializeToolExecutionStateKey(child.parentStateKey) !== serializeToolExecutionStateKey(parentKey)
      || child.responseStreamStatus !== "completed"
      || !sameResponseSnapshot(child, outcome)
    ) {
      throw new ClientToolResumeFailure(
        "native_tool_child_state_conflict",
        "Client Tool continuation state does not match its parent outcome",
        409,
      );
    }
    if (["dispatched", "resuming", "completed"].includes(child.clientDispatchStatus)) return;
    if (child.clientDispatchStatus !== "pending") {
      throw new ClientToolResumeFailure(
        "native_tool_child_state_conflict",
        "Client Tool continuation is not prepared for dispatch",
        409,
      );
    }
    if (await storage.compareAndSetClientDispatchStatus({
      key: child.key,
      expectedRevision: child.revision,
      expectedStatus: "pending",
      nextStatus: "dispatched",
    })) return;
  }
  throw new ClientToolResumeFailure(
    "native_tool_state_conflict",
    "Client Tool continuation could not be dispatched",
    503,
  );
}

export async function renewClientToolReentry(
  storage: ToolExecutionStorageAdapter,
  key: ToolExecutionStateKey,
  leaseOwner: string,
  leaseMs: number,
  now: () => Date = () => new Date(),
  maxStorageAttempts = 8,
): Promise<void> {
  const leaseUntil = new Date(now().getTime() + Math.max(1, leaseMs)).toISOString();
  for (let attempt = 0; attempt < maxStorageAttempts; attempt++) {
    const context = await storage.get(key);
    if (!context) throw new ClientToolResumeFailure(
      "expired_tool_batch",
      "Tool Result batch expired during re-entry",
      410,
    );
    if (
      context.clientDispatchStatus !== "resuming"
      || context.reentryLeaseOwner !== leaseOwner
    ) {
      throw new ClientToolResumeFailure(
        "native_tool_reentry_lease_lost",
        "Tool Result batch re-entry lease was lost",
        409,
      );
    }
    if (await storage.renewReentry({
      key,
      expectedRevision: context.revision,
      leaseOwner,
      leaseUntil,
    })) return;
  }
  throw new ClientToolResumeFailure(
    "native_tool_state_conflict",
    "Tool Result batch re-entry lease could not be renewed",
    503,
  );
}

export async function completeClientToolReentry(
  storage: ToolExecutionStorageAdapter,
  key: ToolExecutionStateKey,
  leaseOwner: string,
  outcome: PersistedReentryOutcome,
  maxStorageAttempts = 8,
): Promise<void> {
  for (let attempt = 0; attempt < maxStorageAttempts; attempt++) {
    const context = await storage.get(key);
    if (!context) throw new ClientToolResumeFailure(
      "expired_tool_batch",
      "Tool Result batch expired before re-entry",
      410,
    );
    if (context.clientDispatchStatus === "completed") {
      if (context.reentryLeaseOwner !== leaseOwner) {
        throw new ClientToolResumeFailure(
          "native_tool_reentry_lease_lost",
          "Tool Result batch was completed by another re-entry lease owner",
          409,
        );
      }
      if (
        !context.reentryOutcome
        || !samePersistedReentryOutcome(context.reentryOutcome, outcome)
      ) {
        throw new ClientToolResumeFailure(
          "native_tool_reentry_outcome_conflict",
          "Tool Result batch already has a different re-entry outcome",
          409,
        );
      }
      return;
    }
    if (
      context.clientDispatchStatus !== "resuming"
      || context.reentryLeaseOwner !== leaseOwner
    ) {
      throw new ClientToolResumeFailure(
        "client_tool_batch_not_dispatchable",
        "Tool Result batch is not dispatchable",
        409,
      );
    }
    if (await storage.completeReentry({
      key,
      expectedRevision: context.revision,
      leaseOwner,
      outcome,
    })) return;
  }
  throw new ClientToolResumeFailure(
    "native_tool_state_conflict",
    "Tool Result batch could not be claimed for re-entry",
    503,
  );
}
