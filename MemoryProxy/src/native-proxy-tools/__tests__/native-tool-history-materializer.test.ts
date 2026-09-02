import { describe, expect, it } from "vitest";

import { createHistoryAnchor } from "../history-anchor.js";
import {
  InMemoryNativeToolHistoryStorageAdapter,
} from "../../db/in-memory-native-tool-history-storage-adapter.js";
import { InMemoryToolExecutionStorageAdapter } from "../../db/in-memory-tool-execution-storage-adapter.js";
import {
  backfillActiveCompletedNativeToolHistory,
  NativeToolHistoryConflictError,
  materializeNativeToolHistory,
} from "../native-tool-history-materializer.js";
import type { JsonValue, NativeToolHistoryRecord, NativeToolHistoryScope } from "../types.js";

const scope: NativeToolHistoryScope = {
  spaceId: "space", userId: "user", agentSource: "claude-code", sessionId: "session",
};

function record(overrides: Partial<NativeToolHistoryRecord> = {}): NativeToolHistoryRecord {
  const base = [{ role: "user", content: "question" }];
  return {
    historyId: "history-1",
    logicalTurnId: "turn-1",
    scope,
    clientProtocol: "anthropic",
    upstreamProtocol: "anthropic",
    anchor: createHistoryAnchor(base),
    round: 1,
    fullSegment: [
      { role: "assistant", content: [{ type: "tool_use", id: "native-1", name: "tdai_memory_search", input: { query: "q" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "native-1", content: "memory" }] },
    ],
    clientProjection: [],
    proxyCallIds: ["native-1"],
    clientCallIds: [],
    createdAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("Native Tool history materializer", () => {
  it("inserts a completed pure Native round after its original client prefix exactly once", async () => {
    const storage = new InMemoryNativeToolHistoryStorageAdapter();
    await storage.appendCompletedBatch(record());
    const messages = [
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "follow up" },
    ];

    const result = await materializeNativeToolHistory({ protocol: "anthropic", items: messages, scope, storage });

    expect(result.items).toEqual([
      messages[0],
      ...record().fullSegment,
      messages[1],
      messages[2],
    ]);
    expect(result.historyIds).toEqual(["history-1"]);
  });

  it("replaces a mixed client projection without duplicating client calls or results", async () => {
    const storage = new InMemoryNativeToolHistoryStorageAdapter();
    const projection: JsonValue[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "client-1", name: "Read", input: { file_path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "client-1", content: "file" }] },
    ];
    const fullSegment: JsonValue[] = [
      { role: "assistant", content: [
        { type: "text", text: "checking" },
        { type: "tool_use", id: "native-1", name: "tdai_memory_search", input: { query: "q" } },
        { type: "tool_use", id: "client-1", name: "Read", input: { file_path: "a.ts" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "native-1", content: "memory" },
        { type: "tool_result", tool_use_id: "client-1", content: "file" },
      ] },
    ];
    await storage.appendCompletedBatch(record({ clientProjection: projection, fullSegment, clientCallIds: ["client-1"] }));

    const result = await materializeNativeToolHistory({
      protocol: "anthropic",
      items: [{ role: "user", content: "question" }, ...projection, { role: "assistant", content: "done" }],
      scope,
      storage,
    });

    expect(result.items).toEqual([{ role: "user", content: "question" }, ...fullSegment, { role: "assistant", content: "done" }]);
    expect(JSON.stringify(result.items).match(/client-1/g)?.length).toBe(2);
  });

  it("orders several hidden rounds by round even when completion was persisted out of order", async () => {
    const storage = new InMemoryNativeToolHistoryStorageAdapter();
    await storage.appendCompletedBatch(record({ historyId: "round-2", round: 2, createdAt: "2026-09-02T00:00:02.000Z",
      fullSegment: [{ type: "function_call", call_id: "native-2", name: "tdai_memory_search", arguments: "{}" }, { type: "function_call_output", call_id: "native-2", output: "two" }],
      clientProtocol: "responses", upstreamProtocol: "responses", proxyCallIds: ["native-2"] }));
    await storage.appendCompletedBatch(record({ historyId: "round-1", round: 1,
      fullSegment: [{ type: "function_call", call_id: "native-1", name: "tdai_memory_search", arguments: "{}" }, { type: "function_call_output", call_id: "native-1", output: "one" }],
      clientProtocol: "responses", upstreamProtocol: "responses" }));

    const result = await materializeNativeToolHistory({
      protocol: "responses", items: [{ role: "user", content: "question" }], scope, storage,
    });
    expect(result.items.map((item) => (item as Record<string, unknown>).call_id).filter(Boolean))
      .toEqual(["native-1", "native-1", "native-2", "native-2"]);
  });

  it("replaces several client-visible rounds sharing one anchor as one ordered segment", async () => {
    const storage = new InMemoryNativeToolHistoryStorageAdapter();
    const firstProjection: JsonValue[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "client-1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "client-1", content: "one" }] },
    ];
    const secondProjection: JsonValue[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "client-2", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "client-2", content: "two" }] },
    ];
    const first = record({
      historyId: "round-1", round: 1, clientProjection: firstProjection, clientCallIds: ["client-1"],
      fullSegment: [
        { role: "assistant", content: [
          { type: "tool_use", id: "native-1", name: "tdai_memory_search", input: {} },
          { type: "tool_use", id: "client-1", name: "Read", input: {} },
        ] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "native-1", content: "memory-one" },
          { type: "tool_result", tool_use_id: "client-1", content: "one" },
        ] },
      ],
    });
    const second = record({
      historyId: "round-2", round: 2, createdAt: "2026-09-02T00:00:02.000Z",
      clientProjection: secondProjection, clientCallIds: ["client-2"], proxyCallIds: ["native-2"],
      fullSegment: [
        { role: "assistant", content: [
          { type: "tool_use", id: "client-2", name: "Read", input: {} },
          { type: "tool_use", id: "native-2", name: "tdai_memory_search", input: {} },
        ] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "client-2", content: "two" },
          { type: "tool_result", tool_use_id: "native-2", content: "memory-two" },
        ] },
      ],
    });
    await storage.appendCompletedBatch(second);
    await storage.appendCompletedBatch(first);

    const result = await materializeNativeToolHistory({
      protocol: "anthropic",
      items: [
        { role: "user", content: "question" },
        ...firstProjection,
        ...secondProjection,
        { role: "assistant", content: "done" },
      ],
      scope,
      storage,
    });

    expect(result.items).toEqual([
      { role: "user", content: "question" },
      ...first.fullSegment,
      ...second.fullSegment,
      { role: "assistant", content: "done" },
    ]);
  });

  it("does not restore a record whose anchor belongs to another branch", async () => {
    const storage = new InMemoryNativeToolHistoryStorageAdapter();
    await storage.appendCompletedBatch(record());
    const result = await materializeNativeToolHistory({
      protocol: "anthropic", items: [{ role: "user", content: "different question" }], scope, storage,
    });
    expect(result.items).toEqual([{ role: "user", content: "different question" }]);
  });

  it("rejects an anchor match whose visible client projection conflicts", async () => {
    const storage = new InMemoryNativeToolHistoryStorageAdapter();
    await storage.appendCompletedBatch(record({
      clientProjection: [{ role: "assistant", content: [{ type: "tool_use", id: "client-1", name: "Read", input: {} }] }],
      clientCallIds: ["client-1"],
    }));
    await expect(materializeNativeToolHistory({
      protocol: "anthropic",
      items: [{ role: "user", content: "question" }, { role: "assistant", content: [{ type: "tool_use", id: "other", name: "Read", input: {} }] }],
      scope,
      storage,
    })).rejects.toBeInstanceOf(NativeToolHistoryConflictError);
  });

  it("backfills a completed pre-upgrade state that has not reached the short TTL", async () => {
    const stateStorage = new InMemoryToolExecutionStorageAdapter();
    const historyStorage = new InMemoryNativeToolHistoryStorageAdapter();
    const baseMessages: JsonValue[] = [{ role: "user", content: "question" }];
    await stateStorage.create({
      key: { ...scope, contextVersion: "v1", toolBatchId: "old-batch" },
      turnSeq: 1, protocol: "anthropic", round: 1, totalCalls: 1,
      assistantSkeleton: [{ type: "tool_use", id: "old-native", name: "tdai_memory_search", input: { query: "q" } }],
      slots: [{ callId: "old-native", slotIndex: 0, contentBlockIndex: 0, toolName: "tdai_memory_search", owner: "proxy", input: { query: "q" }, argumentsComplete: true, status: "succeeded", executionAttempt: 1, result: "old result", isError: false }],
      responseStreamStatus: "completed", clientDispatchStatus: "none",
      upstreamSnapshot: {
        protocol: "anthropic", clientProtocol: "anthropic", baseMessages, logicalBaseMessages: baseMessages,
        historyAnchor: createHistoryAnchor(baseMessages), logicalTurnId: "old-turn",
        requestParameters: { model: "model", stream: true },
        target: { id: "target", url: "https://example.test", model: "model", authSource: "global" },
      },
      revision: 1, expiresAt: "2099-01-01T00:00:00.000Z",
      createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:01.000Z",
    });

    await backfillActiveCompletedNativeToolHistory({
      scope: { ...scope, contextVersion: "v1" }, stateStorage, historyStorage,
    });
    expect(await historyStorage.findByAnchors(scope, [createHistoryAnchor(baseMessages)]))
      .toEqual([expect.objectContaining({ proxyCallIds: ["old-native"] })]);
  });
});
