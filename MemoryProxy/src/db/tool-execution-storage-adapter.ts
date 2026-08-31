import type {
  ClientDispatchStatus,
  JsonValue,
  ResponseStreamStatus,
  ToolCallSlot,
  ToolExecutionContext,
  ToolExecutionScope,
  ToolExecutionStateKey,
} from "../native-proxy-tools/types.js";

export interface StreamSnapshotCas {
  key: ToolExecutionStateKey;
  expectedRevision: number;
  assistantSkeleton: JsonValue[];
  slots: ToolCallSlot[];
  responseStreamStatus: ResponseStreamStatus;
}

export interface ClientDispatchCas {
  key: ToolExecutionStateKey;
  expectedRevision: number;
  expectedStatus: ClientDispatchStatus;
  nextStatus: ClientDispatchStatus;
}

export interface SlotExecutionClaim {
  key: ToolExecutionStateKey;
  callId: string;
  expectedRevision: number;
  leaseOwner: string;
  leaseUntil: string;
}

export interface SlotResultCas {
  key: ToolExecutionStateKey;
  callId: string;
  expectedRevision: number;
  leaseOwner?: string;
  result: JsonValue;
  isError: boolean;
}

export interface ToolExecutionStorageAdapter {
  initializeAndProbe(): Promise<void>;
  create(context: ToolExecutionContext): Promise<void>;
  get(key: ToolExecutionStateKey): Promise<ToolExecutionContext | null>;
  findByCallId(
    scope: ToolExecutionScope,
    callId: string,
  ): Promise<ToolExecutionContext | null>;
  findActiveBySession(scope: ToolExecutionScope): Promise<ToolExecutionContext[]>;
  compareAndSetStreamSnapshot(update: StreamSnapshotCas): Promise<boolean>;
  compareAndSetClientDispatchStatus(update: ClientDispatchCas): Promise<boolean>;
  tryClaimSlotExecution(claim: SlotExecutionClaim): Promise<boolean>;
  compareAndSetSlotResult(update: SlotResultCas): Promise<boolean>;
  markAborted(key: ToolExecutionStateKey, expectedRevision: number): Promise<boolean>;
  close(): Promise<void>;
}

export class ToolExecutionStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolExecutionStorageError";
  }
}

export class ToolExecutionConflictError extends ToolExecutionStorageError {
  constructor(message: string) {
    super(message);
    this.name = "ToolExecutionConflictError";
  }
}

export class ToolExecutionValidationError extends ToolExecutionStorageError {
  constructor(message: string) {
    super(message);
    this.name = "ToolExecutionValidationError";
  }
}

export function serializeToolExecutionStateKey(key: ToolExecutionStateKey): string {
  return JSON.stringify([
    key.spaceId,
    key.userId,
    key.agentSource,
    key.sessionId,
    key.contextVersion,
    key.toolBatchId,
  ]);
}

export function sameToolExecutionScope(
  left: ToolExecutionScope,
  right: ToolExecutionScope,
): boolean {
  return left.spaceId === right.spaceId
    && left.userId === right.userId
    && left.agentSource === right.agentSource
    && left.sessionId === right.sessionId
    && left.contextVersion === right.contextVersion;
}

export function isToolExecutionContextExpired(
  context: ToolExecutionContext,
  now: Date,
): boolean {
  const expiresAt = Date.parse(context.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

export function cloneToolExecutionContext(
  context: ToolExecutionContext,
): ToolExecutionContext {
  const encoded = JSON.stringify(context);
  if (encoded === undefined) {
    throw new ToolExecutionValidationError("Tool execution context must be JSON serializable");
  }
  return JSON.parse(encoded) as ToolExecutionContext;
}

export function validateToolExecutionContext(context: ToolExecutionContext): void {
  const keyValues = Object.values(context.key);
  if (keyValues.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new ToolExecutionValidationError("Tool execution state key fields must be non-empty strings");
  }
  if (!Number.isInteger(context.revision) || context.revision < 0) {
    throw new ToolExecutionValidationError("Tool execution revision must be a non-negative integer");
  }
  if (!Number.isFinite(Date.parse(context.expiresAt))) {
    throw new ToolExecutionValidationError("Tool execution expiresAt must be an ISO timestamp");
  }
  if (!Number.isFinite(Date.parse(context.createdAt)) || !Number.isFinite(Date.parse(context.updatedAt))) {
    throw new ToolExecutionValidationError("Tool execution timestamps must be valid ISO timestamps");
  }
  const callIds = new Set<string>();
  const slotIndexes = new Set<number>();
  for (const slot of context.slots) {
    if (!slot.callId || !slot.toolName || !Number.isInteger(slot.slotIndex)) {
      throw new ToolExecutionValidationError("Tool call slots require callId, toolName, and integer slotIndex");
    }
    if (callIds.has(slot.callId) || slotIndexes.has(slot.slotIndex)) {
      throw new ToolExecutionValidationError("Tool call IDs and slot indexes must be unique in a batch");
    }
    callIds.add(slot.callId);
    slotIndexes.add(slot.slotIndex);
  }
  const snapshotKeys = new Set([
    "protocol",
    "baseMessages",
    "system",
    "tools",
    "requestParameters",
    "target",
  ]);
  if (Object.keys(context.upstreamSnapshot).some((name) => !snapshotKeys.has(name))) {
    throw new ToolExecutionValidationError("Upstream request snapshot contains a non-allowlisted field");
  }
  const targetKeys = new Set(["id", "url", "model", "authSource"]);
  if (Object.keys(context.upstreamSnapshot.target).some((name) => !targetKeys.has(name))) {
    throw new ToolExecutionValidationError("Persisted forward target contains a non-allowlisted field");
  }
  const requestParameterKeys = new Set([
    "model",
    "max_tokens",
    "temperature",
    "top_p",
    "top_k",
    "stop_sequences",
    "stream",
    "thinking",
    "tool_choice",
    "metadata",
    "service_tier",
  ]);
  if (Object.keys(context.upstreamSnapshot.requestParameters).some((name) => !requestParameterKeys.has(name))) {
    throw new ToolExecutionValidationError("Upstream request parameters contain a non-allowlisted field");
  }
  cloneToolExecutionContext(context);
}

/**
 * Merge protocol structure without allowing a stale stream snapshot to erase
 * a lease or result written concurrently by the execution path.
 */
export function mergeToolCallSlots(
  current: readonly ToolCallSlot[],
  incoming: readonly ToolCallSlot[],
): ToolCallSlot[] | null {
  const existingByCallId = new Map(current.map((slot) => [slot.callId, slot]));
  const merged: ToolCallSlot[] = [];
  const seen = new Set<string>();

  for (const next of incoming) {
    if (seen.has(next.callId)) return null;
    seen.add(next.callId);
    const existing = existingByCallId.get(next.callId);
    if (!existing) {
      merged.push(structuredClone(next));
      continue;
    }
    if (
      existing.owner !== next.owner
      || existing.toolName !== next.toolName
      || existing.slotIndex !== next.slotIndex
      || existing.contentBlockIndex !== next.contentBlockIndex
    ) {
      return null;
    }

    const status = existing.status === "collecting" && next.status === "pending"
      ? "pending"
      : existing.status;
    const preserved: ToolCallSlot = {
      ...structuredClone(next),
      status,
      executionAttempt: existing.executionAttempt,
      ...(existing.executionLeaseOwner !== undefined
        ? { executionLeaseOwner: existing.executionLeaseOwner }
        : {}),
      ...(existing.executionLeaseUntil !== undefined
        ? { executionLeaseUntil: existing.executionLeaseUntil }
        : {}),
      ...(existing.result !== undefined ? { result: structuredClone(existing.result) } : {}),
      ...(existing.isError !== undefined ? { isError: existing.isError } : {}),
    };
    merged.push(preserved);
  }

  for (const existing of current) {
    if (!seen.has(existing.callId)) merged.push(structuredClone(existing));
  }
  return merged.sort((left, right) => left.slotIndex - right.slotIndex);
}

export function isValidClientDispatchTransition(
  current: ClientDispatchStatus,
  next: ClientDispatchStatus,
): boolean {
  return (current === "none" && next === "pending")
    || (current === "pending" && next === "dispatched")
    || (current === "dispatched" && next === "completed");
}
