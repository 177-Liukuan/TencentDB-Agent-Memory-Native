import { describe, expect, it } from "vitest";

import { createHistoryAnchor } from "../../native-proxy-tools/history-anchor.js";
import { InMemoryNativeToolHistoryStorageAdapter } from "../in-memory-native-tool-history-storage-adapter.js";
import type { NativeToolHistoryRecord } from "../../native-proxy-tools/types.js";

function record(historyId = "history-1"): NativeToolHistoryRecord {
  return {
    historyId,
    logicalTurnId: "turn",
    scope: { spaceId: "space", userId: "user", agentSource: "claude-code", sessionId: "session" },
    clientProtocol: "anthropic",
    upstreamProtocol: "responses",
    anchor: createHistoryAnchor([{ role: "user", content: "q" }]),
    round: 1,
    fullSegment: [{ role: "assistant", content: "hidden" }],
    clientProjection: [],
    proxyCallIds: ["native-1"],
    clientCallIds: [],
    createdAt: "2026-09-02T00:00:00.000Z",
  };
}

describe("Native Tool long-term history storage", () => {
  it("appends idempotently and rejects a different payload with the same history id", async () => {
    const storage = new InMemoryNativeToolHistoryStorageAdapter();
    await storage.appendCompletedBatch(record());
    await storage.appendCompletedBatch(record());
    await expect(storage.appendCompletedBatch({ ...record(), round: 2 })).rejects.toThrow(/conflict/i);
    expect(await storage.findByAnchors(record().scope, [record().anchor])).toHaveLength(1);
  });

  it("keeps completed history independently of short execution-state expiry", async () => {
    const storage = new InMemoryNativeToolHistoryStorageAdapter();
    await storage.appendCompletedBatch(record());
    expect(await storage.findByAnchors(record().scope, [record().anchor])).toEqual([record()]);
  });

  it("updates and confirms a two-step compression receipt", async () => {
    const storage = new InMemoryNativeToolHistoryStorageAdapter();
    const receipt = {
      receiptId: "receipt-1",
      scope: record().scope,
      sourceRootDigest: "a".repeat(64),
      historyIds: ["history-1"],
      createdAt: "2026-09-02T00:00:00.000Z",
    };
    await storage.saveCompressionReceipt(receipt);
    await storage.saveCompressionReceipt({ ...receipt, summaryDigest: "b".repeat(64) });
    await expect(storage.findPendingCompressionReceipts(record().scope)).resolves.toEqual([
      expect.objectContaining({ receiptId: "receipt-1", summaryDigest: "b".repeat(64) }),
    ]);
    await storage.confirmCompression("receipt-1", "c".repeat(64));
    await expect(storage.findPendingCompressionReceipts(record().scope)).resolves.toEqual([]);
  });
});
