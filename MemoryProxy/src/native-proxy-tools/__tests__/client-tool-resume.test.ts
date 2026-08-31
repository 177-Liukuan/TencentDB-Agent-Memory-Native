import { describe, expect, it, vi } from "vitest";

import {
  createInMemoryToolExecutionBackend,
  InMemoryToolExecutionStorageAdapter,
} from "../../db/in-memory-tool-execution-storage-adapter.js";
import type { UnifiedToolCall } from "../../injection/adapters/interface.js";
import {
  extractAnthropicClientToolResults,
  resumeClientToolResults,
  type ClientToolResumeInput,
} from "../client-tool-resume.js";
import type {
  JsonValue,
  NativeToolResult,
  ToolCallSlot,
  ToolExecutionContext,
  ToolExecutionScope,
} from "../types.js";
import type { NativeReentryRequest, UpstreamRound } from "../tool-loop-coordinator.js";

const fixedNow = new Date("2026-08-31T03:00:00.000Z");
const encoder = new TextEncoder();

function scope(overrides: Partial<ToolExecutionScope> = {}): ToolExecutionScope {
  return {
    spaceId: "space-1",
    userId: "user-1",
    agentSource: "claude-code",
    sessionId: "session-1",
    contextVersion: "v1",
    ...overrides,
  };
}

function slot(
  callId: string,
  slotIndex: number,
  owner: "proxy" | "client",
  status: ToolCallSlot["status"],
  overrides: Partial<ToolCallSlot> = {},
): ToolCallSlot {
  const toolName = owner === "proxy" ? "tdai_memory_search" : "client_shell";
  return {
    callId,
    slotIndex,
    contentBlockIndex: slotIndex,
    toolName,
    owner,
    input: owner === "proxy" ? { query: callId } : { command: callId },
    argumentsComplete: true,
    status,
    executionAttempt: owner === "proxy" ? 1 : 0,
    ...overrides,
  };
}

function mixedState(overrides: {
  keyScope?: ToolExecutionScope;
  expiresAt?: string;
  p1?: Partial<ToolCallSlot>;
  c1?: Partial<ToolCallSlot>;
  c2?: Partial<ToolCallSlot>;
  p2?: Partial<ToolCallSlot>;
  skeleton?: JsonValue[];
  dispatchStatus?: ToolExecutionContext["clientDispatchStatus"];
} = {}): ToolExecutionContext {
  const slots = [
    slot("p1", 0, "proxy", "running", {
      executionLeaseOwner: "worker-original",
      executionLeaseUntil: new Date(fixedNow.getTime() + 30_000).toISOString(),
      ...overrides.p1,
    }),
    slot("c1", 1, "client", "pending", overrides.c1),
    slot("c2", 2, "client", "pending", overrides.c2),
    slot("p2", 3, "proxy", "succeeded", {
      result: { memories: ["p2-result"] },
      isError: false,
      ...overrides.p2,
    }),
  ];
  const skeleton = overrides.skeleton ?? slots.map((entry) => ({
    type: "tool_use",
    id: entry.callId,
    name: entry.toolName,
    input: entry.input ?? {},
  }));
  return {
    key: { ...(overrides.keyScope ?? scope()), toolBatchId: "batch-mixed" },
    turnSeq: 7,
    protocol: "anthropic",
    round: 1,
    totalCalls: 2,
    assistantSkeleton: skeleton,
    slots,
    responseStreamStatus: "completed",
    clientDispatchStatus: overrides.dispatchStatus ?? "dispatched",
    upstreamSnapshot: {
      protocol: "anthropic",
      baseMessages: [{ role: "user", content: "original question" }],
      system: [{ type: "text", text: "injected system" }],
      tools: [{ name: "tdai_memory_search", input_schema: { type: "object" } }],
      requestParameters: { model: "claude-test", stream: true, max_tokens: 1_024 },
      target: {
        id: "target-1",
        url: "https://upstream.example/v1/messages",
        model: "claude-test",
        authSource: "agent",
      },
    },
    revision: 0,
    expiresAt: overrides.expiresAt
      ?? new Date(fixedNow.getTime() + 5 * 60_000).toISOString(),
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
  };
}

function resultBody(
  results: Array<{ callId: string; content: JsonValue; isError?: boolean }> = [
    { callId: "c2", content: [{ type: "text", text: "second output" }] },
    { callId: "c1", content: "first output" },
  ],
): Record<string, unknown> {
  return {
    model: "claude-test",
    stream: true,
    messages: [
      { role: "user", content: "original question" },
      {
        role: "assistant",
        content: results.map((result) => ({
          type: "tool_use",
          id: result.callId,
          name: "client_shell",
          input: {},
        })),
      },
      {
        role: "user",
        content: results.map((result) => ({
          type: "tool_result",
          tool_use_id: result.callId,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        })),
      },
    ],
  };
}

function successfulRound(): UpstreamRound {
  return {
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"));
        controller.close();
      },
    }),
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
  };
}

function resumeHarness(options: {
  storage?: InMemoryToolExecutionStorageAdapter;
  execute?: (call: UnifiedToolCall, context: ToolExecutionScope) => Promise<NativeToolResult>;
  reenter?: (request: NativeReentryRequest) => Promise<UpstreamRound>;
  now?: () => Date;
} = {}) {
  const storage = options.storage ?? new InMemoryToolExecutionStorageAdapter({ now: () => fixedNow });
  const execute = vi.fn(options.execute ?? (async () => ({
    isError: false,
    value: { memories: ["recovered"] },
  })));
  const reenter = vi.fn(options.reenter ?? (async () => successfulRound()));
  let sequence = 0;
  const input = (body = resultBody(), inputScope = scope()): ClientToolResumeInput => ({
    body,
    scope: inputScope,
    storage,
    dispatcher: { execute },
    limits: {
      enabled: true,
      maxRounds: 5,
      maxCallsPerRound: 8,
      maxTotalCalls: 20,
      toolTimeoutMs: 500,
      maxResultBytes: 65_536,
      stateTtlSeconds: 1_800,
      stateStorage: { backend: "clickhouse", table: "native_proxy_tool_execution_state" },
    },
    reenter,
    now: options.now ?? (() => fixedNow),
    createId: () => `resume-${++sequence}`,
    pollIntervalMs: 5,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  return { storage, execute, reenter, input };
}

async function eventually(
  assertion: () => void | Promise<void>,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

describe("extractAnthropicClientToolResults", () => {
  it("preserves string and structured text-block result content", () => {
    expect(extractAnthropicClientToolResults(resultBody())).toEqual([
      {
        callId: "c2",
        content: [{ type: "text", text: "second output" }],
        isError: false,
      },
      { callId: "c1", content: "first output", isError: false },
    ]);
  });

  it("rejects duplicate call IDs in one Client request", () => {
    expect(() => extractAnthropicClientToolResults(resultBody([
      { callId: "c1", content: "first" },
      { callId: "c1", content: "duplicate" },
    ]))).toThrow(/duplicate/i);
  });
});

describe("resumeClientToolResults", () => {
  it("waits when Client results arrive before the running Native result", async () => {
    const harness = resumeHarness();
    const state = mixedState();
    await harness.storage.create(state);

    const resume = resumeClientToolResults(harness.input());
    await eventually(async () => {
      const current = await harness.storage.get(state.key);
      expect(current?.slots.find((entry) => entry.callId === "c1")?.status).toBe("succeeded");
      expect(current?.slots.find((entry) => entry.callId === "c2")?.status).toBe("succeeded");
    });
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.reenter).not.toHaveBeenCalled();

    const current = (await harness.storage.get(state.key))!;
    expect(await harness.storage.compareAndSetSlotResult({
      key: state.key,
      callId: "p1",
      expectedRevision: current.revision,
      leaseOwner: "worker-original",
      result: { memories: ["p1-result"] },
      isError: false,
    })).toBe(true);

    const decision = await resume;
    expect(decision).toMatchObject({ kind: "reentered", round: 2, totalCalls: 2 });
    expect(harness.reenter).toHaveBeenCalledTimes(1);
    expect(harness.reenter.mock.calls[0][0].messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "p1", content: "{\"memories\":[\"p1-result\"]}" },
        { type: "tool_result", tool_use_id: "c1", content: "\"first output\"" },
        { type: "tool_result", tool_use_id: "c2", content: "[{\"type\":\"text\",\"text\":\"second output\"}]" },
        { type: "tool_result", tool_use_id: "p2", content: "{\"memories\":[\"p2-result\"]}" },
      ],
    });
  });

  it("reclaims an expired read-only lease from a second Adapter instance", async () => {
    const backend = createInMemoryToolExecutionBackend();
    const primary = new InMemoryToolExecutionStorageAdapter({ backend, now: () => fixedNow });
    const restarted = new InMemoryToolExecutionStorageAdapter({ backend, now: () => fixedNow });
    const state = mixedState({
      p1: {
        executionLeaseOwner: "dead-worker",
        executionLeaseUntil: new Date(fixedNow.getTime() - 1).toISOString(),
      },
    });
    await primary.create(state);
    const harness = resumeHarness({ storage: restarted });

    const decision = await resumeClientToolResults(harness.input());

    expect(decision.kind).toBe("reentered");
    expect(harness.execute).toHaveBeenCalledTimes(1);
    const recovered = await restarted.get(state.key);
    expect(recovered?.slots[0]).toMatchObject({
      status: "succeeded",
      executionAttempt: 2,
      result: { memories: ["recovered"] },
    });
  });

  it("persists Client execution errors and marks the rebuilt Tool Result", async () => {
    const harness = resumeHarness();
    const state = mixedState({ p1: { status: "succeeded", result: "p1", isError: false } });
    await harness.storage.create(state);
    const body = resultBody([
      { callId: "c1", content: "permission denied", isError: true },
      { callId: "c2", content: "second" },
    ]);

    const decision = await resumeClientToolResults(harness.input(body));

    expect(decision.kind).toBe("reentered");
    const stored = await harness.storage.get(state.key);
    expect(stored?.slots.find((entry) => entry.callId === "c1")).toMatchObject({
      status: "failed",
      isError: true,
      result: "permission denied",
    });
    expect(harness.reenter.mock.calls[0][0].messages.at(-1)).toEqual(expect.objectContaining({
      content: expect.arrayContaining([
        {
          type: "tool_result",
          tool_use_id: "c1",
          content: "\"permission denied\"",
          is_error: true,
        },
      ]),
    }));
  });

  it.each([
    ["duplicate", mixedState({ c1: { status: "succeeded", result: "old", isError: false } }), resultBody(), "duplicate_client_tool_result"],
    ["unknown", mixedState(), resultBody([
      { callId: "c1", content: "first" },
      { callId: "unknown", content: "unknown" },
    ]), "unknown_client_tool_call"],
    ["corrupt skeleton", mixedState({
      p1: { status: "succeeded", result: "p1", isError: false },
      skeleton: [{ type: "text", text: "missing tool blocks" }],
    }), resultBody(), "corrupt_assistant_skeleton"],
  ])("rejects %s state without re-entry", async (_name, state, body, code) => {
    const harness = resumeHarness();
    await harness.storage.create(state);

    const decision = await resumeClientToolResults(harness.input(body));

    expect(decision).toMatchObject({ kind: "error", code });
    expect(harness.reenter).not.toHaveBeenCalled();
    if (code === "duplicate_client_tool_result" || code === "corrupt_assistant_skeleton") {
      const stored = await harness.storage.get(state.key);
      expect(stored?.slots.find((entry) => entry.callId === "c2")?.status).toBe("pending");
    }
  });

  it("distinguishes expired known batches from unrelated Client Tool loops", async () => {
    const expiredHarness = resumeHarness();
    const expired = mixedState({
      expiresAt: new Date(fixedNow.getTime() - 1).toISOString(),
    });
    await expiredHarness.storage.create(expired);
    const unrelatedHarness = resumeHarness();

    const expiredDecision = await resumeClientToolResults(expiredHarness.input());
    const unrelatedDecision = await resumeClientToolResults(unrelatedHarness.input(resultBody([
      { callId: "ordinary-client-call", content: "ordinary" },
    ])));

    expect(expiredDecision).toMatchObject({ kind: "error", code: "expired_tool_batch" });
    expect(unrelatedDecision).toEqual({ kind: "not_applicable" });
  });

  it("accepts Client results exactly once under concurrent resumes", async () => {
    const state = mixedState({
      p1: { status: "succeeded", result: "p1", isError: false },
    });
    const harness = resumeHarness();
    await harness.storage.create(state);

    const decisions = await Promise.all([
      resumeClientToolResults(harness.input()),
      resumeClientToolResults(harness.input()),
    ]);

    expect(decisions.filter((decision) => decision.kind === "reentered")).toHaveLength(1);
    expect(decisions.filter((decision) => decision.kind === "error")).toHaveLength(1);
    expect(harness.reenter).toHaveBeenCalledTimes(1);
  });

  it("fails closed for an unknown or cross-scope call inside a known batch", async () => {
    const harness = resumeHarness();
    await harness.storage.create(mixedState());
    const body = resultBody([
      { callId: "c1", content: "known" },
      { callId: "foreign-call", content: "foreign" },
    ]);

    const decision = await resumeClientToolResults(harness.input(body));

    expect(decision).toMatchObject({ kind: "error", code: "unknown_client_tool_call" });
    expect(harness.reenter).not.toHaveBeenCalled();
  });
});
