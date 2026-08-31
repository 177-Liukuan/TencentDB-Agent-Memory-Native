import { createHash, randomUUID } from "node:crypto";

import type { ProxyConfig } from "../types.js";
import type {
  ClientDispatchStatus,
  JsonValue,
  ToolExecutionContext,
  ToolExecutionScope,
  ToolExecutionStateKey,
} from "../native-proxy-tools/types.js";
import {
  ToolExecutionConflictError,
  ToolExecutionStorageError,
  cloneToolExecutionContext,
  extendToolExecutionExpiryForLease,
  isToolExecutionContextExpired,
  isValidClientDispatchTransition,
  mergeToolCallSlots,
  validateToolExecutionContext,
  type ClientDispatchCas,
  type ReentryClaim,
  type ReentryCompletion,
  type ReentryRenewal,
  type ObservationClaim,
  type ObservationCompletion,
  type ObservationPreparation,
  type SlotExecutionClaim,
  type SlotResultCas,
  type StreamSnapshotCas,
  type ToolExecutionStorageAdapter,
} from "./tool-execution-storage-adapter.js";

export interface ToolStateClickHouseCommand {
  query: string;
  query_params?: Record<string, unknown>;
  clickhouse_settings?: Record<string, unknown>;
}

export interface ToolStateClickHouseInsert {
  table: string;
  values: ToolExecutionStateRow[];
  format: "JSONEachRow";
  clickhouse_settings?: Record<string, unknown>;
}

export interface ToolStateClickHouseQuery {
  query: string;
  query_params?: Record<string, unknown>;
  format: "JSONEachRow";
  clickhouse_settings?: Record<string, unknown>;
}

export interface ToolStateClickHouseQueryResult {
  json(): Promise<unknown[]>;
}

export interface ToolStateClickHouseClient {
  command(command: ToolStateClickHouseCommand): Promise<unknown>;
  insert(insert: ToolStateClickHouseInsert): Promise<unknown>;
  query(query: ToolStateClickHouseQuery): Promise<ToolStateClickHouseQueryResult>;
  close(): Promise<unknown>;
}

export interface ToolExecutionStateRow {
  space_id: string;
  user_id: string;
  agent_source: string;
  session_id: string;
  context_version: string;
  tool_batch_id: string;
  schema_version?: number | string;
  turn_seq: number | string;
  protocol: string;
  round: number | string;
  total_calls: number | string;
  call_ids: string[];
  assistant_skeleton_json: string;
  slots_json: string;
  response_stream_status: string;
  client_dispatch_status: string;
  parent_state_key_json?: string;
  parent_reentry_attempt?: number | string;
  client_dispatch_outcome_json?: string;
  reentry_lease_owner?: string;
  reentry_lease_until?: string;
  reentry_attempt?: number | string;
  reentry_outcome_json?: string;
  observation_status?: string;
  observation_lease_owner?: string;
  observation_lease_until?: string;
  observation_attempt?: number | string;
  observation_outcome_json?: string;
  upstream_snapshot_json: string;
  revision: number | string;
  mutation_token: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface DecodedToolExecutionStateRow {
  context: ToolExecutionContext;
  mutationToken: string;
}

export interface ClickHouseToolExecutionStorageAdapterOptions {
  client?: ToolStateClickHouseClient;
  now?: () => Date;
  createMutationToken?: () => string;
  maxCasAttempts?: number;
}

export class NativeToolStateCapabilityError extends ToolExecutionStorageError {
  constructor() {
    super("ClickHouse Native Tool state capability probe failed");
    this.name = "NativeToolStateCapabilityError";
  }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(value: string, path: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new ToolExecutionStorageError(`${path} must be a safe ClickHouse identifier`);
  }
}

export function createToolExecutionStateTableDdl(table: string): string {
  assertIdentifier(table, "Tool execution state table identifier");
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    "  space_id String,",
    "  user_id String,",
    "  agent_source LowCardinality(String),",
    "  session_id String,",
    "  context_version LowCardinality(String),",
    "  tool_batch_id String,",
    "  schema_version UInt16 DEFAULT 1,",
    "  turn_seq UInt64,",
    "  protocol LowCardinality(String),",
    "  round UInt32,",
    "  total_calls UInt32,",
    "  call_ids Array(String),",
    "  assistant_skeleton_json String,",
    "  slots_json String,",
    "  response_stream_status LowCardinality(String),",
    "  client_dispatch_status LowCardinality(String),",
    "  parent_state_key_json String DEFAULT '',",
    "  parent_reentry_attempt UInt32 DEFAULT 0,",
    "  client_dispatch_outcome_json String DEFAULT '',",
    "  reentry_lease_owner String DEFAULT '',",
    "  reentry_lease_until String DEFAULT '',",
    "  reentry_attempt UInt32 DEFAULT 0,",
    "  reentry_outcome_json String DEFAULT '',",
    "  observation_status LowCardinality(String) DEFAULT 'none',",
    "  observation_lease_owner String DEFAULT '',",
    "  observation_lease_until String DEFAULT '',",
    "  observation_attempt UInt32 DEFAULT 0,",
    "  observation_outcome_json String DEFAULT '',",
    "  upstream_snapshot_json String,",
    "  revision UInt64,",
    "  mutation_token String,",
    "  expires_at DateTime64(3, 'UTC'),",
    "  created_at DateTime64(3, 'UTC'),",
    "  updated_at DateTime64(3, 'UTC')",
    ") ENGINE = MergeTree()",
    "ORDER BY (space_id, user_id, agent_source, session_id, context_version, tool_batch_id)",
    "TTL expires_at DELETE",
    "SETTINGS enable_block_number_column = 1, enable_block_offset_column = 1, non_replicated_deduplication_window = 1000",
  ].join("\n");
}

function parseJsonField<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new ToolExecutionStorageError("ClickHouse Native Tool state row is corrupt");
  }
}

function finiteInteger(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ToolExecutionStorageError("ClickHouse Native Tool state row is corrupt");
  }
  return parsed;
}

function normalizeTimestamp(value: string): string {
  const direct = Date.parse(value);
  const parsed = Number.isFinite(direct)
    ? direct
    : Date.parse(`${value.replace(" ", "T")}Z`);
  if (!Number.isFinite(parsed)) {
    throw new ToolExecutionStorageError("ClickHouse Native Tool state row is corrupt");
  }
  return new Date(parsed).toISOString();
}

function toClickHouseUtcTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ToolExecutionStorageError("Tool execution timestamp is invalid");
  }
  return new Date(parsed).toISOString().replace("T", " ").replace("Z", "").slice(0, 23);
}

export function decodeToolExecutionStateRow(
  row: ToolExecutionStateRow,
): DecodedToolExecutionStateRow {
  const slots = parseJsonField<ToolExecutionContext["slots"]>(row.slots_json);
  const reentryAttempt = finiteInteger(row.reentry_attempt ?? 0);
  const parentReentryAttempt = finiteInteger(row.parent_reentry_attempt ?? 0);
  const observationAttempt = finiteInteger(row.observation_attempt ?? 0);
  const context: ToolExecutionContext = {
    key: {
      spaceId: row.space_id,
      userId: row.user_id,
      agentSource: row.agent_source,
      sessionId: row.session_id,
      contextVersion: row.context_version,
      toolBatchId: row.tool_batch_id,
    },
    turnSeq: finiteInteger(row.turn_seq),
    protocol: row.protocol as "anthropic",
    round: finiteInteger(row.round),
    totalCalls: finiteInteger(row.total_calls),
    assistantSkeleton: parseJsonField<JsonValue[]>(row.assistant_skeleton_json),
    slots,
    responseStreamStatus: row.response_stream_status as ToolExecutionContext["responseStreamStatus"],
    clientDispatchStatus: row.client_dispatch_status as ClientDispatchStatus,
    ...(row.parent_state_key_json
      ? { parentStateKey: parseJsonField<ToolExecutionStateKey>(row.parent_state_key_json) }
      : {}),
    ...(parentReentryAttempt > 0 ? { parentReentryAttempt } : {}),
    ...(row.client_dispatch_outcome_json
      ? { clientDispatchOutcome: parseJsonField<ToolExecutionContext["clientDispatchOutcome"]>(row.client_dispatch_outcome_json) }
      : {}),
    ...(row.reentry_lease_owner
      ? { reentryLeaseOwner: row.reentry_lease_owner }
      : {}),
    ...(row.reentry_lease_until
      ? { reentryLeaseUntil: row.reentry_lease_until }
      : {}),
    ...(reentryAttempt > 0 ? { reentryAttempt } : {}),
    ...(row.reentry_outcome_json
      ? { reentryOutcome: parseJsonField<ToolExecutionContext["reentryOutcome"]>(row.reentry_outcome_json) }
      : {}),
    ...((row.observation_status ?? "none") !== "none"
      ? { observationStatus: row.observation_status as ToolExecutionContext["observationStatus"] }
      : {}),
    ...(row.observation_lease_owner
      ? { observationLeaseOwner: row.observation_lease_owner }
      : {}),
    ...(row.observation_lease_until
      ? { observationLeaseUntil: row.observation_lease_until }
      : {}),
    ...(observationAttempt > 0 ? { observationAttempt } : {}),
    ...(row.observation_outcome_json
      ? { observationOutcome: parseJsonField<ToolExecutionContext["observationOutcome"]>(row.observation_outcome_json) }
      : {}),
    upstreamSnapshot: parseJsonField<ToolExecutionContext["upstreamSnapshot"]>(row.upstream_snapshot_json),
    revision: finiteInteger(row.revision),
    expiresAt: normalizeTimestamp(row.expires_at),
    createdAt: normalizeTimestamp(row.created_at),
    updatedAt: normalizeTimestamp(row.updated_at),
  };
  if (
    finiteInteger(row.schema_version ?? 1) !== 1
    ||
    row.protocol !== "anthropic"
    || !row.mutation_token
    || row.call_ids.length !== slots.length
    || row.call_ids.some((callId, index) => callId !== slots[index]?.callId)
  ) {
    throw new ToolExecutionStorageError("ClickHouse Native Tool state row is corrupt");
  }
  validateToolExecutionContext(context);
  return { context, mutationToken: row.mutation_token };
}

function encodeToolExecutionStateRow(
  context: ToolExecutionContext,
  mutationToken: string,
): ToolExecutionStateRow {
  return {
    space_id: context.key.spaceId,
    user_id: context.key.userId,
    agent_source: context.key.agentSource,
    session_id: context.key.sessionId,
    context_version: context.key.contextVersion,
    tool_batch_id: context.key.toolBatchId,
    schema_version: 1,
    turn_seq: context.turnSeq,
    protocol: context.protocol,
    round: context.round,
    total_calls: context.totalCalls,
    call_ids: context.slots.map((slot) => slot.callId),
    assistant_skeleton_json: JSON.stringify(context.assistantSkeleton),
    slots_json: JSON.stringify(context.slots),
    response_stream_status: context.responseStreamStatus,
    client_dispatch_status: context.clientDispatchStatus,
    parent_state_key_json: context.parentStateKey ? JSON.stringify(context.parentStateKey) : "",
    parent_reentry_attempt: context.parentReentryAttempt ?? 0,
    client_dispatch_outcome_json: context.clientDispatchOutcome
      ? JSON.stringify(context.clientDispatchOutcome)
      : "",
    reentry_lease_owner: context.reentryLeaseOwner ?? "",
    reentry_lease_until: context.reentryLeaseUntil ?? "",
    reentry_attempt: context.reentryAttempt ?? 0,
    reentry_outcome_json: context.reentryOutcome ? JSON.stringify(context.reentryOutcome) : "",
    observation_status: context.observationStatus ?? "none",
    observation_lease_owner: context.observationLeaseOwner ?? "",
    observation_lease_until: context.observationLeaseUntil ?? "",
    observation_attempt: context.observationAttempt ?? 0,
    observation_outcome_json: context.observationOutcome
      ? JSON.stringify(context.observationOutcome)
      : "",
    upstream_snapshot_json: JSON.stringify(context.upstreamSnapshot),
    revision: context.revision,
    mutation_token: mutationToken,
    expires_at: toClickHouseUtcTimestamp(context.expiresAt),
    created_at: toClickHouseUtcTimestamp(context.createdAt),
    updated_at: toClickHouseUtcTimestamp(context.updatedAt),
  };
}

type StateTransition = (context: ToolExecutionContext) => ToolExecutionContext | null;

export class ClickHouseToolExecutionStorageAdapter implements ToolExecutionStorageAdapter {
  private client?: ToolStateClickHouseClient;
  private readonly now: () => Date;
  private readonly createMutationToken: () => string;
  private readonly maxCasAttempts: number;
  private readonly table: string;
  private readonly database: string;
  private initialization?: Promise<void>;
  private initialized = false;
  private closed = false;

  constructor(
    private readonly config: Pick<ProxyConfig, "clickhouse" | "nativeProxyTools">,
    options: ClickHouseToolExecutionStorageAdapterOptions = {},
  ) {
    this.table = config.nativeProxyTools.stateStorage.table;
    this.database = config.clickhouse.database;
    assertIdentifier(this.table, "Tool execution state table identifier");
    assertIdentifier(this.database, "ClickHouse database identifier");
    this.client = options.client;
    this.now = options.now ?? (() => new Date());
    this.createMutationToken = options.createMutationToken ?? randomUUID;
    this.maxCasAttempts = options.maxCasAttempts ?? 5;
    if (!Number.isInteger(this.maxCasAttempts) || this.maxCasAttempts < 1 || this.maxCasAttempts > 20) {
      throw new ToolExecutionStorageError("maxCasAttempts must be an integer between 1 and 20");
    }
  }

  async initializeAndProbe(): Promise<void> {
    this.assertOpen();
    if (this.initialized) return;
    if (!this.initialization) {
      this.initialization = this.runCapabilityProbe().catch(() => {
        this.initialization = undefined;
        this.initialized = false;
        throw new NativeToolStateCapabilityError();
      });
    }
    await this.initialization;
    this.initialized = true;
  }

  async create(context: ToolExecutionContext): Promise<void> {
    this.assertOpen();
    validateToolExecutionContext(context);
    const existing = await this.readStored(context.key);
    if (existing) {
      throw new ToolExecutionConflictError(`Tool execution batch already exists: ${context.key.toolBatchId}`);
    }

    const mutationToken = this.createMutationToken();
    const row = encodeToolExecutionStateRow(cloneToolExecutionContext(context), mutationToken);
    try {
      await this.getClient().insert({
        table: this.table,
        values: [row],
        format: "JSONEachRow",
        clickhouse_settings: {
          wait_end_of_query: 1,
          date_time_input_format: "best_effort",
          insert_deduplicate: 1,
          insert_deduplication_token: createHash("sha256")
            .update(JSON.stringify(context.key))
            .digest("hex"),
        },
      });
    } catch {
      throw new ToolExecutionStorageError("ClickHouse Native Tool state insert failed");
    }
    const observed = await this.readStored(context.key);
    if (
      !observed
      || observed.mutationToken !== mutationToken
      || observed.context.revision !== context.revision
    ) {
      throw new ToolExecutionConflictError("ClickHouse Native Tool state insert could not be verified");
    }
  }

  async get(key: ToolExecutionStateKey): Promise<ToolExecutionContext | null> {
    this.assertOpen();
    const stored = await this.readStored(key);
    return stored ? cloneToolExecutionContext(stored.context) : null;
  }

  async findByCallId(
    scope: ToolExecutionScope,
    callId: string,
    options: { includeExpired?: boolean; dispatchableOnly?: boolean } = {},
  ): Promise<ToolExecutionContext | null> {
    this.assertOpen();
    const expiryPredicate = options.includeExpired ? "" : "  AND expires_at > now64(3)\n";
    const dispatchPredicate = options.dispatchableOnly
      ? "  AND response_stream_status = 'completed'\n  AND client_dispatch_status IN ('dispatched', 'resuming', 'completed')\n"
      : "";
    const rows = await this.queryRows(
      `${this.selectColumns()}\n`
        + `WHERE ${this.scopePredicate()}\n`
        + "  AND has(call_ids, {callId:String})\n"
        + dispatchPredicate
        + expiryPredicate
        + "ORDER BY updated_at DESC\nLIMIT 1",
      { ...this.scopeParams(scope), callId },
    );
    const decoded = options.includeExpired
      ? rows.map(decodeToolExecutionStateRow)
      : this.decodeActiveRows(rows);
    return decoded.length > 0 ? cloneToolExecutionContext(decoded[0].context) : null;
  }

  async findActiveBySession(scope: ToolExecutionScope): Promise<ToolExecutionContext[]> {
    this.assertOpen();
    const rows = await this.queryRows(
      `${this.selectColumns()}\n`
        + `WHERE ${this.scopePredicate()}\n`
        + "  AND expires_at > now64(3)\n"
        + "ORDER BY created_at ASC",
      this.scopeParams(scope),
    );
    return this.decodeActiveRows(rows).map(({ context }) => cloneToolExecutionContext(context));
  }

  async compareAndSetStreamSnapshot(update: StreamSnapshotCas): Promise<boolean> {
    return this.mutate(update.key, update.expectedRevision, (current) => {
      if (current.responseStreamStatus === "aborted") return null;
      if (current.responseStreamStatus === "completed" && update.responseStreamStatus !== "completed") {
        return null;
      }
      const slots = mergeToolCallSlots(current.slots, update.slots);
      if (!slots) return null;
      current.assistantSkeleton = structuredClone(update.assistantSkeleton);
      current.slots = slots;
      current.responseStreamStatus = update.responseStreamStatus;
      if (update.totalCalls !== undefined) {
        if (!Number.isInteger(update.totalCalls) || update.totalCalls < current.totalCalls) return null;
        current.totalCalls = update.totalCalls;
      }
      return current;
    });
  }

  async compareAndSetClientDispatchStatus(update: ClientDispatchCas): Promise<boolean> {
    return this.mutate(update.key, update.expectedRevision, (current) => {
      if (
        current.clientDispatchStatus !== update.expectedStatus
        || !isValidClientDispatchTransition(update.expectedStatus, update.nextStatus)
      ) return null;
      current.clientDispatchStatus = update.nextStatus;
      if (update.dispatchOutcome !== undefined) {
        current.clientDispatchOutcome = structuredClone(update.dispatchOutcome);
      }
      return current;
    });
  }

  async tryClaimSlotExecution(claim: SlotExecutionClaim): Promise<boolean> {
    if (!claim.leaseOwner || !Number.isFinite(Date.parse(claim.leaseUntil))) return false;
    if (Date.parse(claim.leaseUntil) <= this.now().getTime()) return false;
    return this.mutate(claim.key, claim.expectedRevision, (current) => {
      const slot = current.slots.find((candidate) => candidate.callId === claim.callId);
      if (!slot || slot.owner !== "proxy" || !slot.argumentsComplete) return null;
      const expiredRunningLease = slot.status === "running"
        && (!slot.executionLeaseUntil || Date.parse(slot.executionLeaseUntil) <= this.now().getTime());
      if (slot.status !== "pending" && !expiredRunningLease) return null;
      slot.status = "running";
      slot.executionAttempt += 1;
      slot.executionLeaseOwner = claim.leaseOwner;
      slot.executionLeaseUntil = claim.leaseUntil;
      return current;
    });
  }

  async compareAndSetSlotResult(update: SlotResultCas): Promise<boolean> {
    return this.mutate(update.key, update.expectedRevision, (current) => {
      const slot = current.slots.find((candidate) => candidate.callId === update.callId);
      if (!slot || slot.status === "succeeded" || slot.status === "failed") return null;
      if (slot.owner === "proxy") {
        if (
          slot.status !== "running"
          || !update.leaseOwner
          || slot.executionLeaseOwner !== update.leaseOwner
        ) return null;
      } else if (slot.status !== "pending" || update.leaseOwner !== undefined) {
        return null;
      }
      slot.status = update.isError ? "failed" : "succeeded";
      slot.result = structuredClone(update.result);
      slot.isError = update.isError;
      return current;
    });
  }

  async tryClaimReentry(claim: ReentryClaim): Promise<boolean> {
    if (!claim.leaseOwner || !Number.isFinite(Date.parse(claim.leaseUntil))) return false;
    if (Date.parse(claim.leaseUntil) <= this.now().getTime()) return false;
    return this.mutate(claim.key, claim.expectedRevision, (current) => {
      const expiredLease = current.clientDispatchStatus === "resuming"
        && (!current.reentryLeaseUntil
          || Date.parse(current.reentryLeaseUntil) <= this.now().getTime());
      if (current.clientDispatchStatus !== "dispatched" && !expiredLease) return null;
      current.clientDispatchStatus = "resuming";
      current.reentryAttempt = (current.reentryAttempt ?? 0) + 1;
      current.reentryLeaseOwner = claim.leaseOwner;
      current.reentryLeaseUntil = claim.leaseUntil;
      current.expiresAt = extendToolExecutionExpiryForLease(current.expiresAt, claim.leaseUntil);
      return current;
    });
  }

  async renewReentry(renewal: ReentryRenewal): Promise<boolean> {
    if (!renewal.leaseOwner || !Number.isFinite(Date.parse(renewal.leaseUntil))) return false;
    if (Date.parse(renewal.leaseUntil) <= this.now().getTime()) return false;
    return this.mutate(renewal.key, renewal.expectedRevision, (current) => {
      if (
        current.clientDispatchStatus !== "resuming"
        || current.reentryLeaseOwner !== renewal.leaseOwner
      ) return null;
      current.reentryLeaseUntil = renewal.leaseUntil;
      current.expiresAt = extendToolExecutionExpiryForLease(current.expiresAt, renewal.leaseUntil);
      return current;
    });
  }

  async completeReentry(completion: ReentryCompletion): Promise<boolean> {
    return this.mutate(completion.key, completion.expectedRevision, (current) => {
      if (
        current.clientDispatchStatus !== "resuming"
        || current.reentryLeaseOwner !== completion.leaseOwner
      ) return null;
      current.clientDispatchStatus = "completed";
      current.reentryOutcome = structuredClone(completion.outcome);
      if (completion.outcome.kind === "final" || completion.outcome.kind === "replay") {
        current.observationStatus = "pending";
        current.observationOutcome = {
          status: completion.outcome.status,
          headers: structuredClone(completion.outcome.headers),
          bodyBase64: completion.outcome.bodyBase64,
        };
      } else {
        current.observationStatus = "none";
        delete current.observationOutcome;
      }
      return current;
    });
  }

  async prepareObservation(preparation: ObservationPreparation): Promise<boolean> {
    return this.mutate(preparation.key, preparation.expectedRevision, (current) => {
      if (
        current.responseStreamStatus !== "completed"
        || current.clientDispatchStatus !== "none"
        || (current.observationStatus !== undefined && current.observationStatus !== "none")
      ) return null;
      current.observationStatus = "pending";
      current.observationOutcome = structuredClone(preparation.outcome);
      return current;
    });
  }

  async tryClaimObservation(claim: ObservationClaim): Promise<boolean> {
    if (!claim.leaseOwner || !Number.isFinite(Date.parse(claim.leaseUntil))) return false;
    if (Date.parse(claim.leaseUntil) <= this.now().getTime()) return false;
    return this.mutate(claim.key, claim.expectedRevision, (current) => {
      const expiredLease = current.observationStatus === "running"
        && (!current.observationLeaseUntil
          || Date.parse(current.observationLeaseUntil) <= this.now().getTime());
      if (current.observationStatus !== "pending" && !expiredLease) return null;
      current.observationStatus = "running";
      current.observationAttempt = (current.observationAttempt ?? 0) + 1;
      current.observationLeaseOwner = claim.leaseOwner;
      current.observationLeaseUntil = claim.leaseUntil;
      current.expiresAt = extendToolExecutionExpiryForLease(current.expiresAt, claim.leaseUntil);
      return current;
    });
  }

  async completeObservation(completion: ObservationCompletion): Promise<boolean> {
    return this.mutate(completion.key, completion.expectedRevision, (current) => {
      if (
        current.observationStatus !== "running"
        || current.observationLeaseOwner !== completion.leaseOwner
      ) return null;
      current.observationStatus = "completed";
      return current;
    });
  }

  async markAborted(
    key: ToolExecutionStateKey,
    expectedRevision: number,
  ): Promise<boolean> {
    return this.mutate(key, expectedRevision, (current) => {
      if (current.responseStreamStatus !== "streaming") return null;
      current.responseStreamStatus = "aborted";
      return current;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Shutdown must not reveal connection details or mask the original exit.
      }
    }
  }

  private async runCapabilityProbe(): Promise<void> {
    await this.ensureClient();
    await this.getClient().command({
      query: createToolExecutionStateTableDdl(this.table),
      clickhouse_settings: { wait_end_of_query: 1 },
    });
    for (const query of [
      `ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS schema_version UInt16 DEFAULT 1 AFTER tool_batch_id`,
      `ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS parent_state_key_json String DEFAULT '' AFTER client_dispatch_status`,
      `ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS parent_reentry_attempt UInt32 DEFAULT 0 AFTER parent_state_key_json`,
      `ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS client_dispatch_outcome_json String DEFAULT '' AFTER parent_reentry_attempt`,
      `ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS reentry_lease_owner String DEFAULT '' AFTER client_dispatch_status`,
      `ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS reentry_lease_until String DEFAULT '' AFTER reentry_lease_owner`,
      `ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS reentry_attempt UInt32 DEFAULT 0 AFTER reentry_lease_until`,
      `ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS reentry_outcome_json String DEFAULT '' AFTER reentry_attempt`,
      `ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS observation_status LowCardinality(String) DEFAULT 'none' AFTER reentry_outcome_json`,
      `ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS observation_lease_owner String DEFAULT '' AFTER observation_status`,
      `ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS observation_lease_until String DEFAULT '' AFTER observation_lease_owner`,
      `ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS observation_attempt UInt32 DEFAULT 0 AFTER observation_lease_until`,
      `ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS observation_outcome_json String DEFAULT '' AFTER observation_attempt`,
      `ALTER TABLE ${this.table} MODIFY SETTING non_replicated_deduplication_window = 1000`,
    ]) {
      await this.getClient().command({
        query,
        clickhouse_settings: { wait_end_of_query: 1 },
      });
    }
    await this.validateSchemaCapabilities();

    const now = this.now();
    const probeId = `probe_${this.createMutationToken().replace(/[^A-Za-z0-9_]/g, "_")}`;
    const timestamp = now.toISOString();
    const probe: ToolExecutionContext = {
      key: {
        spaceId: "__native_tool_probe__",
        userId: "__native_tool_probe__",
        agentSource: "anthropic",
        sessionId: probeId,
        contextVersion: "v1",
        toolBatchId: probeId,
      },
      turnSeq: 0,
      protocol: "anthropic",
      round: 1,
      totalCalls: 0,
      assistantSkeleton: [],
      slots: [],
      responseStreamStatus: "streaming",
      clientDispatchStatus: "none",
      upstreamSnapshot: {
        protocol: "anthropic",
        baseMessages: [],
        requestParameters: { model: "__native_tool_probe__", stream: true },
        target: {
          id: "__native_tool_probe__",
          url: "https://invalid.local/native-tool-probe",
          model: "__native_tool_probe__",
          authSource: "global",
        },
      },
      revision: 0,
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.create(probe);
    const updated = await this.compareAndSetClientDispatchStatus({
      key: probe.key,
      expectedRevision: 0,
      expectedStatus: "none",
      nextStatus: "pending",
    });
    const observed = await this.get(probe.key);
    if (!updated || observed?.revision !== 1 || observed.clientDispatchStatus !== "pending") {
      throw new NativeToolStateCapabilityError();
    }
  }

  private async mutate(
    key: ToolExecutionStateKey,
    expectedRevision: number,
    transition: StateTransition,
  ): Promise<boolean> {
    this.assertOpen();
    let current = await this.readStored(key);
    if (!current || current.context.revision !== expectedRevision) return false;

    for (let attempt = 0; attempt < this.maxCasAttempts; attempt++) {
      const next = transition(cloneToolExecutionContext(current.context));
      if (!next) return false;
      next.revision = current.context.revision + 1;
      next.updatedAt = this.now().toISOString();
      validateToolExecutionContext(next);
      const mutationToken = this.createMutationToken();
      await this.executeUpdate(current.context.revision, next, mutationToken);

      const observed = await this.readStored(key);
      if (
        observed
        && observed.context.revision === next.revision
        && observed.mutationToken === mutationToken
      ) return true;
      if (!observed) return false;
      current = observed;
    }
    throw new ToolExecutionConflictError(
      `ClickHouse Native Tool state CAS did not converge for batch ${key.toolBatchId}`,
    );
  }

  private async executeUpdate(
    expectedRevision: number,
    next: ToolExecutionContext,
    mutationToken: string,
  ): Promise<void> {
    const row = encodeToolExecutionStateRow(next, mutationToken);
    const query = [
      `UPDATE ${this.table} SET`,
      "  turn_seq = {nextTurnSeq:UInt64},",
      "  protocol = {nextProtocol:String},",
      "  round = {nextRound:UInt32},",
      "  total_calls = {nextTotalCalls:UInt32},",
      "  call_ids = {nextCallIds:Array(String)},",
      "  assistant_skeleton_json = {nextAssistantSkeletonJson:String},",
      "  slots_json = {nextSlotsJson:String},",
      "  response_stream_status = {nextResponseStreamStatus:String},",
      "  client_dispatch_status = {nextClientDispatchStatus:String},",
      "  parent_state_key_json = {nextParentStateKeyJson:String},",
      "  parent_reentry_attempt = {nextParentReentryAttempt:UInt32},",
      "  client_dispatch_outcome_json = {nextClientDispatchOutcomeJson:String},",
      "  reentry_lease_owner = {nextReentryLeaseOwner:String},",
      "  reentry_lease_until = {nextReentryLeaseUntil:String},",
      "  reentry_attempt = {nextReentryAttempt:UInt32},",
      "  reentry_outcome_json = {nextReentryOutcomeJson:String},",
      "  observation_status = {nextObservationStatus:String},",
      "  observation_lease_owner = {nextObservationLeaseOwner:String},",
      "  observation_lease_until = {nextObservationLeaseUntil:String},",
      "  observation_attempt = {nextObservationAttempt:UInt32},",
      "  observation_outcome_json = {nextObservationOutcomeJson:String},",
      "  upstream_snapshot_json = {nextUpstreamSnapshotJson:String},",
      "  revision = {nextRevision:UInt64},",
      "  mutation_token = {mutationToken:String},",
      "  expires_at = {nextExpiresAt:DateTime64(3)},",
      "  updated_at = {nextUpdatedAt:DateTime64(3)}",
      `WHERE ${this.keyPredicate()}`,
      "  AND revision = {expectedRevision:UInt64}",
      "  AND expires_at > now64(3)",
      "SETTINGS allow_experimental_lightweight_update = 1,",
      "  apply_patch_parts = 1,",
      "  update_parallel_mode = 'sync',",
      "  update_sequential_consistency = 1",
    ].join("\n");
    try {
      await this.getClient().command({
        query,
        query_params: {
          ...this.keyParams(next.key),
          expectedRevision,
          nextTurnSeq: row.turn_seq,
          nextProtocol: row.protocol,
          nextRound: row.round,
          nextTotalCalls: row.total_calls,
          nextCallIds: row.call_ids,
          nextAssistantSkeletonJson: row.assistant_skeleton_json,
          nextSlotsJson: row.slots_json,
          nextResponseStreamStatus: row.response_stream_status,
          nextClientDispatchStatus: row.client_dispatch_status,
          nextParentStateKeyJson: row.parent_state_key_json,
          nextParentReentryAttempt: row.parent_reentry_attempt,
          nextClientDispatchOutcomeJson: row.client_dispatch_outcome_json,
          nextReentryLeaseOwner: row.reentry_lease_owner,
          nextReentryLeaseUntil: row.reentry_lease_until,
          nextReentryAttempt: row.reentry_attempt,
          nextReentryOutcomeJson: row.reentry_outcome_json,
          nextObservationStatus: row.observation_status,
          nextObservationLeaseOwner: row.observation_lease_owner,
          nextObservationLeaseUntil: row.observation_lease_until,
          nextObservationAttempt: row.observation_attempt,
          nextObservationOutcomeJson: row.observation_outcome_json,
          nextUpstreamSnapshotJson: row.upstream_snapshot_json,
          nextRevision: row.revision,
          mutationToken,
          nextExpiresAt: row.expires_at,
          nextUpdatedAt: row.updated_at,
        },
        clickhouse_settings: {
          allow_experimental_lightweight_update: 1,
          apply_patch_parts: 1,
          update_parallel_mode: "sync",
          update_sequential_consistency: 1,
          wait_end_of_query: 1,
          date_time_input_format: "best_effort",
        },
      });
    } catch {
      throw new ToolExecutionStorageError("ClickHouse Native Tool state mutation failed");
    }
  }

  private async readStored(
    key: ToolExecutionStateKey,
  ): Promise<DecodedToolExecutionStateRow | null> {
    const rows = await this.queryRows(
      `${this.selectColumns()}\n`
        + `WHERE ${this.keyPredicate()}\n`
        + "  AND expires_at > now64(3)\n"
        + "ORDER BY updated_at DESC\nLIMIT 1",
      this.keyParams(key),
    );
    const decoded = this.decodeActiveRows(rows);
    return decoded[0] ?? null;
  }

  private async queryRows(
    query: string,
    queryParams: Record<string, unknown>,
  ): Promise<ToolExecutionStateRow[]> {
    try {
      const result = await this.getClient().query({
        query,
        query_params: queryParams,
        format: "JSONEachRow",
        clickhouse_settings: { date_time_output_format: "iso" },
      });
      return await result.json() as ToolExecutionStateRow[];
    } catch (error) {
      if (error instanceof ToolExecutionStorageError) throw error;
      throw new ToolExecutionStorageError("ClickHouse Native Tool state query failed");
    }
  }

  private async validateSchemaCapabilities(): Promise<void> {
    const result = await this.getClient().query({
      query: [
        "SELECT create_table_query",
        "FROM system.tables",
        "WHERE database = {database:String} AND name = {table:String}",
        "LIMIT 1",
      ].join("\n"),
      query_params: { database: this.database, table: this.table },
      format: "JSONEachRow",
    });
    const rows = await result.json();
    const ddl = rows.length === 1
      && rows[0] !== null
      && typeof rows[0] === "object"
      && typeof (rows[0] as Record<string, unknown>).create_table_query === "string"
      ? String((rows[0] as Record<string, unknown>).create_table_query).toLowerCase()
      : "";
    const requiredFragments = [
      "schema_version",
      "reentry_lease_owner",
      "reentry_lease_until",
      "reentry_attempt",
      "reentry_outcome_json",
      "parent_state_key_json",
      "parent_reentry_attempt",
      "client_dispatch_outcome_json",
      "observation_status",
      "observation_lease_owner",
      "observation_lease_until",
      "observation_attempt",
      "observation_outcome_json",
      "ttl expires_at",
      "enable_block_number_column = 1",
      "enable_block_offset_column = 1",
      "non_replicated_deduplication_window = 1000",
    ];
    if (!ddl || requiredFragments.some((fragment) => !ddl.includes(fragment))) {
      throw new NativeToolStateCapabilityError();
    }
  }

  private decodeActiveRows(rows: ToolExecutionStateRow[]): DecodedToolExecutionStateRow[] {
    const now = this.now();
    return rows
      .map(decodeToolExecutionStateRow)
      .filter(({ context }) => !isToolExecutionContextExpired(context, now));
  }

  private selectColumns(): string {
    return [
      "SELECT space_id, user_id, agent_source, session_id, context_version, tool_batch_id, schema_version,",
      "  turn_seq, protocol, round, total_calls, call_ids,",
      "  assistant_skeleton_json, slots_json, response_stream_status,",
      "  client_dispatch_status, reentry_lease_owner, reentry_lease_until, reentry_attempt,",
      "  reentry_outcome_json, observation_status, observation_lease_owner,",
      "  observation_lease_until, observation_attempt, observation_outcome_json, parent_state_key_json, parent_reentry_attempt,",
      "  client_dispatch_outcome_json,",
      "  upstream_snapshot_json, revision, mutation_token,",
      "  expires_at, created_at, updated_at",
      `FROM ${this.table}`,
    ].join("\n");
  }

  private scopePredicate(): string {
    return [
      "space_id = {spaceId:String}",
      "user_id = {userId:String}",
      "agent_source = {agentSource:String}",
      "session_id = {sessionId:String}",
      "context_version = {contextVersion:String}",
    ].join(" AND ");
  }

  private keyPredicate(): string {
    return `${this.scopePredicate()} AND tool_batch_id = {toolBatchId:String}`;
  }

  private scopeParams(scope: ToolExecutionScope): Record<string, unknown> {
    return {
      spaceId: scope.spaceId,
      userId: scope.userId,
      agentSource: scope.agentSource,
      sessionId: scope.sessionId,
      contextVersion: scope.contextVersion,
    };
  }

  private keyParams(key: ToolExecutionStateKey): Record<string, unknown> {
    return { ...this.scopeParams(key), toolBatchId: key.toolBatchId };
  }

  private async ensureClient(): Promise<void> {
    if (this.client) return;
    if (!this.config.clickhouse.enabled || !this.config.clickhouse.url) {
      throw new NativeToolStateCapabilityError();
    }
    const { createClient } = await import("@clickhouse/client");
    const requestTimeout = Math.max(10_000, this.config.nativeProxyTools.toolTimeoutMs * 2);
    const bootstrap = createClient({
      url: this.config.clickhouse.url,
      username: this.config.clickhouse.user,
      password: this.config.clickhouse.password,
      request_timeout: requestTimeout,
    });
    try {
      await bootstrap.command({
        query: `CREATE DATABASE IF NOT EXISTS ${this.database}`,
        clickhouse_settings: { wait_end_of_query: 1 },
      });
    } finally {
      await bootstrap.close().catch(() => {});
    }
    this.client = createClient({
      url: this.config.clickhouse.url,
      username: this.config.clickhouse.user,
      password: this.config.clickhouse.password,
      database: this.database,
      request_timeout: requestTimeout,
      keep_alive: { enabled: true },
    }) as unknown as ToolStateClickHouseClient;
  }

  private getClient(): ToolStateClickHouseClient {
    if (!this.client) {
      throw new ToolExecutionStorageError("ClickHouse Native Tool state client is not initialized");
    }
    return this.client;
  }

  private assertOpen(): void {
    if (this.closed) throw new ToolExecutionStorageError("Tool execution storage Adapter is closed");
  }
}
