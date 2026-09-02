import { describe, expect, it } from "vitest";

import { InMemoryNativeToolHistoryStorageAdapter } from "../../db/in-memory-native-tool-history-storage-adapter.js";
import {
  beginNativeToolCompression,
  completeNativeToolCompression,
  confirmPendingNativeToolCompressions,
} from "../native-tool-compression-receipt.js";

const scope = { spaceId: "space", userId: "user", agentSource: "claude-code", sessionId: "session" };

describe("Native Tool compression receipts", () => {
  it("records coverage, waits for a successful summary, then confirms the next context", async () => {
    const storage = new InMemoryNativeToolHistoryStorageAdapter();
    const sourceItems = [{ role: "user", content: "long history" }];
    const receipt = await beginNativeToolCompression({
      scope, sourceItems, historyIds: ["history-2", "history-1"], storage,
      now: () => new Date("2026-09-02T00:00:00.000Z"),
    });
    expect(receipt?.historyIds).toEqual(["history-1", "history-2"]);
    await confirmPendingNativeToolCompressions({ scope, currentItems: [{ role: "user", content: "summary" }], storage });
    expect(await storage.findPendingCompressionReceipts(scope)).toHaveLength(1);

    await completeNativeToolCompression({ receipt: receipt!, responseBody: "summary", storage });
    await confirmPendingNativeToolCompressions({ scope, currentItems: sourceItems, storage });
    expect(await storage.findPendingCompressionReceipts(scope)).toHaveLength(1);
    await confirmPendingNativeToolCompressions({ scope, currentItems: [{ role: "user", content: "summary" }], storage });
    expect(await storage.findPendingCompressionReceipts(scope)).toEqual([]);
  });

  it("does not create a receipt when no hidden history was materialized", async () => {
    const storage = new InMemoryNativeToolHistoryStorageAdapter();
    await expect(beginNativeToolCompression({ scope, sourceItems: [], historyIds: [], storage })).resolves.toBeNull();
  });
});
