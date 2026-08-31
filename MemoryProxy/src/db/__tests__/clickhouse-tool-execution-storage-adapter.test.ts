import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import type { ToolExecutionContext } from "../../native-proxy-tools/types.js";
import {
  ClickHouseToolExecutionStorageAdapter,
  NativeToolStateCapabilityError,
  createToolExecutionStateTableDdl,
  decodeToolExecutionStateRow,
  type ToolStateClickHouseClient,
  type ToolStateClickHouseCommand,
  type ToolStateClickHouseInsert,
  type ToolStateClickHouseQuery,
  type ToolExecutionStateRow,
} from "../clickhouse-tool-execution-storage-adapter.js";
import { ToolExecutionConflictError } from "../tool-execution-storage-adapter.js";
import { runToolExecutionStorageContract } from "./tool-execution-storage-contract.test.js";

const fixedNow = new Date("2026-08-31T00:00:00.000Z");

function config() {
  const value = structuredClone(DEFAULT_CONFIG);
  value.clickhouse.enabled = true;
  value.clickhouse.url = "http://clickhouse.internal:8123";
  value.clickhouse.database = "proxy_state";
  value.clickhouse.user = "proxy-user";
  value.clickhouse.password = "super-secret-password";
  value.nativeProxyTools.enabled = true;
  value.nativeProxyTools.stateStorage.table = "native_tool_state_test";
  return value;
}

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  const timestamp = fixedNow.toISOString();
  return {
    key: {
      spaceId: "space-'quoted",
      userId: "user-1",
      agentSource: "claude-code",
      sessionId: "session-1",
      contextVersion: "v1",
      toolBatchId: "batch-1",
    },
    turnSeq: 1,
    protocol: "anthropic",
    round: 1,
    totalCalls: 1,
    assistantSkeleton: [],
    slots: [{
      callId: "p1",
      slotIndex: 0,
      contentBlockIndex: 0,
      toolName: "tdai_memory_search",
      owner: "proxy",
      input: { query: "rules", limit: 5 },
      argumentsComplete: true,
      status: "pending",
      executionAttempt: 0,
    }],
    responseStreamStatus: "streaming",
    clientDispatchStatus: "none",
    upstreamSnapshot: {
      protocol: "anthropic",
      baseMessages: [{ role: "user", content: "hello" }],
      requestParameters: { model: "claude-test", stream: true, max_tokens: 1_024 },
      target: {
        id: "agent:claude-code",
        url: "https://upstream.example/v1/messages",
        model: "claude-test",
        authSource: "agent",
      },
    },
    revision: 0,
    expiresAt: new Date(fixedNow.getTime() + 60_000).toISOString(),
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

class RecordingClickHouseClient implements ToolStateClickHouseClient {
  readonly commands: ToolStateClickHouseCommand[] = [];
  readonly inserts: ToolStateClickHouseInsert[] = [];
  readonly queries: ToolStateClickHouseQuery[] = [];
  readonly rows = new Map<string, ToolExecutionStateRow>();
  discardUpdates = false;
  failNextCommand?: Error;
  schemaDdl = createToolExecutionStateTableDdl("native_tool_state_test");

  async command(command: ToolStateClickHouseCommand): Promise<void> {
    this.commands.push(structuredClone(command));
    if (this.failNextCommand) {
      const error = this.failNextCommand;
      this.failNextCommand = undefined;
      throw error;
    }
    if (!/^\s*UPDATE\s/i.test(command.query) || this.discardUpdates) return;
    const params = command.query_params ?? {};
    const storageKey = this.storageKey(params);
    const row = this.rows.get(storageKey);
    if (!row || Number(row.revision) !== Number(params.expectedRevision)) return;
    this.rows.set(storageKey, {
      space_id: String(params.spaceId),
      user_id: String(params.userId),
      agent_source: String(params.agentSource),
      session_id: String(params.sessionId),
      context_version: String(params.contextVersion),
      tool_batch_id: String(params.toolBatchId),
      schema_version: row.schema_version ?? 1,
      turn_seq: Number(params.nextTurnSeq),
      protocol: String(params.nextProtocol),
      round: Number(params.nextRound),
      total_calls: Number(params.nextTotalCalls),
      call_ids: structuredClone(params.nextCallIds as string[]),
      assistant_skeleton_json: this.decodeStringAssignment(command, "assistant_skeleton_json", params.nextAssistantSkeletonJson),
      slots_json: this.decodeStringAssignment(command, "slots_json", params.nextSlotsJson),
      response_stream_status: String(params.nextResponseStreamStatus),
      client_dispatch_status: String(params.nextClientDispatchStatus),
      parent_state_key_json: this.decodeStringAssignment(command, "parent_state_key_json", params.nextParentStateKeyJson),
      parent_reentry_attempt: Number(params.nextParentReentryAttempt ?? 0),
      client_dispatch_outcome_json: this.decodeStringAssignment(command, "client_dispatch_outcome_json", params.nextClientDispatchOutcomeJson),
      reentry_lease_owner: String(params.nextReentryLeaseOwner ?? ""),
      reentry_lease_until: String(params.nextReentryLeaseUntil ?? ""),
      reentry_attempt: Number(params.nextReentryAttempt ?? 0),
      reentry_outcome_json: this.decodeStringAssignment(command, "reentry_outcome_json", params.nextReentryOutcomeJson),
      observation_status: String(params.nextObservationStatus ?? "none"),
      observation_lease_owner: String(params.nextObservationLeaseOwner ?? ""),
      observation_lease_until: String(params.nextObservationLeaseUntil ?? ""),
      observation_attempt: Number(params.nextObservationAttempt ?? 0),
      observation_outcome_json: this.decodeStringAssignment(command, "observation_outcome_json", params.nextObservationOutcomeJson),
      upstream_snapshot_json: this.decodeStringAssignment(command, "upstream_snapshot_json", params.nextUpstreamSnapshotJson),
      revision: Number(params.nextRevision),
      mutation_token: String(params.mutationToken),
      expires_at: String(params.nextExpiresAt),
      created_at: row.created_at,
      updated_at: String(params.nextUpdatedAt),
    });
  }

  async insert(insert: ToolStateClickHouseInsert): Promise<void> {
    this.inserts.push(structuredClone(insert));
    for (const row of insert.values) {
      this.rows.set(this.storageKey({
        spaceId: row.space_id,
        userId: row.user_id,
        agentSource: row.agent_source,
        sessionId: row.session_id,
        contextVersion: row.context_version,
        toolBatchId: row.tool_batch_id,
      }), structuredClone(row));
    }
  }

  async query(query: ToolStateClickHouseQuery) {
    this.queries.push(structuredClone(query));
    if (query.query.includes("FROM system.tables")) {
      return { json: async () => [{ create_table_query: this.schemaDdl }] };
    }
    const params = query.query_params ?? {};
    let rows = [...this.rows.values()];
    if (params.toolBatchId !== undefined) {
      const row = this.rows.get(this.storageKey(params));
      rows = row ? [row] : [];
    } else {
      rows = rows.filter((row) => (
        row.space_id === params.spaceId
        && row.user_id === params.userId
        && row.agent_source === params.agentSource
        && row.session_id === params.sessionId
        && row.context_version === params.contextVersion
      ));
    }
    if (params.callId !== undefined) {
      rows = rows.filter((row) => row.call_ids.includes(String(params.callId)));
    }
    return {
      json: async () => structuredClone(rows),
    };
  }

  async close(): Promise<void> {}

  private storageKey(params: Record<string, unknown>): string {
    return JSON.stringify([
      params.spaceId,
      params.userId,
      params.agentSource,
      params.sessionId,
      params.contextVersion,
      params.toolBatchId,
    ]);
  }

  private decodeStringAssignment(
    command: ToolStateClickHouseCommand,
    column: string,
    parameterValue: unknown,
  ): string {
    if (typeof parameterValue === "string") return parameterValue;
    const match = command.query.match(new RegExp(
      `${column}\\s*=\\s*base64Decode\\('([A-Za-z0-9+/=]*)'\\)`,
    ));
    if (!match) throw new Error(`Missing encoded assignment for ${column}`);
    return Buffer.from(match[1], "base64").toString("utf8");
  }
}

function tokenSequence(): () => string {
  let sequence = 0;
  return () => `mutation-${++sequence}`;
}

describe("ClickHouseToolExecutionStorageAdapter", () => {
  it("rejects unsafe identifiers before constructing SQL", () => {
    expect(() => createToolExecutionStateTableDdl("state; DROP TABLE usage_logs"))
      .toThrow(/identifier/);
    const unsafe = config();
    unsafe.clickhouse.database = "db; DROP DATABASE default";
    expect(() => new ClickHouseToolExecutionStorageAdapter(unsafe, {
      client: new RecordingClickHouseClient(),
    })).toThrow(/identifier/);
  });

  it("creates a MergeTree table suitable for Lightweight UPDATE and dynamic TTL", () => {
    const ddl = createToolExecutionStateTableDdl("native_tool_state_test");

    expect(ddl).toContain("call_ids Array(String)");
    expect(ddl).toContain("assistant_skeleton_json String");
    expect(ddl).toContain("slots_json String");
    expect(ddl).toContain("upstream_snapshot_json String");
    expect(ddl).toContain("mutation_token String");
    expect(ddl).toContain("schema_version UInt16 DEFAULT 1");
    expect(ddl).toContain("reentry_lease_owner String");
    expect(ddl).toContain("reentry_outcome_json String");
    expect(ddl).toContain("parent_state_key_json String");
    expect(ddl).toContain("client_dispatch_outcome_json String");
    expect(ddl).toContain("observation_status LowCardinality(String)");
    expect(ddl).toContain("TTL expires_at DELETE");
    expect(ddl).toContain("enable_block_number_column = 1");
    expect(ddl).toContain("enable_block_offset_column = 1");
    expect(ddl).toContain("non_replicated_deduplication_window = 1000");
  });

  it("round-trips a row without storing credentials", async () => {
    const client = new RecordingClickHouseClient();
    const adapter = new ClickHouseToolExecutionStorageAdapter(config(), {
      client,
      now: () => fixedNow,
      createMutationToken: tokenSequence(),
    });

    await adapter.create(context());
    const stored = await adapter.get(context().key);

    expect(stored).toEqual(context());
    const serializedInsert = JSON.stringify(client.inserts);
    expect(serializedInsert).not.toContain("super-secret-password");
    expect(serializedInsert).not.toContain("authorization");
    expect(client.inserts[0].clickhouse_settings).toMatchObject({
      insert_deduplicate: 1,
      insert_deduplication_token: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("uses revision predicates, parameters, and strict Lightweight UPDATE settings", async () => {
    const client = new RecordingClickHouseClient();
    const adapter = new ClickHouseToolExecutionStorageAdapter(config(), {
      client,
      now: () => fixedNow,
      createMutationToken: tokenSequence(),
    });
    await adapter.create(context());

    await expect(adapter.compareAndSetClientDispatchStatus({
      key: context().key,
      expectedRevision: 0,
      expectedStatus: "none",
      nextStatus: "pending",
    })).resolves.toBe(true);

    const update = [...client.commands].reverse()
      .find((command) => /^\s*UPDATE\s/i.test(command.query));
    expect(update?.query).toContain("revision = {expectedRevision:UInt64}");
    expect(update?.query).toContain("allow_experimental_lightweight_update = 1");
    expect(update?.query).toContain("update_parallel_mode = 'sync'");
    expect(update?.query).toContain("update_sequential_consistency = 1");
    expect(update?.query).not.toContain("space-'quoted");
    expect(update?.query_params).toMatchObject({
      spaceId: "space-'quoted",
      expectedRevision: 0,
      nextRevision: 1,
      nextClientDispatchStatus: "pending",
      nextExpiresAt: "2026-08-31 00:01:00.000",
      nextUpdatedAt: "2026-08-31 00:00:00.000",
    });
  });

  it("keeps large persisted snapshots out of ClickHouse HTTP form fields", async () => {
    const client = new RecordingClickHouseClient();
    const adapter = new ClickHouseToolExecutionStorageAdapter(config(), {
      client,
      now: () => fixedNow,
      createMutationToken: tokenSequence(),
    });
    const largeContext = context();
    largeContext.upstreamSnapshot.tools = [{
      name: "client_tool_with_large_schema",
      description: "x".repeat(256 * 1024),
      input_schema: { type: "object" },
    }];
    await adapter.create(largeContext);

    await expect(adapter.compareAndSetClientDispatchStatus({
      key: largeContext.key,
      expectedRevision: 0,
      expectedStatus: "none",
      nextStatus: "pending",
    })).resolves.toBe(true);

    const update = [...client.commands].reverse()
      .find((command) => /^\s*UPDATE\s/i.test(command.query));
    const formStringBytes = Object.values(update?.query_params ?? {})
      .filter((value): value is string => typeof value === "string")
      .map((value) => Buffer.byteLength(value));
    expect(Math.max(...formStringBytes)).toBeLessThan(64 * 1024);
    expect(update?.query.length).toBeGreaterThan(256 * 1024);
  });

  it("returns false for an initially stale revision without issuing UPDATE", async () => {
    const client = new RecordingClickHouseClient();
    const adapter = new ClickHouseToolExecutionStorageAdapter(config(), {
      client,
      now: () => fixedNow,
      createMutationToken: tokenSequence(),
    });
    await adapter.create(context({ revision: 3 }));

    await expect(adapter.markAborted(context().key, 2)).resolves.toBe(false);
    expect(client.commands.some((command) => /^\s*UPDATE\s/i.test(command.query))).toBe(false);
  });

  it("requires read-back of its unique mutation token", async () => {
    const client = new RecordingClickHouseClient();
    client.discardUpdates = true;
    const adapter = new ClickHouseToolExecutionStorageAdapter(config(), {
      client,
      now: () => fixedNow,
      createMutationToken: tokenSequence(),
      maxCasAttempts: 3,
    });
    await adapter.create(context());

    await expect(adapter.markAborted(context().key, 0))
      .rejects.toBeInstanceOf(ToolExecutionConflictError);
    expect(client.commands.filter((command) => /^\s*UPDATE\s/i.test(command.query)))
      .toHaveLength(3);
  });

  it("filters every state lookup by logical expiry", async () => {
    const client = new RecordingClickHouseClient();
    const adapter = new ClickHouseToolExecutionStorageAdapter(config(), {
      client,
      now: () => fixedNow,
      createMutationToken: tokenSequence(),
    });
    await adapter.create(context());

    await adapter.get(context().key);
    await adapter.findByCallId(context().key, "p1");
    await adapter.findActiveBySession(context().key);

    const lookupQueries = client.queries.slice(-3).map((query) => query.query);
    expect(lookupQueries).toHaveLength(3);
    for (const query of lookupQueries) {
      expect(query).toContain("expires_at > now64(3)");
    }
  });

  it("adds the dispatchability predicate exactly once for Client Result lookup", async () => {
    const client = new RecordingClickHouseClient();
    const adapter = new ClickHouseToolExecutionStorageAdapter(config(), {
      client,
      now: () => fixedNow,
      createMutationToken: tokenSequence(),
    });
    await adapter.create(context());

    await adapter.findByCallId(context().key, "p1", { dispatchableOnly: true });

    const lookup = client.queries.at(-1)?.query ?? "";
    expect(lookup.match(/client_dispatch_status IN/g)).toHaveLength(1);
    expect(lookup.match(/response_stream_status = 'completed'/g)).toHaveLength(1);
  });

  it("decodes numeric strings and rejects corrupt JSON", () => {
    const original = context();
    const row: ToolExecutionStateRow = {
      space_id: original.key.spaceId,
      user_id: original.key.userId,
      agent_source: original.key.agentSource,
      session_id: original.key.sessionId,
      context_version: original.key.contextVersion,
      tool_batch_id: original.key.toolBatchId,
      turn_seq: "1",
      protocol: "anthropic",
      round: "1",
      total_calls: "1",
      call_ids: ["p1"],
      assistant_skeleton_json: "[]",
      slots_json: JSON.stringify(original.slots),
      response_stream_status: "streaming",
      client_dispatch_status: "none",
      reentry_lease_owner: "",
      reentry_lease_until: "",
      reentry_attempt: 0,
      reentry_outcome_json: "",
      upstream_snapshot_json: JSON.stringify(original.upstreamSnapshot),
      revision: "0",
      mutation_token: "insert-1",
      expires_at: original.expiresAt,
      created_at: original.createdAt,
      updated_at: original.updatedAt,
    };

    expect(decodeToolExecutionStateRow(row).context).toEqual(original);
    expect(() => decodeToolExecutionStateRow({ ...row, slots_json: "{bad" }))
      .toThrow(/corrupt/);
    expect(() => decodeToolExecutionStateRow({ ...row, schema_version: 2 }))
      .toThrow(/corrupt/);
  });

  it("sanitizes capability probe failures and never falls back", async () => {
    const client = new RecordingClickHouseClient();
    client.failNextCommand = new Error("connection rejected super-secret-password");
    const adapter = new ClickHouseToolExecutionStorageAdapter(config(), {
      client,
      now: () => fixedNow,
      createMutationToken: tokenSequence(),
    });

    let thrown: unknown;
    try {
      await adapter.initializeAndProbe();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NativeToolStateCapabilityError);
    expect((thrown as Error).message).toBe("ClickHouse Native Tool state capability probe failed");
    expect((thrown as Error).message).not.toContain("super-secret-password");
  });

  it("fails closed when an existing table lacks required TTL or update settings", async () => {
    const client = new RecordingClickHouseClient();
    client.schemaDdl = "CREATE TABLE native_tool_state_test (tool_batch_id String) ENGINE=MergeTree ORDER BY tool_batch_id";
    const adapter = new ClickHouseToolExecutionStorageAdapter(config(), {
      client,
      now: () => fixedNow,
      createMutationToken: tokenSequence(),
    });

    await expect(adapter.initializeAndProbe()).rejects.toBeInstanceOf(NativeToolStateCapabilityError);
  });
});

runToolExecutionStorageContract("ClickHouse Adapter contract over a shared recording client", () => {
  const client = new RecordingClickHouseClient();
  const sharedConfig = config();
  let currentTime = fixedNow.getTime();
  const now = () => new Date(currentTime);
  const createMutationToken = tokenSequence();
  return {
    primary: new ClickHouseToolExecutionStorageAdapter(sharedConfig, {
      client,
      now,
      createMutationToken,
    }),
    secondary: new ClickHouseToolExecutionStorageAdapter(sharedConfig, {
      client,
      now,
      createMutationToken,
    }),
    now,
    advance(milliseconds: number) {
      currentTime += milliseconds;
    },
  };
});
