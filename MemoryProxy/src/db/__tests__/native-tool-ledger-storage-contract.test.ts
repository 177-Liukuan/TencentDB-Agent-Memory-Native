import { describe, expect, it } from "vitest";

import {
  createInMemoryNativeToolLedgerBackend,
  InMemoryNativeToolLedgerStorageAdapter,
} from "../in-memory-native-tool-ledger-storage-adapter.js";
import { NativeToolLedgerStorageConflictError } from "../native-tool-ledger-storage-adapter.js";
import type { NativeToolLedgerRound, NativeToolSessionScope } from "../../native-proxy-tools/types.js";

const scope: NativeToolSessionScope = {
  spaceId: "space-1",
  userId: "user-1",
  agentSource: "claude-code",
  sessionId: "session-1",
};

function round(overrides: Partial<NativeToolLedgerRound> = {}): NativeToolLedgerRound {
  return {
    ledgerId: "ledger-1",
    scope,
    contextEpoch: 0,
    turnSeq: 1,
    round: 0,
    clientProtocol: "anthropic",
    blocks: [
      {
        kind: "native_tool",
        blockIndex: 0,
        callId: "native-1",
        toolName: "tdai_memory_search",
        input: { query: "q" },
      },
    ],
    nativeResults: [{ callId: "native-1", value: { ok: true }, isError: false }],
    createdAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("Native Tool ledger storage contract", () => {
  it("stores a completed round idempotently and rejects different content under the same id", async () => {
    const storage = new InMemoryNativeToolLedgerStorageAdapter();
    await storage.appendRound(round());
    await storage.appendRound(round());

    await expect(storage.findRounds(scope, 0)).resolves.toEqual([round()]);
    await expect(storage.appendRound(round({ round: 1 })))
      .rejects.toBeInstanceOf(NativeToolLedgerStorageConflictError);
  });

  it("returns only the requested epoch in turn and round order", async () => {
    const storage = new InMemoryNativeToolLedgerStorageAdapter();
    await storage.appendRound(round({ ledgerId: "later", turnSeq: 2, round: 1 }));
    await storage.appendRound(round({ ledgerId: "first", turnSeq: 1, round: 0 }));
    await storage.appendRound(round({ ledgerId: "other-epoch", contextEpoch: 1 }));

    await expect(storage.findRounds(scope, 0)).resolves.toEqual([
      round({ ledgerId: "first", turnSeq: 1, round: 0 }),
      round({ ledgerId: "later", turnSeq: 2, round: 1 }),
    ]);
  });

  it("increments turnSeq only when a UserPromptSubmit event is recorded", async () => {
    const backend = createInMemoryNativeToolLedgerBackend();
    const firstInstance = new InMemoryNativeToolLedgerStorageAdapter({ backend });
    const secondInstance = new InMemoryNativeToolLedgerStorageAdapter({ backend });

    const first = await firstInstance.recordUserPrompt(scope);
    const second = await secondInstance.recordUserPrompt(scope);

    expect(first.turnSeq).toBe(1);
    expect(second.turnSeq).toBe(2);
    expect(first.turnToken).not.toBe(second.turnToken);
    await expect(secondInstance.findTurnByToken(scope, first.turnToken)).resolves.toEqual(first);
    await expect(firstInstance.getSessionContext(scope)).resolves.toMatchObject({
      currentTurnSeq: 2,
      currentEpoch: 0,
      pendingCompactEpoch: null,
      compactStateError: false,
    });
  });

  it("moves to the explicit pending epoch only after PostCompact", async () => {
    const storage = new InMemoryNativeToolLedgerStorageAdapter();

    await expect(storage.beginCompact(scope, "manual")).resolves.toEqual({
      changed: true,
      targetEpoch: 1,
    });
    await expect(storage.beginCompact(scope, "manual")).resolves.toEqual({
      changed: false,
      targetEpoch: 1,
    });
    await expect(storage.getSessionContext(scope)).resolves.toMatchObject({
      currentEpoch: 0,
      pendingCompactEpoch: 1,
    });

    await expect(storage.completeCompact(scope, "manual")).resolves.toEqual({
      changed: true,
      currentEpoch: 1,
    });
    await expect(storage.completeCompact(scope, "manual")).resolves.toEqual({
      changed: false,
      currentEpoch: 1,
      error: "post_without_pending",
    });
    await expect(storage.getSessionContext(scope)).resolves.toMatchObject({
      currentEpoch: 1,
      pendingCompactEpoch: null,
      compactStateError: true,
    });
  });
});
