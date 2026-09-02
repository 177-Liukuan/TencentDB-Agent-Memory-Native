import { randomUUID } from "node:crypto";

import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../../src/config.js";
import {
  ClickHouseNativeToolHistoryStorageAdapter,
} from "../../../src/db/clickhouse-native-tool-history-storage-adapter.js";
import { createHistoryAnchor } from "../../../src/native-proxy-tools/history-anchor.js";
import type {
  NativeToolCompressionReceipt,
  NativeToolHistoryRecord,
} from "../../../src/native-proxy-tools/types.js";

const integrationEnabled = process.env.NATIVE_TOOL_CLICKHOUSE_TEST === "1";
const describeIntegration = integrationEnabled ? describe : describe.skip;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} for Native Tool ClickHouse integration test`);
  return value;
}

const scope = {
  spaceId: "native-tool-history-integration",
  userId: "integration-user",
  agentSource: "claude-code",
  sessionId: `session-${randomUUID()}`,
};

function history(overrides: Partial<NativeToolHistoryRecord> = {}): NativeToolHistoryRecord {
  const callId = `call-${randomUUID()}`;
  const createdAt = new Date().toISOString();
  return {
    historyId: `history-${randomUUID()}`,
    logicalTurnId: `turn-${randomUUID()}`,
    scope,
    clientProtocol: "anthropic",
    upstreamProtocol: "anthropic",
    anchor: createHistoryAnchor([{ role: "user", content: "question" }]),
    round: 1,
    fullSegment: [
      { role: "assistant", content: [{ type: "tool_use", id: callId, name: "tdai_memory_search", input: { query: "rules" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: "result" }] },
    ],
    clientProjection: [],
    proxyCallIds: [callId],
    clientCallIds: [],
    createdAt,
    ...overrides,
  };
}

describeIntegration("real ClickHouse Native Tool long-term history", () => {
  let historyTable = "";
  let checkpointTable = "";
  let cleanupClient: ClickHouseClient | undefined;
  let primary: ClickHouseNativeToolHistoryStorageAdapter;
  let secondary: ClickHouseNativeToolHistoryStorageAdapter;

  beforeAll(async () => {
    const url = requiredEnvironment("NATIVE_TOOL_CLICKHOUSE_URL");
    const database = requiredEnvironment("NATIVE_TOOL_CLICKHOUSE_DATABASE");
    const user = requiredEnvironment("NATIVE_TOOL_CLICKHOUSE_USER");
    const password = process.env.NATIVE_TOOL_CLICKHOUSE_PASSWORD ?? "";
    const suffix = randomUUID().replaceAll("-", "_");
    historyTable = `native_proxy_tool_history_test_${suffix}`;
    checkpointTable = `native_proxy_tool_checkpoint_test_${suffix}`;

    const config = structuredClone(DEFAULT_CONFIG);
    config.clickhouse = { ...config.clickhouse, enabled: true, url, database, user, password };
    config.nativeProxyTools.enabled = true;
    config.nativeProxyTools.historyStorage.table = historyTable;
    config.nativeProxyTools.historyStorage.checkpointTable = checkpointTable;
    config.nativeProxyTools.historyStorage.ttlDays = 30;
    cleanupClient = createClient({ url, database, username: user, password });
    primary = new ClickHouseNativeToolHistoryStorageAdapter(config);
    secondary = new ClickHouseNativeToolHistoryStorageAdapter(config);
    await primary.initializeAndProbe();
    await secondary.initializeAndProbe();
  }, 30_000);

  afterAll(async () => {
    if (cleanupClient) {
      if (historyTable) await cleanupClient.command({ query: `DROP TABLE IF EXISTS ${historyTable} SYNC` });
      if (checkpointTable) await cleanupClient.command({ query: `DROP TABLE IF EXISTS ${checkpointTable} SYNC` });
    }
    await Promise.allSettled([primary?.close(), secondary?.close(), cleanupClient?.close()]);
  }, 30_000);

  it("reads a completed batch from another adapter by its stable position", async () => {
    const record = history();
    await primary.appendCompletedBatch(record);

    await expect(secondary.findByAnchors(scope, [record.anchor])).resolves.toEqual([
      expect.objectContaining({ historyId: record.historyId, proxyCallIds: record.proxyCallIds }),
    ]);
  });

  it("keeps one effective row when two instances append the same batch", async () => {
    const record = history();
    await Promise.all([
      primary.appendCompletedBatch(structuredClone(record)),
      secondary.appendCompletedBatch(structuredClone(record)),
    ]);
    const rows = await primary.findByAnchors(scope, [record.anchor]);
    expect(rows.filter((candidate) => candidate.historyId === record.historyId)).toHaveLength(1);
  });

  it("does not return records from another branch or session", async () => {
    const record = history();
    await primary.appendCompletedBatch(record);
    expect(await secondary.findByAnchors(scope, [createHistoryAnchor([{ role: "user", content: "other" }])]))
      .toEqual([]);
    expect(await secondary.findByAnchors({ ...scope, sessionId: "other-session" }, [record.anchor]))
      .toEqual([]);
  });

  it("uses the long-term TTL rather than the 1800-second execution-state TTL", async () => {
    const createdAt = new Date(Date.now() - 1_900_000).toISOString();
    const record = history({ createdAt });
    await primary.appendCompletedBatch(record);
    const stored = (await secondary.findByAnchors(scope, [record.anchor]))
      .find((candidate) => candidate.historyId === record.historyId);
    expect(stored?.expiresAt).toBe(new Date(Date.parse(createdAt) + 30 * 86_400_000).toISOString());
  });

  it("persists and confirms a compression receipt", async () => {
    const receipt: NativeToolCompressionReceipt = {
      receiptId: `receipt-${randomUUID()}`,
      scope,
      sourceRootDigest: createHistoryAnchor([]).prefixDigest,
      historyIds: ["history-covered"],
      summaryDigest: createHistoryAnchor([{ role: "assistant", content: "summary" }]).prefixDigest,
      createdAt: new Date().toISOString(),
    };
    await primary.saveCompressionReceipt(receipt);
    await expect(secondary.findPendingCompressionReceipts(scope)).resolves.toEqual([
      expect.objectContaining({ receiptId: receipt.receiptId, summaryDigest: receipt.summaryDigest }),
    ]);
    await secondary.confirmCompression(receipt.receiptId, "next-root");
    await expect(primary.findPendingCompressionReceipts(scope)).resolves.toEqual([]);
    const result = await cleanupClient!.query({
      query: `SELECT next_context_root, confirmed_at FROM ${checkpointTable} FINAL WHERE receipt_id={receiptId:String}`,
      query_params: { receiptId: receipt.receiptId },
      format: "JSONEachRow",
    });
    const rows = await result.json<{ next_context_root: string; confirmed_at: string | null }>();
    expect(rows).toEqual([expect.objectContaining({ next_context_root: "next-root", confirmed_at: expect.any(String) })]);
  });
});
