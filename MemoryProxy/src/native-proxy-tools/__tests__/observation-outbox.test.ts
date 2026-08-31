import { describe, expect, it } from "vitest";

import { InMemoryToolExecutionStorageAdapter } from "../../db/in-memory-tool-execution-storage-adapter.js";
import type { ToolExecutionContext } from "../types.js";
import {
  claimToolObservation,
  completeToolObservation,
  ToolObservationOutboxError,
} from "../observation-outbox.js";
import { extractAnthropicLogicalResponse } from "../anthropic-logical-response.js";

const initialNow = new Date("2026-08-31T04:00:00.000Z");

function pendingObservation(): ToolExecutionContext {
  const timestamp = initialNow.toISOString();
  return {
    key: {
      spaceId: "space-1",
      userId: "user-1",
      agentSource: "claude-code",
      sessionId: "session-1",
      contextVersion: "v1",
      toolBatchId: "batch-1",
    },
    turnSeq: 1,
    protocol: "anthropic",
    round: 2,
    totalCalls: 1,
    assistantSkeleton: [],
    slots: [],
    responseStreamStatus: "completed",
    clientDispatchStatus: "completed",
    reentryOutcome: {
      kind: "final",
      status: 200,
      headers: { "content-type": "text/event-stream" },
      bodyBase64: "ZmluYWw=",
    },
    observationStatus: "pending",
    observationOutcome: {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      bodyBase64: "ZmluYWw=",
    },
    upstreamSnapshot: {
      protocol: "anthropic",
      baseMessages: [{ role: "user", content: "question" }],
      requestParameters: { model: "claude-test", stream: true },
      target: {
        id: "target-1",
        url: "https://upstream.example/v1/messages",
        model: "claude-test",
        authSource: "agent",
      },
    },
    revision: 0,
    expiresAt: new Date(initialNow.getTime() + 60_000).toISOString(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("durable Native Tool observation outbox", () => {
  it("extracts the visible final text without depending on transport chunking", () => {
    const bytes = new TextEncoder().encode([
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"final "}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"answer"}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n"));

    expect(extractAnthropicLogicalResponse(bytes)).toEqual({
      outputText: "final answer",
      toolUseCount: 0,
    });
  });

  it("extracts legal multi-line SSE data fields with CR-only frame separators", () => {
    const bytes = new TextEncoder().encode([
      "event: content_block_delta",
      'data: {"type":"content_block_delta",',
      'data: "index":0,"delta":{"type":"text_delta","text":"final answer"}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\r"));

    expect(extractAnthropicLogicalResponse(bytes)).toEqual({
      outputText: "final answer",
      toolUseCount: 0,
    });
  });

  it("uses a stable idempotency key and reclaims only after lease expiry", async () => {
    let currentTime = initialNow.getTime();
    const now = () => new Date(currentTime);
    const storage = new InMemoryToolExecutionStorageAdapter({ now });
    const state = pendingObservation();
    await storage.create(state);

    const first = await claimToolObservation({
      storage,
      key: state.key,
      leaseMs: 10_000,
      now,
      createId: () => "first",
    });
    await expect(claimToolObservation({
      storage,
      key: state.key,
      leaseMs: 10_000,
      now,
      createId: () => "second",
    })).rejects.toBeInstanceOf(ToolObservationOutboxError);

    currentTime += 10_001;
    const reclaimed = await claimToolObservation({
      storage,
      key: state.key,
      leaseMs: 10_000,
      now,
      createId: () => "second",
    });
    expect(reclaimed.idempotencyKey).toBe(first.idempotencyKey);
    expect(reclaimed.leaseOwner).not.toBe(first.leaseOwner);

    await completeToolObservation(storage, state.key, reclaimed.leaseOwner);
    await expect(storage.get(state.key)).resolves.toMatchObject({
      observationStatus: "completed",
      observationAttempt: 2,
    });
  });
});
