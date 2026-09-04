export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type NativeToolBackend = "memory" | "skill" | "knowledge";

export type NativeToolEffect = "read" | "write" | "archive";

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
  ledgerStorage: {
    backend: "clickhouse";
    table: string;
    eventTable: string;
  };
}

export type NativeToolProtocol = "anthropic" | "openai" | "responses";

export interface NativeToolSessionScope {
  spaceId: string;
  userId: string;
  agentSource: string;
  sessionId: string;
}

/**
 * 长期记录以 Claude Code 看不到、但后续上游请求必须补回的内容为主体，
 * 仅额外保存定位所需的 Client Tool 引用；执行租约、重入状态和响应快照属于短期运行状态。
 */
export type NativeToolLedgerBlock =
  | {
      kind: "native_tool";
      blockIndex: number;
      callId: string;
      toolName: string;
      input: JsonValue;
    }
  | {
      kind: "client_tool_ref";
      blockIndex: number;
      callId: string;
      toolName: string;
    }
  | {
      kind: "hidden_content";
      blockIndex: number;
      value: JsonValue;
    };

export interface NativeToolLedgerResult {
  callId: string;
  value: JsonValue;
  isError: boolean;
}

/** 一次模型输出中，与 Native Tool 历史恢复有关的最少长期记录。 */
export interface NativeToolLedgerRound {
  ledgerId: string;
  scope: NativeToolSessionScope;
  contextEpoch: number;
  turnSeq: number;
  round: number;
  clientProtocol: NativeToolProtocol;
  blocks: NativeToolLedgerBlock[];
  nativeResults: NativeToolLedgerResult[];
  createdAt: string;
}

export interface NativeToolUserTurn {
  turnSeq: number;
  turnToken: string;
  createdAt: string;
}

export interface NativeToolSessionContext {
  currentTurnSeq: number;
  currentEpoch: number;
  pendingCompactEpoch: number | null;
  compactStateError: boolean;
}

export type NativeToolContextEventType =
  | "user_prompt"
  | "compact_pending"
  | "compact_completed"
  | "compact_error";

export interface NativeToolContextEvent {
  eventId: string;
  scope: NativeToolSessionScope;
  type: NativeToolContextEventType;
  turnSeq?: number;
  turnToken?: string;
  targetEpoch?: number;
  trigger?: "manual" | "auto";
  createdAt: string;
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

/** 用于响应发送前检查；这些 Native 调用标识和参数绝不能到达客户端。 */
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
  protocol: "anthropic" | "openai" | "responses";
  /** Client wire format; differs from protocol for Anthropic-client/Responses-upstream. */
  clientProtocol?: NativeToolProtocol;
  baseMessages: JsonValue[];
  /** Original client-visible history used only for ordinary telemetry/writeback. */
  logicalBaseMessages?: JsonValue[];
  /** Cumulative hidden Native calls from earlier rounds in this logical turn. */
  nativeLeakMarkers?: PersistedNativeToolLeakMarker[];
  /** Stable digest used only to replay an interrupted current request. */
  requestFingerprint?: string;
  /** Original, allowlisted identity and enabled effects for durable writeback. */
  observationIntent?: PersistedToolObservationIntent;
  system?: JsonValue;
  /** OpenAI Responses top-level instructions, kept distinct from Anthropic system. */
  instructions?: JsonValue;
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

/**
 * 一次 Assistant 工具调用组的短期运行状态。
 * 它负责跨请求续接、并发认领和故障恢复，过期后仍需保留的隐藏历史由 Tool Ledger 负责。
 */
export interface ToolExecutionContext {
  key: ToolExecutionStateKey;
  turnSeq: number;
  protocol: "anthropic" | "openai" | "responses";
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
