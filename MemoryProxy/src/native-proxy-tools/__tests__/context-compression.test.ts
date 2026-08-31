import { describe, expect, it } from "vitest";

import { InMemoryToolExecutionStorageAdapter } from "../../db/in-memory-tool-execution-storage-adapter.js";
import { commitContextCompressionCheckpoint, prepareContextCompression } from "../context-compression.js";
import type { ToolExecutionContext, ToolExecutionScope } from "../types.js";

const now = new Date("2026-08-31T06:00:00.000Z");
const scope: ToolExecutionScope = {
  spaceId: "space-1", userId: "user-1", agentSource: "codebuddy", sessionId: "session-1", contextVersion: "v1",
};

function state(status: "succeeded" | "running" = "succeeded"): ToolExecutionContext {
  return {
    key: { ...scope, toolBatchId: `batch-${status}` }, turnSeq: 2, protocol: "openai", round: 1, totalCalls: 1,
    assistantSkeleton: [{ id: `call-${status}`, type: "function", function: { name: "tdai_memory_search", arguments: "{\"query\":\"x\"}" } }],
    slots: [{
      callId: `call-${status}`, slotIndex: 0, contentBlockIndex: 0, toolName: "tdai_memory_search", owner: "proxy",
      input: { query: "x" }, argumentsComplete: true, status, executionAttempt: 1,
      ...(status === "succeeded" ? { result: { hits: ["hidden"] }, isError: false } : {
        executionLeaseOwner: "worker", executionLeaseUntil: new Date(now.getTime() + 30_000).toISOString(),
      }),
    }],
    responseStreamStatus: "completed", clientDispatchStatus: "none",
    upstreamSnapshot: {
      protocol: "openai", baseMessages: [{ role: "user", content: "question" }],
      requestParameters: { model: "gpt-test", stream: true },
      target: { id: "target", url: "https://upstream.test/chat/completions", model: "gpt-test", authSource: "agent" },
    },
    revision: 0, expiresAt: new Date(now.getTime() + 300_000).toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
}

describe("Context Compression hidden history", () => {
  it("rehydrates only completed hidden batches and checkpoints only after commit", async () => {
    const storage = new InMemoryToolExecutionStorageAdapter({ now: () => now });
    await storage.create(state("succeeded"));
    await storage.create(state("running"));

    const preparation = await prepareContextCompression({
      body: { messages: [{ role: "user", content: "question" }, { role: "user", content: "compress now" }] },
      scope, storage, createId: () => "checkpoint-1",
    });

    expect(preparation?.body.messages).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: null, tool_calls: state().assistantSkeleton },
      { role: "tool", tool_call_id: "call-succeeded", content: "{\"hits\":[\"hidden\"]}" },
      { role: "user", content: "compress now" },
    ]);
    expect((await storage.get(state().key))?.upstreamSnapshot.compressionCheckpoint).toBeUndefined();

    await commitContextCompressionCheckpoint({ preparation: preparation!, storage, now: () => now });
    expect((await storage.get(state().key))?.upstreamSnapshot.compressionCheckpoint).toEqual({
      id: "checkpoint-1", coveredAt: now.toISOString(),
    });
    expect(await prepareContextCompression({
      body: { messages: [] }, scope, storage, createId: () => "checkpoint-2",
    })).toBeNull();
  });
});

describe("Responses Context Compression history", () => {
  it("rehydrates output items and function_call_output into input[]", async () => {
    const storage = new InMemoryToolExecutionStorageAdapter({ now: () => now });
    const responses = state("succeeded");
    responses.key.toolBatchId = "responses-batch";
    responses.protocol = "responses";
    responses.assistantSkeleton = [{ type: "function_call", id: "fc_1", call_id: "call-succeeded", name: "tdai_memory_search", arguments: "{\"query\":\"x\"}" }];
    responses.upstreamSnapshot = {
      ...responses.upstreamSnapshot,
      protocol: "responses",
      instructions: "be helpful",
      target: { ...responses.upstreamSnapshot.target, url: "https://upstream.test/v1/responses" },
    };
    await storage.create(responses);

    const preparation = await prepareContextCompression({
      body: { input: [{ role: "user", content: "question" }, { role: "user", content: "compress" }] },
      scope, storage, createId: () => "responses-checkpoint",
    });
    expect(preparation?.body.input).toEqual([
      { role: "user", content: "question" },
      ...responses.assistantSkeleton,
      { type: "function_call_output", call_id: "call-succeeded", output: "{\"hits\":[\"hidden\"]}" },
      { role: "user", content: "compress" },
    ]);
  });
});
