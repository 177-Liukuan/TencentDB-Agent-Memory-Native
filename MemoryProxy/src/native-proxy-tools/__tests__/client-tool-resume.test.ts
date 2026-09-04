import { describe, expect, it, vi } from "vitest";

import {
  createInMemoryToolExecutionBackend,
  InMemoryToolExecutionStorageAdapter,
} from "../../db/in-memory-tool-execution-storage-adapter.js";
import { InMemoryNativeToolLedgerStorageAdapter } from "../../db/in-memory-native-tool-ledger-storage-adapter.js";
import type { NativeToolLedgerStorageAdapter } from "../../db/native-tool-ledger-storage-adapter.js";
import type { UnifiedToolCall } from "../../injection/adapters/interface.js";
import {
  completeClientToolReentry,
  createPersistedClientReentryOutcome,
  extractClientToolResults,
  extractAnthropicClientToolResults,
  resumeClientToolResults,
  type ClientToolResumeInput,
} from "../client-tool-resume.js";
import { NativeToolTargetUnavailableError } from "../exact-target-transport.js";
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
    contextVersion: "epoch:0",
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
  ledgerStorage?: NativeToolLedgerStorageAdapter;
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
    ledgerStorage: options.ledgerStorage ?? new InMemoryNativeToolLedgerStorageAdapter(),
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
      ledgerStorage: {
        backend: "clickhouse",
        table: "native_proxy_tool_ledger",
        eventTable: "native_proxy_tool_context_event",
      },
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
  it("extracts a contiguous OpenAI Tool Result suffix", () => {
    expect(extractClientToolResults({
      messages: [
        { role: "user", content: "question" },
        { role: "assistant", content: null, tool_calls: [] },
        { role: "tool", tool_call_id: "c1", content: "first" },
        { role: "tool", tool_call_id: "c2", content: { output: "second" } },
      ],
    })).toEqual([
      { callId: "c1", content: "first", isError: false },
      { callId: "c2", content: { output: "second" }, isError: false },
    ]);
  });

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

  it("reads Tool Results immediately before trailing Claude Code system messages", () => {
    const body = resultBody();
    (body.messages as unknown[]).push({
      role: "system",
      content: "A queued user message is available.",
    });

    expect(extractAnthropicClientToolResults(body)).toEqual([
      {
        callId: "c2",
        content: [{ type: "text", text: "second output" }],
        isError: false,
      },
      { callId: "c1", content: "first output", isError: false },
    ]);
  });

  it("does not scan past a newer ordinary conversation message", () => {
    const body = resultBody();
    (body.messages as unknown[]).push(
      { role: "system", content: "A queued user message is available." },
      { role: "user", content: "new question" },
    );

    expect(extractAnthropicClientToolResults(body)).toEqual([]);
  });

  it("rejects duplicate call IDs in one Client request", () => {
    expect(() => extractAnthropicClientToolResults(resultBody([
      { callId: "c1", content: "first" },
      { callId: "c1", content: "duplicate" },
    ]))).toThrow(/duplicate/i);
  });
});

describe("OpenAI Responses Client Tool Result extraction", () => {
  it("collects the trailing function_call_output batch and rejects duplicate call_id values", () => {
    expect(extractClientToolResults({ input: [
      { role: "user", content: "question" },
      { type: "function_call_output", call_id: "call_1", output: "first" },
      { type: "function_call_output", call_id: "call_2", output: { stdout: "second" } },
    ] })).toEqual([
      { callId: "call_1", content: "first", isError: false },
      { callId: "call_2", content: { stdout: "second" }, isError: false },
    ]);
    expect(() => extractClientToolResults({ input: [
      { type: "function_call_output", call_id: "call_1", output: "a" },
      { type: "function_call_output", call_id: "call_1", output: "b" },
    ] })).toThrow(/duplicate Tool Result/i);
  });
});

describe("resumeClientToolResults", () => {
  it("registers Tool Results before a trailing system control message and re-enters", async () => {
    const harness = resumeHarness();
    await harness.storage.create(mixedState({
      p1: { status: "succeeded", result: "p1-result", isError: false },
    }));
    const body = resultBody();
    (body.messages as unknown[]).push({
      role: "system",
      content: "A queued user message is available.",
    });

    const decision = await resumeClientToolResults(harness.input(body));

    expect(decision).toMatchObject({ kind: "reentered" });
    expect(harness.reenter).toHaveBeenCalledTimes(1);
    const stored = await harness.storage.get({ ...scope(), toolBatchId: "batch-mixed" });
    expect(stored?.slots.filter((entry) => entry.owner === "client"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ callId: "c1", status: "succeeded" }),
        expect.objectContaining({ callId: "c2", status: "succeeded" }),
      ]));
  });

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
        { type: "tool_result", tool_use_id: "c1", content: "first output" },
        { type: "tool_result", tool_use_id: "c2", content: [{ type: "text", text: "second output" }] },
        { type: "tool_result", tool_use_id: "p2", content: "{\"memories\":[\"p2-result\"]}" },
      ],
    });
  });

  it("does not re-enter a mixed call when its long-term history cannot be saved", async () => {
    const ledgerStorage = new InMemoryNativeToolLedgerStorageAdapter();
    vi.spyOn(ledgerStorage, "appendRound").mockRejectedValue(new Error("database unavailable"));
    const harness = resumeHarness({ ledgerStorage });
    const state = mixedState({
      p1: {
        status: "succeeded",
        result: { memories: ["p1-result"] },
        isError: false,
        executionLeaseOwner: undefined,
        executionLeaseUntil: undefined,
      },
    });
    await harness.storage.create(state);

    const decision = await resumeClientToolResults(harness.input());

    expect(decision).toMatchObject({ kind: "error", code: "native_tool_history_unavailable", status: 503 });
    expect(harness.reenter).not.toHaveBeenCalled();
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
          content: "permission denied",
          is_error: true,
        },
      ]),
    }));
  });

  it("reports an unavailable persisted target without selecting a substitute", async () => {
    const harness = resumeHarness({
      reenter: async () => {
        throw new NativeToolTargetUnavailableError();
      },
    });
    await harness.storage.create(mixedState({
      p1: { status: "succeeded", result: "p1", isError: false },
    }));

    const decision = await resumeClientToolResults(harness.input());

    expect(decision).toMatchObject({
      kind: "error",
      code: "native_tool_target_unavailable",
      status: 503,
    });
    expect(harness.reenter).toHaveBeenCalledTimes(1);
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

  it("accepts identical Client results idempotently and claims re-entry exactly once", async () => {
    const state = mixedState({
      p1: { status: "succeeded", result: "p1", isError: false },
    });
    const harness = resumeHarness();
    await harness.storage.create(state);

    const decisions = await Promise.all([
      resumeClientToolResults(harness.input()),
      resumeClientToolResults(harness.input(resultBody([
        { callId: "c1", content: "first output" },
        { callId: "c2", content: [{ type: "text", text: "second output" }] },
      ]))),
    ]);

    expect(decisions.filter((decision) => decision.kind === "reentered")).toHaveLength(1);
    expect(decisions.filter((decision) => decision.kind === "error")).toHaveLength(1);
    expect(harness.reenter).toHaveBeenCalledTimes(1);
  });

  it("retries identical persisted results after a failed re-entry lease expires", async () => {
    let currentTime = fixedNow.getTime();
    const now = () => new Date(currentTime);
    const storage = new InMemoryToolExecutionStorageAdapter({ now });
    const first = resumeHarness({
      storage,
      now,
      reenter: async () => { throw new Error("upstream reset"); },
    });
    const state = mixedState({
      p1: { status: "succeeded", result: "p1", isError: false },
    });
    await storage.create(state);

    await expect(resumeClientToolResults(first.input())).resolves.toMatchObject({
      kind: "error",
      code: "native_tool_reentry_failed",
    });
    await expect(storage.get(state.key)).resolves.toMatchObject({
      clientDispatchStatus: "resuming",
      reentryAttempt: 1,
    });

    await expect(resumeClientToolResults(first.input())).resolves.toMatchObject({
      kind: "error",
      code: "native_tool_reentry_in_progress",
    });

    currentTime += 10_001;
    const second = resumeHarness({ storage, now });
    const decision = await resumeClientToolResults(second.input());
    expect(decision).toMatchObject({ kind: "reentered", reentryLeaseOwner: expect.any(String) });
    if (decision.kind !== "reentered") throw new Error("expected re-entry");
    await completeClientToolReentry(
      storage,
      decision.stateKey,
      decision.reentryLeaseOwner,
      createPersistedClientReentryOutcome({
        kind: "final",
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: encoder.encode("final"),
      }),
    );
    await expect(storage.get(state.key)).resolves.toMatchObject({
      clientDispatchStatus: "completed",
      reentryAttempt: 2,
    });
  });

  it("replays an atomically persisted re-entry outcome after delivery is interrupted", async () => {
    const state = mixedState({
      p1: { status: "succeeded", result: "p1", isError: false },
    });
    const harness = resumeHarness();
    await harness.storage.create(state);

    const first = await resumeClientToolResults(harness.input());
    expect(first.kind).toBe("reentered");
    if (first.kind !== "reentered") throw new Error("expected re-entry");
    const outcome = createPersistedClientReentryOutcome({
      kind: "client_dispatch",
      status: 200,
      headers: new Headers({
        "content-type": "text/event-stream",
        "set-cookie": "must-not-persist=1",
      }),
      bytes: encoder.encode("event: message_stop\ndata: replay-me\n\n"),
      childStateKey: { ...scope(), toolBatchId: "child-batch" },
    });
    const childState = mixedState({
      dispatchStatus: "pending",
      p1: { status: "succeeded", result: "p1", isError: false },
      c1: { callId: "child-c1" },
      c2: { callId: "child-c2" },
    });
    childState.key = { ...scope(), toolBatchId: "child-batch" };
    childState.parentStateKey = state.key;
    childState.parentReentryAttempt = 1;
    childState.clientDispatchOutcome = {
      status: outcome.status,
      headers: structuredClone(outcome.headers),
      bodyBase64: outcome.bodyBase64,
    };
    await harness.storage.create(childState);
    await completeClientToolReentry(
      harness.storage,
      first.stateKey,
      first.reentryLeaseOwner,
      outcome,
    );

    const retry = await resumeClientToolResults(harness.input());

    expect(retry).toMatchObject({
      kind: "replay",
      status: 200,
      outcomeKind: "client_dispatch",
      childStateKey: { toolBatchId: "child-batch" },
    });
    if (retry.kind !== "replay") throw new Error("expected durable replay");
    expect(new TextDecoder().decode(retry.bytes)).toContain("replay-me");
    expect(retry.headers.get("content-type")).toBe("text/event-stream");
    expect(retry.headers.has("set-cookie")).toBe(false);
    expect(harness.reenter).toHaveBeenCalledTimes(1);
    await expect(harness.storage.get(childState.key)).resolves.toMatchObject({
      clientDispatchStatus: "dispatched",
    });
  });

  it("does not let a stale lease owner accept another owner's completed outcome", async () => {
    const state = mixedState({
      dispatchStatus: "resuming",
      p1: { status: "succeeded", result: "p1", isError: false },
    });
    state.reentryLeaseOwner = "winning-owner";
    state.reentryLeaseUntil = new Date(fixedNow.getTime() + 30_000).toISOString();
    const harness = resumeHarness();
    await harness.storage.create(state);
    const outcome = createPersistedClientReentryOutcome({
      kind: "final",
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      bytes: encoder.encode("winner"),
    });

    await completeClientToolReentry(
      harness.storage,
      state.key,
      "winning-owner",
      outcome,
    );
    await expect(completeClientToolReentry(
      harness.storage,
      state.key,
      "stale-owner",
      outcome,
    )).rejects.toThrow(/lease|dispatchable/i);
    await expect(completeClientToolReentry(
      harness.storage,
      state.key,
      "winning-owner",
      { ...outcome, bodyBase64: Buffer.from("different").toString("base64") },
    )).rejects.toThrow(/outcome|dispatchable/i);
    await expect(completeClientToolReentry(
      harness.storage,
      state.key,
      "winning-owner",
      outcome,
    )).resolves.toBeUndefined();
  });

  it("separates full hidden re-entry history from logical observation history", async () => {
    const state = mixedState({
      p1: { status: "succeeded", result: "p1", isError: false },
    });
    state.upstreamSnapshot.baseMessages = [
      { role: "user", content: "original question" },
      { role: "assistant", content: [{ type: "tool_use", id: "old-native" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "old-native", content: "hidden" }] },
    ];
    state.upstreamSnapshot.logicalBaseMessages = [{ role: "user", content: "original question" }];
    const harness = resumeHarness();
    await harness.storage.create(state);

    const decision = await resumeClientToolResults(harness.input());

    expect(decision).toMatchObject({
      kind: "reentered",
      logicalMessages: [{ role: "user", content: "original question" }],
      upstreamSnapshot: {
        baseMessages: expect.any(Array),
      },
    });
    if (decision.kind !== "reentered") throw new Error("expected re-entry");
    expect(decision.messages).toHaveLength(5);
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
