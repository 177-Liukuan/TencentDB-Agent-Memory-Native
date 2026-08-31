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

/**
 * Replay-safe data captured after request preparation and routing have
 * completed. Credentials and request headers intentionally have no field in
 * this persisted shape.
 */
export interface UpstreamRequestSnapshot {
  protocol: "anthropic";
  baseMessages: JsonValue[];
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
  | "completed";

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
