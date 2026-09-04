import type {
  ClientDispatchStatus,
  JsonValue,
  ResponseStreamStatus,
  PersistedReentryOutcome,
  PersistedResponseSnapshot,
  ToolCallSlot,
  ToolExecutionContext,
  ToolExecutionScope,
  ToolExecutionStateKey,
} from "../native-proxy-tools/types.js";

export const TOOL_EXECUTION_STATE_BYTE_LIMITS = Object.freeze({
  slotValue: 1 * 1024 * 1024,
  assistantSkeleton: 2 * 1024 * 1024,
  upstreamSnapshot: 4 * 1024 * 1024,
  reentryOutcome: 4 * 1024 * 1024,
  context: 8 * 1024 * 1024,
});

export const REENTRY_STATE_EXPIRY_GRACE_MS = 30_000;

export function extendToolExecutionExpiryForLease(
  currentExpiresAt: string,
  leaseUntil: string,
): string {
  const currentExpiry = Date.parse(currentExpiresAt);
  const leaseExpiry = Date.parse(leaseUntil);
  if (!Number.isFinite(currentExpiry) || !Number.isFinite(leaseExpiry)) {
    throw new ToolExecutionValidationError("Tool re-entry expiry extension requires valid timestamps");
  }
  return new Date(Math.max(
    currentExpiry,
    leaseExpiry + REENTRY_STATE_EXPIRY_GRACE_MS,
  )).toISOString();
}

const REPLAY_SAFE_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-type",
  "request-id",
  "retry-after",
  "x-request-id",
  "x-should-retry",
]);
const HTTP_FIELD_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;

/** Headers safe to persist and reproduce on a replayed Client Tool continuation. */
export function isReplaySafeResponseHeader(name: string): boolean {
  return name === name.toLowerCase()
    && HTTP_FIELD_NAME_PATTERN.test(name)
    && (
      REPLAY_SAFE_RESPONSE_HEADERS.has(name)
      || name.startsWith("anthropic-ratelimit-")
    );
}

export interface StreamSnapshotCas {
  key: ToolExecutionStateKey;
  expectedRevision: number;
  assistantSkeleton: JsonValue[];
  slots: ToolCallSlot[];
  responseStreamStatus: ResponseStreamStatus;
  /** Monotonic count of Native calls observed in this logical user turn. */
  totalCalls?: number;
}

export interface ClientDispatchCas {
  key: ToolExecutionStateKey;
  expectedRevision: number;
  expectedStatus: ClientDispatchStatus;
  nextStatus: ClientDispatchStatus;
  /** Persisted atomically with none -> pending before any client exposure. */
  dispatchOutcome?: PersistedResponseSnapshot;
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

export interface ReentryClaim {
  key: ToolExecutionStateKey;
  expectedRevision: number;
  leaseOwner: string;
  leaseUntil: string;
}

export type ReentryRenewal = ReentryClaim;

export interface ReentryCompletion {
  key: ToolExecutionStateKey;
  expectedRevision: number;
  leaseOwner: string;
  outcome: PersistedReentryOutcome;
}

export interface ObservationClaim {
  key: ToolExecutionStateKey;
  expectedRevision: number;
  leaseOwner: string;
  leaseUntil: string;
}

export interface ObservationPreparation {
  key: ToolExecutionStateKey;
  expectedRevision: number;
  outcome: PersistedResponseSnapshot;
}

export interface ObservationCompletion {
  key: ToolExecutionStateKey;
  expectedRevision: number;
  leaseOwner: string;
}

export interface ToolExecutionStorageAdapter {
  initializeAndProbe(): Promise<void>;
  create(context: ToolExecutionContext): Promise<void>;
  get(key: ToolExecutionStateKey): Promise<ToolExecutionContext | null>;
  findByCallId(
    scope: ToolExecutionScope,
    callId: string,
    options?: { includeExpired?: boolean; dispatchableOnly?: boolean },
  ): Promise<ToolExecutionContext | null>;
  findActiveBySession(scope: ToolExecutionScope): Promise<ToolExecutionContext[]>;
  compareAndSetStreamSnapshot(update: StreamSnapshotCas): Promise<boolean>;
  compareAndSetClientDispatchStatus(update: ClientDispatchCas): Promise<boolean>;
  tryClaimSlotExecution(claim: SlotExecutionClaim): Promise<boolean>;
  compareAndSetSlotResult(update: SlotResultCas): Promise<boolean>;
  tryClaimReentry(claim: ReentryClaim): Promise<boolean>;
  renewReentry(renewal: ReentryRenewal): Promise<boolean>;
  completeReentry(completion: ReentryCompletion): Promise<boolean>;
  prepareObservation(preparation: ObservationPreparation): Promise<boolean>;
  tryClaimObservation(claim: ObservationClaim): Promise<boolean>;
  completeObservation(completion: ObservationCompletion): Promise<boolean>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidToolExecutionStateKey(value: unknown): value is ToolExecutionStateKey {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set([
    "spaceId",
    "userId",
    "agentSource",
    "sessionId",
    "contextVersion",
    "toolBatchId",
  ]);
  return Object.keys(value).length === allowedKeys.size
    && Object.keys(value).every((name) => allowedKeys.has(name))
    && [...allowedKeys].every((name) => (
      typeof value[name] === "string" && value[name].length > 0
    ));
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
  const contextKeys = new Set([
    "key",
    "turnSeq",
    "protocol",
    "round",
    "totalCalls",
    "assistantSkeleton",
    "slots",
    "responseStreamStatus",
    "clientDispatchStatus",
    "parentStateKey",
    "parentReentryAttempt",
    "clientDispatchOutcome",
    "reentryLeaseOwner",
    "reentryLeaseUntil",
    "reentryAttempt",
    "reentryOutcome",
    "observationStatus",
    "observationLeaseOwner",
    "observationLeaseUntil",
    "observationAttempt",
    "observationOutcome",
    "upstreamSnapshot",
    "revision",
    "expiresAt",
    "createdAt",
    "updatedAt",
  ]);
  if (Object.keys(context).some((name) => !contextKeys.has(name))) {
    throw new ToolExecutionValidationError("Tool execution context contains a non-allowlisted field");
  }
  if (!isValidToolExecutionStateKey(context.key)) {
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
  if (context.reentryAttempt !== undefined && (
    !Number.isInteger(context.reentryAttempt) || context.reentryAttempt < 0
  )) {
    throw new ToolExecutionValidationError("Tool re-entry attempt must be a non-negative integer");
  }
  if ((context.parentStateKey === undefined) !== (context.parentReentryAttempt === undefined)) {
    throw new ToolExecutionValidationError("Child Tool continuation requires both parent key and attempt");
  }
  if (context.parentStateKey !== undefined) {
    if (
      !isValidToolExecutionStateKey(context.parentStateKey)
      || !sameToolExecutionScope(context.key, context.parentStateKey)
      || context.key.toolBatchId === context.parentStateKey.toolBatchId
      || !Number.isInteger(context.parentReentryAttempt)
      || context.parentReentryAttempt! < 1
    ) {
      throw new ToolExecutionValidationError("Child Tool continuation parent link is invalid");
    }
  }
  if (context.clientDispatchStatus === "resuming" && (
    !context.reentryLeaseOwner
    || !context.reentryLeaseUntil
    || !Number.isFinite(Date.parse(context.reentryLeaseUntil))
  )) {
    throw new ToolExecutionValidationError("Resuming Tool batches require a valid re-entry lease");
  }
  if (context.observationAttempt !== undefined && (
    !Number.isInteger(context.observationAttempt) || context.observationAttempt < 0
  )) {
    throw new ToolExecutionValidationError("Tool observation attempt must be a non-negative integer");
  }
  if (context.observationStatus === "running" && (
    !context.observationLeaseOwner
    || !context.observationLeaseUntil
    || !Number.isFinite(Date.parse(context.observationLeaseUntil))
  )) {
    throw new ToolExecutionValidationError("Running Tool observation requires a valid lease");
  }
  if (context.observationOutcome) {
    validatePersistedResponseSnapshot(context.observationOutcome, "Tool observation outcome", []);
  }
  if (context.clientDispatchStatus === "completed" && !context.reentryOutcome) {
    throw new ToolExecutionValidationError("Completed Tool batches require a replay outcome");
  }
  if (context.clientDispatchOutcome) {
    validatePersistedResponseSnapshot(context.clientDispatchOutcome, "Client dispatch outcome", []);
  }
  if (context.reentryOutcome) {
    const outcome = context.reentryOutcome;
    validatePersistedResponseSnapshot(outcome, "Tool re-entry outcome", ["kind", "childStateKey"]);
    const childStateKeyIsValid = outcome.childStateKey === undefined
      || (
        isValidToolExecutionStateKey(outcome.childStateKey)
        && sameToolExecutionScope(context.key, outcome.childStateKey)
        && context.key.toolBatchId !== outcome.childStateKey.toolBatchId
    );
    if (
      context.clientDispatchStatus !== "completed"
      || !["replay", "final", "client_dispatch", "error"].includes(outcome.kind)
      || !childStateKeyIsValid
      || (outcome.kind === "client_dispatch") !== (outcome.childStateKey !== undefined)
    ) {
      throw new ToolExecutionValidationError("Tool re-entry outcome is invalid");
    }
    if (jsonByteLength(outcome) > TOOL_EXECUTION_STATE_BYTE_LIMITS.reentryOutcome) {
      throw new ToolExecutionValidationError("Tool re-entry outcome exceeds the persisted state byte limit");
    }
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
    if (slot.input !== undefined && jsonByteLength(slot.input) > TOOL_EXECUTION_STATE_BYTE_LIMITS.slotValue) {
      throw new ToolExecutionValidationError("Tool call input exceeds the persisted state byte limit");
    }
    if (slot.result !== undefined && jsonByteLength(slot.result) > TOOL_EXECUTION_STATE_BYTE_LIMITS.slotValue) {
      throw new ToolExecutionValidationError("Tool call result exceeds the persisted state byte limit");
    }
  }
  const snapshotKeys = new Set([
    "protocol",
    "clientProtocol",
    "baseMessages",
    "logicalBaseMessages",
    "nativeLeakMarkers",
    "requestFingerprint",
    "observationIntent",
    "system",
    "instructions",
    "tools",
    "requestParameters",
    "target",
  ]);
  if (Object.keys(context.upstreamSnapshot).some((name) => !snapshotKeys.has(name))) {
    throw new ToolExecutionValidationError("Upstream request snapshot contains a non-allowlisted field");
  }
  if (context.upstreamSnapshot.nativeLeakMarkers !== undefined) {
    if (!Array.isArray(context.upstreamSnapshot.nativeLeakMarkers)) {
      throw new ToolExecutionValidationError("Native Tool leak markers must be an array");
    }
    const markerKeys = new Set(["callId", "toolName", "input"]);
    for (const marker of context.upstreamSnapshot.nativeLeakMarkers) {
      if (
        !isRecord(marker)
        || typeof marker.callId !== "string"
        || marker.callId.length === 0
        || typeof marker.toolName !== "string"
        || marker.toolName.length === 0
        || Object.keys(marker).some((name) => !markerKeys.has(name))
      ) {
        throw new ToolExecutionValidationError("Native Tool leak marker is invalid");
      }
      if (marker.input !== undefined
        && jsonByteLength(marker.input) > TOOL_EXECUTION_STATE_BYTE_LIMITS.slotValue) {
        throw new ToolExecutionValidationError("Native Tool leak marker input exceeds the persisted state byte limit");
      }
    }
  }
  if (
    context.upstreamSnapshot.requestFingerprint !== undefined
    && !/^sha256:[a-f0-9]{64}$/.test(context.upstreamSnapshot.requestFingerprint)
  ) {
    throw new ToolExecutionValidationError("Upstream request fingerprint is invalid");
  }
  if (context.upstreamSnapshot.observationIntent !== undefined) {
    const intent: unknown = context.upstreamSnapshot.observationIntent;
    const intentKeys = new Set(["version", "agentSource", "identity", "effects"]);
    const identityKeys = new Set([
      "spaceId",
      "teamId",
      "userId",
      "agentId",
      "sessionId",
      "taskId",
    ]);
    const effectKeys = new Set(["tdai", "skill"]);
    if (!isRecord(intent)) {
      throw new ToolExecutionValidationError("Tool observation intent is invalid");
    }
    const identity = intent.identity;
    const effects = intent.effects;
    const requiredIdentityKeys = [
      "spaceId",
      "teamId",
      "userId",
      "agentId",
      "sessionId",
    ] as const;
    const identityStringsAreValid = isRecord(identity)
      && requiredIdentityKeys.every((name) => (
        typeof identity[name] === "string" && identity[name].length > 0
      ))
      && (identity.taskId === undefined || (
        typeof identity.taskId === "string" && identity.taskId.length > 0
      ));
    if (
      !isRecord(intent)
      || intent.version !== 1
      || typeof intent.agentSource !== "string"
      || intent.agentSource.length === 0
      || !isRecord(identity)
      || !identityStringsAreValid
      || Object.keys(identity).some((name) => !identityKeys.has(name))
      || !isRecord(effects)
      || typeof effects.tdai !== "boolean"
      || typeof effects.skill !== "boolean"
      || Object.keys(effects).some((name) => !effectKeys.has(name))
      || Object.keys(intent).some((name) => !intentKeys.has(name))
      || intent.agentSource !== context.key.agentSource
      || identity.spaceId !== context.key.spaceId
      || identity.userId !== context.key.userId
      || identity.sessionId !== context.key.sessionId
    ) {
      throw new ToolExecutionValidationError("Tool observation intent is invalid");
    }
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
    "max_completion_tokens",
    "max_output_tokens",
    "frequency_penalty",
    "presence_penalty",
    "parallel_tool_calls",
    "response_format",
    "seed",
    "stream_options",
    "reasoning",
    "text",
    "include",
    "truncation",
    "previous_response_id",
    "conversation",
    "store",
    "background",
  ]);
  if (Object.keys(context.upstreamSnapshot.requestParameters).some((name) => !requestParameterKeys.has(name))) {
    throw new ToolExecutionValidationError("Upstream request parameters contain a non-allowlisted field");
  }
  if (jsonByteLength(context.assistantSkeleton) > TOOL_EXECUTION_STATE_BYTE_LIMITS.assistantSkeleton) {
    throw new ToolExecutionValidationError("Assistant skeleton exceeds the persisted state byte limit");
  }
  if (jsonByteLength(context.upstreamSnapshot) > TOOL_EXECUTION_STATE_BYTE_LIMITS.upstreamSnapshot) {
    throw new ToolExecutionValidationError("Upstream snapshot exceeds the persisted state byte limit");
  }
  if (jsonByteLength(context) > TOOL_EXECUTION_STATE_BYTE_LIMITS.context) {
    throw new ToolExecutionValidationError("Tool execution context exceeds the persisted state byte limit");
  }
  cloneToolExecutionContext(context);
}

function validatePersistedResponseSnapshot(
  snapshot: PersistedResponseSnapshot,
  label: string,
  additionalKeys: readonly string[],
): void {
  const allowedKeys = new Set(["status", "headers", "bodyBase64", ...additionalKeys]);
  const headersAreValid = isRecord(snapshot.headers)
    && Object.entries(snapshot.headers).every(([name, value]) => (
      isReplaySafeResponseHeader(name)
      && typeof value === "string"
      && !/[\r\n]/.test(value)
    ));
  if (
    !Number.isInteger(snapshot.status)
    || snapshot.status < 100
    || snapshot.status > 599
    || typeof snapshot.bodyBase64 !== "string"
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(snapshot.bodyBase64)
    || !headersAreValid
    || Object.keys(snapshot).some((name) => !allowedKeys.has(name))
  ) {
    throw new ToolExecutionValidationError(`${label} is invalid`);
  }
  if (jsonByteLength(snapshot) > TOOL_EXECUTION_STATE_BYTE_LIMITS.reentryOutcome) {
    throw new ToolExecutionValidationError(`${label} exceeds the persisted state byte limit`);
  }
}

function jsonByteLength(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new ToolExecutionValidationError("Tool execution state must be JSON serializable");
  }
  return new TextEncoder().encode(encoded).byteLength;
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
    || (current === "pending" && next === "dispatched");
}
