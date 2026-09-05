import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type ClickHouseClient } from "@clickhouse/client";

import { DEFAULT_CONFIG } from "../../../src/config.js";
import { InMemoryNativeToolLedgerStorageAdapter } from "../../../src/db/in-memory-native-tool-ledger-storage-adapter.js";
import {
  completeClientToolReentry,
  createPersistedClientReentryOutcome,
  resumeClientToolResults,
} from "../../../src/native-proxy-tools/client-tool-resume.js";
import type { ToolExecutionContext } from "../../../src/native-proxy-tools/types.js";
import {
  ClickHouseToolExecutionStorageAdapter,
} from "../../../src/db/clickhouse-tool-execution-storage-adapter.js";

const integrationEnabled = process.env.NATIVE_TOOL_CLICKHOUSE_TEST === "1";
const describeIntegration = integrationEnabled ? describe : describe.skip;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} for Native Tool ClickHouse integration test`);
  return value;
}

function testContext(batchId: string): ToolExecutionContext {
  const now = new Date();
  const timestamp = now.toISOString();
  return {
    key: {
      spaceId: "native-tool-integration",
      userId: "integration-user",
      agentSource: "claude-code",
      sessionId: `session-${batchId}`,
      contextVersion: "v1",
      toolBatchId: batchId,
    },
    turnSeq: 1,
    protocol: "anthropic",
    round: 1,
    totalCalls: 2,
    assistantSkeleton: [],
    slots: [{
      callId: `proxy-${batchId}`,
      slotIndex: 0,
      contentBlockIndex: 0,
      toolName: "tdai_memory_search",
      owner: "proxy",
      input: { query: "integration rules", limit: 5 },
      argumentsComplete: true,
      status: "pending",
      executionAttempt: 0,
    }],
    responseStreamStatus: "streaming",
    clientDispatchStatus: "none",
    upstreamSnapshot: {
      protocol: "anthropic",
      baseMessages: [{ role: "user", content: "integration" }],
      requestParameters: { model: "integration-model", stream: true, max_tokens: 128 },
      target: {
        id: "integration-target",
        url: "https://invalid.local/integration",
        model: "integration-model",
        authSource: "global",
      },
    },
    revision: 0,
    expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describeIntegration("real ClickHouse Native Tool state", () => {
  let table = "";
  let cleanupClient: ClickHouseClient | undefined;
  let primary: ClickHouseToolExecutionStorageAdapter;
  let secondary: ClickHouseToolExecutionStorageAdapter;

  it("resumes a Client-only round across instances and replays without another model request", async () => {
    const state = testContext(randomUUID());
    state.round = 2;
    state.responseStreamStatus = "completed";
    state.clientDispatchStatus = "dispatched";
    state.slots = [{
      callId: "client-only", slotIndex: 0, contentBlockIndex: 0,
      toolName: "Bash", owner: "client", input: { command: "pwd" },
      argumentsComplete: true, status: "pending", executionAttempt: 0,
    }];
    state.assistantSkeleton = [{ type: "tool_use", id: "client-only", name: "Bash", input: { command: "pwd" } }];
    await primary.create(state);
    const ledgerStorage = new InMemoryNativeToolLedgerStorageAdapter();
    let modelRequests = 0;
    const input = {
      body: { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "client-only", content: "/workspace" }] }] },
      scope: state.key,
      storage: secondary,
      ledgerStorage,
      dispatcher: { execute: async () => { throw new Error("Client result must not execute a Native Tool"); } },
      limits: structuredClone(DEFAULT_CONFIG.nativeProxyTools),
      reenter: async () => {
        modelRequests++;
        return { stream: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), status: 200, headers: new Headers() };
      },
    };
    const resumed = await resumeClientToolResults(input);
    expect(resumed.kind).toBe("reentered");
    if (resumed.kind !== "reentered") throw new Error("expected Client re-entry");
    expect(await ledgerStorage.findRounds(state.key, 0)).toEqual([]);
    expect(await primary.get(state.key)).toMatchObject({
      clientDispatchStatus: "resuming", slots: [{ callId: "client-only", status: "succeeded", result: "/workspace" }],
    });
    await completeClientToolReentry(secondary, state.key, resumed.reentryLeaseOwner,
      createPersistedClientReentryOutcome({ kind: "final", status: 200, headers: new Headers(), bytes: new TextEncoder().encode("done") }));
    const replay = await resumeClientToolResults({ ...input, storage: primary });
    expect(replay.kind).toBe("replay");
    if (replay.kind !== "replay") throw new Error("expected stored response");
    expect(new TextDecoder().decode(replay.bytes)).toBe("done");
    expect(modelRequests).toBe(1);
  }, 30_000);

  beforeAll(async () => {
    const url = requiredEnvironment("NATIVE_TOOL_CLICKHOUSE_URL");
    const database = requiredEnvironment("NATIVE_TOOL_CLICKHOUSE_DATABASE");
    const user = requiredEnvironment("NATIVE_TOOL_CLICKHOUSE_USER");
    const password = process.env.NATIVE_TOOL_CLICKHOUSE_PASSWORD ?? "";
    table = `native_proxy_tool_state_test_${randomUUID().replaceAll("-", "_")}`;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error("Generated ClickHouse integration table identifier is unsafe");
    }

    const testConfig = structuredClone(DEFAULT_CONFIG);
    testConfig.clickhouse = {
      ...testConfig.clickhouse,
      enabled: true,
      url,
      database,
      user,
      password,
    };
    testConfig.nativeProxyTools.enabled = true;
    testConfig.nativeProxyTools.stateStorage.table = table;

    cleanupClient = createClient({ url, database, username: user, password });
    primary = new ClickHouseToolExecutionStorageAdapter(testConfig);
    secondary = new ClickHouseToolExecutionStorageAdapter(testConfig);
    await primary.initializeAndProbe();
    await secondary.initializeAndProbe();
  }, 30_000);

  afterAll(async () => {
    if (cleanupClient && table) {
      await cleanupClient.command({ query: `DROP TABLE IF EXISTS ${table} SYNC` });
    }
    await Promise.allSettled([
      primary?.close(),
      secondary?.close(),
      cleanupClient?.close(),
    ]);
  }, 30_000);

  it("grants one valid lease under concurrent claims", async () => {
    const batchId = randomUUID();
    const state = testContext(batchId);
    await primary.create(state);
    const leaseUntil = new Date(Date.now() + 20_000).toISOString();

    const claims = await Promise.all([
      primary.tryClaimSlotExecution({
        key: state.key,
        callId: state.slots[0].callId,
        expectedRevision: 0,
        leaseOwner: "integration-worker-a",
        leaseUntil,
      }),
      secondary.tryClaimSlotExecution({
        key: state.key,
        callId: state.slots[0].callId,
        expectedRevision: 0,
        leaseOwner: "integration-worker-b",
        leaseUntil,
      }),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    const stored = await primary.get(state.key);
    expect(stored?.slots[0]).toMatchObject({ status: "running", executionAttempt: 1 });
  }, 30_000);

  it("admits one creator under concurrent duplicate batch inserts", async () => {
    const state = testContext(randomUUID());

    const settled = await Promise.allSettled([
      primary.create(structuredClone(state)),
      secondary.create(structuredClone(state)),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await primary.get(state.key)).toMatchObject({ key: state.key, revision: 0 });
  }, 30_000);

  it("updates a Claude Code-sized upstream snapshot without HTTP form overflow", async () => {
    const state = testContext(randomUUID());
    state.upstreamSnapshot.tools = [{
      name: "client_tool_with_large_schema",
      description: "x".repeat(256 * 1024),
      input_schema: { type: "object" },
    }];
    await primary.create(state);

    expect(await primary.compareAndSetClientDispatchStatus({
      key: state.key,
      expectedRevision: 0,
      expectedStatus: "none",
      nextStatus: "pending",
    })).toBe(true);

    const stored = await secondary.get(state.key);
    expect(stored?.upstreamSnapshot.tools).toEqual(state.upstreamSnapshot.tools);
  }, 30_000);

  it("leases and completes Client-result re-entry across Adapter instances", async () => {
    const state = testContext(randomUUID());
    state.responseStreamStatus = "completed";
    state.clientDispatchStatus = "dispatched";
    state.slots = [{
      ...state.slots[0],
      callId: `client-${state.key.toolBatchId}`,
      toolName: "client_shell",
      owner: "client",
      status: "succeeded",
      result: "/workspace",
      isError: false,
    }];
    await primary.create(state);
    const leaseUntil = new Date(Date.now() + 20_000).toISOString();

    const claims = await Promise.all([
      primary.tryClaimReentry({
        key: state.key,
        expectedRevision: 0,
        leaseOwner: "integration-reentry-a",
        leaseUntil,
      }),
      secondary.tryClaimReentry({
        key: state.key,
        expectedRevision: 0,
        leaseOwner: "integration-reentry-b",
        leaseUntil,
      }),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    const claimed = (await primary.get(state.key))!;
    expect(claimed).toMatchObject({ clientDispatchStatus: "resuming", reentryAttempt: 1 });
    const renewedUntil = new Date(Date.now() + 30_000).toISOString();
    expect(await primary.renewReentry({
      key: state.key,
      expectedRevision: claimed.revision,
      leaseOwner: claimed.reentryLeaseOwner!,
      leaseUntil: renewedUntil,
    })).toBe(true);
    const renewed = (await secondary.get(state.key))!;
    expect(renewed).toMatchObject({ reentryLeaseUntil: renewedUntil });
    expect(await secondary.completeReentry({
      key: state.key,
      expectedRevision: renewed.revision,
      leaseOwner: claimed.reentryLeaseOwner!,
      outcome: {
        kind: "final",
        status: 200,
        headers: { "content-type": "text/event-stream" },
        bodyBase64: "ZmluYWw=",
      },
    })).toBe(true);
    expect(await primary.get(state.key)).toMatchObject({
      clientDispatchStatus: "completed",
      reentryOutcome: { bodyBase64: "ZmluYWw=" },
      observationStatus: "pending",
      observationOutcome: { status: 200, bodyBase64: "ZmluYWw=" },
    });
    const pendingObservation = (await primary.get(state.key))!;
    const observationLeaseUntil = new Date(Date.now() + 20_000).toISOString();
    expect(await secondary.tryClaimObservation({
      key: state.key,
      expectedRevision: pendingObservation.revision,
      leaseOwner: "integration-observer",
      leaseUntil: observationLeaseUntil,
    })).toBe(true);
    const runningObservation = (await primary.get(state.key))!;
    expect(runningObservation).toMatchObject({
      observationStatus: "running",
      observationAttempt: 1,
    });
    expect(await primary.completeObservation({
      key: state.key,
      expectedRevision: runningObservation.revision,
      leaseOwner: "integration-observer",
    })).toBe(true);
    expect(await secondary.get(state.key)).toMatchObject({ observationStatus: "completed" });
  }, 30_000);

  it("merges a stream snapshot racing a Native result without losing either", async () => {
    const batchId = randomUUID();
    const state = testContext(batchId);
    const proxyCallId = state.slots[0].callId;
    await primary.create(state);
    await primary.tryClaimSlotExecution({
      key: state.key,
      callId: proxyCallId,
      expectedRevision: 0,
      leaseOwner: "integration-worker",
      leaseUntil: new Date(Date.now() + 20_000).toISOString(),
    });

    const clientCallId = `client-${batchId}`;
    const [snapshotSaved, resultSaved] = await Promise.all([
      primary.compareAndSetStreamSnapshot({
        key: state.key,
        expectedRevision: 1,
        assistantSkeleton: [{ type: "tool_use", id: proxyCallId }],
        slots: [
          state.slots[0],
          {
            callId: clientCallId,
            slotIndex: 1,
            contentBlockIndex: 1,
            toolName: "client_shell",
            owner: "client",
            input: { command: "pwd" },
            argumentsComplete: true,
            status: "pending",
            executionAttempt: 0,
          },
        ],
        responseStreamStatus: "completed",
      }),
      secondary.compareAndSetSlotResult({
        key: state.key,
        callId: proxyCallId,
        expectedRevision: 1,
        leaseOwner: "integration-worker",
        result: { memories: ["rule"] },
        isError: false,
      }),
    ]);

    expect(snapshotSaved).toBe(true);
    expect(resultSaved).toBe(true);
    const stored = await primary.get(state.key);
    expect(stored).toMatchObject({
      revision: 3,
      responseStreamStatus: "completed",
      assistantSkeleton: [{ type: "tool_use", id: proxyCallId }],
      slots: [
        { callId: proxyCallId, status: "succeeded", result: { memories: ["rule"] } },
        { callId: clientCallId, status: "pending" },
      ],
    });
  }, 30_000);
});
