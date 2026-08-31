import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import { InMemoryToolExecutionStorageAdapter } from "../../db/in-memory-tool-execution-storage-adapter.js";
import type { UnifiedToolCall } from "../../injection/adapters/interface.js";
import {
  ToolLoopExecutionCore,
  persistToolLoopResponse,
} from "../tool-loop-execution-core.js";
import type {
  ToolExecutionScope,
  UpstreamRequestSnapshot,
} from "../types.js";

const fixedNow = new Date("2026-08-31T10:00:00.000Z");
const scope: ToolExecutionScope = {
  spaceId: "space-1",
  userId: "user-1",
  agentSource: "contract-test",
  sessionId: "session-1",
  contextVersion: "v1",
};
const upstreamSnapshot: UpstreamRequestSnapshot = {
  protocol: "anthropic",
  baseMessages: [{ role: "user", content: "find rules" }],
  tools: [],
  requestParameters: { model: "test-model", stream: true },
  target: {
    id: "target-1",
    url: "https://upstream.example/v1/messages",
    model: "test-model",
    authSource: "agent",
  },
};

function call(
  callId: string,
  owner: "proxy" | "client" = "proxy",
  slotIndex = 0,
): UnifiedToolCall {
  return {
    callId,
    toolName: owner === "proxy" ? "tdai_memory_search" : "client_shell",
    owner,
    slotIndex,
    contentBlockIndex: slotIndex + 2,
    argumentsComplete: true,
    input: owner === "proxy" ? { query: callId } : { command: "pwd" },
  };
}

function harness(execute = vi.fn(async () => ({
  isError: false,
  value: { memories: ["shared result"] },
}))) {
  const storage = new InMemoryToolExecutionStorageAdapter({ now: () => fixedNow });
  let id = 0;
  const core = new ToolLoopExecutionCore({
    storage,
    dispatcher: { execute },
    limits: structuredClone(DEFAULT_CONFIG.nativeProxyTools),
    now: () => fixedNow,
    createId: () => `core-${++id}`,
  });
  return { core, storage, execute };
}

async function createStreamingBatch(
  core: ToolLoopExecutionCore,
  calls: UnifiedToolCall[] = [call("call-1")],
) {
  return core.createBatch({
    protocol: "anthropic",
    scope,
    turnSeq: 7,
    upstreamSnapshot,
    round: 2,
    totalCalls: 3,
    calls,
    assistantSkeleton: [{ type: "tool_use", id: calls[0]?.callId ?? "none" }],
    responseStreamStatus: "streaming",
  });
}

describe("ToolLoopExecutionCore", () => {
  it("applies one protocol-neutral call-limit policy", () => {
    const { core } = harness();

    expect(core.limitFailure({ round: 1, totalCalls: 1, callsThisRound: 1 })).toBeNull();
    expect(core.limitFailure({
      round: DEFAULT_CONFIG.nativeProxyTools.maxRounds + 1,
      totalCalls: 0,
      callsThisRound: 1,
    })).toMatchObject({ code: "native_tool_limit_exceeded", status: 400 });
    expect(core.limitFailure({
      round: 1,
      totalCalls: 0,
      callsThisRound: DEFAULT_CONFIG.nativeProxyTools.maxCallsPerRound + 1,
    })).toMatchObject({ code: "native_tool_limit_exceeded", status: 400 });
    expect(core.limitFailure({
      round: 1,
      totalCalls: DEFAULT_CONFIG.nativeProxyTools.maxTotalCalls,
      callsThisRound: 1,
    })).toMatchObject({ code: "native_tool_limit_exceeded", status: 400 });
  });

  it("creates the same durable slot state for every protocol", async () => {
    const { core, storage } = harness();
    const calls = [call("native-1"), call("client-1", "client", 1)];

    const key = await core.createBatch({
      protocol: "responses",
      scope,
      turnSeq: 7,
      upstreamSnapshot: { ...upstreamSnapshot, protocol: "responses" },
      round: 2,
      totalCalls: 3,
      calls,
      assistantSkeleton: [{ type: "function_call", call_id: "native-1" }],
      responseStreamStatus: "streaming",
      parentStateKey: { ...scope, toolBatchId: "parent-1" },
      parentReentryAttempt: 4,
    });

    expect(await storage.get(key)).toMatchObject({
      protocol: "responses",
      turnSeq: 7,
      round: 2,
      totalCalls: 4,
      responseStreamStatus: "streaming",
      clientDispatchStatus: "none",
      parentReentryAttempt: 4,
      expiresAt: "2026-08-31T10:30:00.000Z",
      slots: [
        {
          callId: "native-1",
          owner: "proxy",
          slotIndex: 0,
          contentBlockIndex: 2,
          status: "pending",
          executionAttempt: 0,
        },
        {
          callId: "client-1",
          owner: "client",
          slotIndex: 1,
          contentBlockIndex: 3,
          status: "pending",
          executionAttempt: 0,
        },
      ],
    });
  });

  it("preserves a completed Native result while a later stream snapshot adds slots", async () => {
    const { core, storage } = harness();
    const first = call("native-1");
    const second = call("client-1", "client", 1);
    const key = await createStreamingBatch(core, [first]);

    await core.executeAndPersist(first, scope, key);
    await core.persistStreamSnapshot({
      key,
      assistantSkeleton: [
        { type: "tool_use", id: "native-1" },
        { type: "tool_use", id: "client-1" },
      ],
      calls: [first, second],
      responseStreamStatus: "completed",
      totalCalls: 4,
    });

    const state = await storage.get(key);
    expect(state?.slots).toEqual([
      expect.objectContaining({
        callId: "native-1",
        status: "succeeded",
        result: { memories: ["shared result"] },
      }),
      expect.objectContaining({ callId: "client-1", status: "pending" }),
    ]);
    expect(state?.responseStreamStatus).toBe("completed");
  });

  it("claims one execution lease when duplicate workers race", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await gate;
      return { isError: false, value: { memories: ["once"] } };
    });
    const { core, storage } = harness(execute);
    const nativeCall = call("native-1");
    const key = await createStreamingBatch(core, [nativeCall]);

    const workers = [
      core.executeAndPersist(nativeCall, scope, key),
      core.executeAndPersist(nativeCall, scope, key),
    ];
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    release();
    await Promise.all(workers);

    expect(await storage.get(key)).toMatchObject({
      slots: [{
        callId: "native-1",
        status: "succeeded",
        executionAttempt: 1,
        result: { memories: ["once"] },
      }],
    });
  });

  it("persists a bounded generic error when the dispatcher throws", async () => {
    const { core, storage } = harness(vi.fn(async () => {
      throw new Error("secret bridge details");
    }));
    const nativeCall = call("native-1");
    const key = await createStreamingBatch(core, [nativeCall]);

    await core.executeAndPersist(nativeCall, scope, key);

    expect(await storage.get(key)).toMatchObject({
      slots: [{
        status: "failed",
        isError: true,
        result: {
          code: "native_tool_execution_failed",
          message: "Native Proxy Tool execution failed",
          retryable: true,
        },
      }],
    });
  });

  it("coordinates Client dispatch, observation idempotency, and stream aborts", async () => {
    const { core, storage } = harness();
    const key = await createStreamingBatch(core);
    const outcome = persistToolLoopResponse(
      new TextEncoder().encode("visible"),
      200,
      new Headers({
        "content-type": "text/event-stream",
        "x-request-id": "request-1",
        "set-cookie": "must-not-persist",
      }),
    );

    expect(outcome.headers).toEqual({
      "content-type": "text/event-stream",
      "x-request-id": "request-1",
    });
    expect(await core.transitionClientDispatch(key, "none", "pending", outcome)).toBe(true);
    expect(await core.transitionClientDispatch(key, "none", "pending", outcome)).toBe(false);
    expect(await core.transitionClientDispatch(key, "pending", "dispatched")).toBe(true);

    const abortKey = await createStreamingBatch(core, [call("native-2")]);
    await core.markAborted(abortKey);
    expect((await storage.get(abortKey))?.responseStreamStatus).toBe("aborted");

    const observationKey = await createStreamingBatch(core, [call("native-3")]);
    await core.persistStreamSnapshot({
      key: observationKey,
      assistantSkeleton: [{ type: "tool_use", id: "native-3" }],
      calls: [call("native-3")],
      responseStreamStatus: "completed",
      totalCalls: 4,
    });
    expect(await core.prepareObservation(observationKey, outcome)).toBe(true);
    expect(await core.prepareObservation(observationKey, outcome)).toBe(true);
    expect(await core.prepareObservation(observationKey, {
      ...outcome,
      bodyBase64: "different",
    })).toBe(false);
  });
});
