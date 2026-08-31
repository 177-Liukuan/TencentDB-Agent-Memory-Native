export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface NativeProxyToolsConfig {
  enabled: boolean;
  maxRounds: number;
  maxCallsPerRound: number;
  maxTotalCalls: number;
  toolTimeoutMs: number;
  maxResultBytes: number;
  stateTtlSeconds: number;
  stateStorage: {
    backend: "clickhouse";
    table: string;
  };
}

export interface ToolLoopLimits {
  maxRounds: number;
  maxCallsPerRound: number;
  maxTotalCalls: number;
}

export interface ToolExecutionScope {
  spaceId: string;
  userId: string;
  agentSource: string;
  sessionId: string;
  contextVersion: string;
}

export interface ToolExecutionStateKey extends ToolExecutionScope {
  toolBatchId: string;
}

export type ToolCallOwner = "proxy" | "client";

export type ToolCallStatus =
  | "collecting"
  | "pending"
  | "running"
  | "succeeded"
  | "failed";

export interface ToolCallSlot {
  callId: string;
  slotIndex: number;
  contentBlockIndex: number;
  toolName: string;
  owner: ToolCallOwner;
  input?: JsonValue;
  argumentsComplete: boolean;
  status: ToolCallStatus;
  executionAttempt: number;
  executionLeaseOwner?: string;
  executionLeaseUntil?: string;
  result?: JsonValue;
  isError?: boolean;
}

export interface PersistedForwardTarget {
  id: string;
  url: string;
  model: string;
  authSource: "client" | "global" | "agent" | "extension";
}

/** Native protocol identifiers and inputs that must never reach the client. */
export interface NativeToolLeakMarker {
  callId: string;
  toolName: string;
  input?: JsonValue;
  additionalSentinels?: string[];
  /** Accepted by the runtime scanner but intentionally omitted from persistence. */
  result?: JsonValue;
}

export type PersistedNativeToolLeakMarker = Pick<
  NativeToolLeakMarker,
  "callId" | "toolName" | "input"
>;

/**
 * Allowlisted, credential-free writeback intent captured on the first request.
 * Replays must use this immutable identity and policy instead of mutable retry
 * request metadata.
 */
export interface PersistedToolObservationIntent {
  version: 1;
  agentSource: string;
  identity: {
    spaceId: string;
    teamId: string;
    userId: string;
    agentId: string;
    sessionId: string;
    taskId?: string;
  };
  effects: {
    tdai: boolean;
    skill: boolean;
  };
}

/**
 * Replay-safe data captured after request preparation and routing have
 * completed. Credentials and request headers intentionally have no field in
 * this persisted shape.
 */
export interface UpstreamRequestSnapshot {
  protocol: "anthropic";
  baseMessages: JsonValue[];
  /** Original client-visible history used only for ordinary telemetry/writeback. */
  logicalBaseMessages?: JsonValue[];
  /** Cumulative hidden Native calls from earlier rounds in this logical turn. */
  nativeLeakMarkers?: PersistedNativeToolLeakMarker[];
  /** Stable digest of the client-visible logical request before Native injection. */
  requestFingerprint?: string;
  /** Original, allowlisted identity and enabled effects for durable writeback. */
  observationIntent?: PersistedToolObservationIntent;
  system?: JsonValue;
  tools?: JsonValue[];
  requestParameters: { [key: string]: JsonValue };
  target: PersistedForwardTarget;
}

export type ResponseStreamStatus = "streaming" | "completed" | "aborted";

export type ClientDispatchStatus =
  | "none"
  | "pending"
  | "dispatched"
  | "resuming"
  | "completed";

export type ReentryOutcomeKind = "replay" | "final" | "client_dispatch" | "error";

export type ToolObservationStatus = "none" | "pending" | "running" | "completed";

/** Safe, bounded response bytes that can be replayed after a process restart. */
export interface PersistedResponseSnapshot {
  status: number;
  headers: { [name: string]: string };
  bodyBase64: string;
}

/** Durable response produced after accepting a Client Tool Result batch. */
export interface PersistedReentryOutcome extends PersistedResponseSnapshot {
  kind: ReentryOutcomeKind;
  childStateKey?: ToolExecutionStateKey;
}

/** Persisted state for one assistant tool-call batch. */
export interface ToolExecutionContext {
  key: ToolExecutionStateKey;
  turnSeq: number;
  protocol: "anthropic";
  round: number;
  totalCalls: number;
  assistantSkeleton: JsonValue[];
  slots: ToolCallSlot[];
  responseStreamStatus: ResponseStreamStatus;
  clientDispatchStatus: ClientDispatchStatus;
  /** Parent Client-result batch that caused this continuation, when present. */
  parentStateKey?: ToolExecutionStateKey;
  parentReentryAttempt?: number;
  /** Exact client-visible response prepared before the dispatch is committed. */
  clientDispatchOutcome?: PersistedResponseSnapshot;
  /** Durable lease for handing a persisted Client-result batch back upstream. */
  reentryLeaseOwner?: string;
  reentryLeaseUntil?: string;
  reentryAttempt?: number;
  reentryOutcome?: PersistedReentryOutcome;
  /** Durable outbox for final logical-turn L0/Skill writeback. */
  observationStatus?: ToolObservationStatus;
  observationLeaseOwner?: string;
  observationLeaseUntil?: string;
  observationAttempt?: number;
  /** Final client-visible bytes consumed by the durable writeback outbox. */
  observationOutcome?: PersistedResponseSnapshot;
  upstreamSnapshot: UpstreamRequestSnapshot;
  revision: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface NativeToolResult {
  value: JsonValue;
  isError: boolean;
}

/** Execution leases must survive ordinary request timeouts and process restarts. */
export function nativeToolLeaseDurationMs(toolTimeoutMs: number): number {
  return Math.max(10_000, toolTimeoutMs * 2);
}
