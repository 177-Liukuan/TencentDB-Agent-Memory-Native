import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import { createHistoryAnchor } from "../../native-proxy-tools/history-anchor.js";
import type { NativeToolHistoryRecord } from "../../native-proxy-tools/types.js";
import {
  createNativeToolCheckpointTableDdl,
  createNativeToolHistoryTableDdl,
  decodeNativeToolHistoryRow,
  encodeNativeToolHistoryRow,
} from "../clickhouse-native-tool-history-storage-adapter.js";

function history(): NativeToolHistoryRecord {
  return {
    historyId: "history-1",
    logicalTurnId: "turn-1",
    scope: { spaceId: "space", userId: "user", agentSource: "claude-code", sessionId: "session" },
    clientProtocol: "anthropic",
    upstreamProtocol: "responses",
    anchor: createHistoryAnchor([{ role: "user", content: "question" }]),
    round: 2,
    fullSegment: [{ role: "assistant", content: [{ type: "tool_use", id: "native-1", name: "tdai_memory_search", input: {} }] }],
    clientProjection: [],
    proxyCallIds: ["native-1"],
    clientCallIds: ["client-1"],
    createdAt: "2026-09-02T00:00:00.000Z",
    expiresAt: "2026-10-02T00:00:00.000Z",
  };
}

describe("ClickHouse Native Tool history schema", () => {
  it("uses a deterministic key and a TTL independent of execution state", () => {
    const ddl = createNativeToolHistoryTableDdl("native_proxy_tool_history");
    expect(ddl).toContain("history_id String");
    expect(ddl).toContain("anchor_prefix_digest FixedString(64)");
    expect(ddl).toContain("ReplacingMergeTree(updated_at)");
    expect(ddl).toContain("TTL expires_at DELETE WHERE has_expiry = 1");
    expect(ddl).not.toContain("state_ttl");
    expect(createNativeToolCheckpointTableDdl("native_proxy_tool_context_checkpoint"))
      .toContain("receipt_id String");
  });

  it("round-trips the client-native segment without changing tool ids or ordering", () => {
    const decoded = decodeNativeToolHistoryRow(encodeNativeToolHistoryRow(history()));
    expect(decoded).toEqual(history());
  });

  it("represents ttlDays zero as a record without automatic expiry", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.nativeProxyTools.historyStorage.ttlDays = 0;
    const row = encodeNativeToolHistoryRow({ ...history(), expiresAt: undefined });
    expect(row.has_expiry).toBe(0);
  });
});
