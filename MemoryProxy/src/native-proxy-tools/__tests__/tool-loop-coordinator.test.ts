import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import { InMemoryToolExecutionStorageAdapter } from "../../db/in-memory-tool-execution-storage-adapter.js";
import { InMemoryNativeToolLedgerStorageAdapter } from "../../db/in-memory-native-tool-ledger-storage-adapter.js";
import type { NativeToolLedgerStorageAdapter } from "../../db/native-tool-ledger-storage-adapter.js";
import type { UnifiedToolCall } from "../../injection/adapters/interface.js";
import type { NativeToolResult, ToolExecutionScope, UpstreamRequestSnapshot } from "../types.js";
import {
  AnthropicToolLoopCoordinator,
  type NativeReentryRequest,
  type ToolLoopRoundInput,
  type UpstreamRound,
} from "../tool-loop-coordinator.js";
import { createDefaultNativeProxyToolRegistry } from "../tool-registry.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fixedNow = new Date("2026-08-31T02:00:00.000Z");

function frame(event: string, payload: Record<string, unknown>): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function messageStart(): Uint8Array {
  return frame("message_start", {
    type: "message_start",
    message: {
      id: "msg-1",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 5, output_tokens: 0 },
    },
  });
}

function toolFrames(index: number, id: string, name: string, input: Record<string, unknown>): Uint8Array {
  return concat(
    frame("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {} },
    }),
    frame("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    }),
    frame("content_block_stop", { type: "content_block_stop", index }),
  );
}

function messageStop(reason = "tool_use"): Uint8Array {
  return concat(
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: reason },
      usage: { output_tokens: 3 },
    }),
    frame("message_stop", { type: "message_stop" }),
  );
}

function nativeFixture(callCount = 1): Uint8Array {
  const tools = Array.from({ length: callCount }, (_, index) => toolFrames(
    index,
    `proxy-${index + 1}`,
    "tdai_memory_search",
    { query: `rules-${index + 1}` },
  ));
  return concat(messageStart(), ...tools, messageStop());
}

function clientFixture(): Uint8Array {
  return concat(
    messageStart(),
    toolFrames(0, "client-1", "client_shell", { command: "pwd" }),
    messageStop(),
  );
}

function mixedFixture(): Uint8Array {
  return concat(
    messageStart(),
    toolFrames(0, "p1", "tdai_memory_search", { query: "first" }),
    toolFrames(1, "c1", "client_shell", { command: "first" }),
    toolFrames(2, "c2", "client_shell", { command: "second" }),
    toolFrames(3, "p2", "tdai_memory_search", { query: "second" }),
    messageStop(),
  );
}

function visibleToolStarts(bytes: Uint8Array): Array<{ index: number; id: string }> {
  return decoder.decode(bytes)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    .filter((payload) => (
      payload.type === "content_block_start"
      && (payload.content_block as Record<string, unknown> | undefined)?.type === "tool_use"
    ))
    .map((payload) => ({
      index: payload.index as number,
      id: (payload.content_block as Record<string, unknown>).id as string,
    }));
}

function finalFixture(text = "final answer"): Uint8Array {
  return concat(
    messageStart(),
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    messageStop("end_turn"),
  );
}

function byteStream(bytes: Uint8Array) {
  let readerCount = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const originalGetReader = stream.getReader.bind(stream);
  stream.getReader = ((...args: Parameters<typeof stream.getReader>) => {
    readerCount++;
    if (readerCount > 1) throw new Error("stream acquired more than once");
    return originalGetReader(...args);
  }) as typeof stream.getReader;
  return { stream, readerCount: () => readerCount };
}

function controlledNativeStream(
  toolName = "tdai_memory_search",
  input: Record<string, unknown> = { query: "rules" },
) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let stopReleased = false;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  return {
    stream,
    releaseThroughBlockStop() {
      controller.enqueue(concat(
        messageStart(),
        toolFrames(0, "proxy-1", toolName, input),
      ));
    },
    releaseMessageStop() {
      stopReleased = true;
      controller.enqueue(messageStop());
      controller.close();
    },
    closeBeforeMessageStop() {
      controller.close();
    },
    failBeforeMessageStop() {
      controller.error(new Error("socket reset with secret transport detail"));
    },
    messageStopReleased: () => stopReleased,
  };
}

function scope(): ToolExecutionScope {
  return {
    spaceId: "space-1",
    userId: "user-1",
    agentSource: "claude-code",
    sessionId: "session-1",
    contextVersion: "epoch:0",
  };
}

function snapshot(): UpstreamRequestSnapshot {
  return {
    protocol: "anthropic",
    baseMessages: [{ role: "user", content: "remembered rules?" }],
    system: [{ type: "text", text: "injected system" }],
    tools: [{ name: "tdai_memory_search", input_schema: { type: "object" } }],
    requestParameters: { model: "claude-test", stream: true, max_tokens: 1_024 },
    target: {
      id: "agent:claude-code",
      url: "https://upstream.example/v1/messages",
      model: "claude-test",
      authSource: "agent",
    },
  };
}

function roundInput(stream: ReadableStream<Uint8Array>, overrides: Partial<ToolLoopRoundInput> = {}): ToolLoopRoundInput {
  return {
    stream,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream", "x-request-id": "upstream-1" }),
    scope: scope(),
    turnSeq: 9,
    upstreamSnapshot: snapshot(),
    round: 1,
    totalCalls: 0,
    ...overrides,
  };
}

function coordinatorHarness(options: {
  signal?: AbortSignal;
  execute?: (call: UnifiedToolCall, context: ToolExecutionScope, signal?: AbortSignal) => Promise<NativeToolResult>;
  reenter?: (request: NativeReentryRequest) => Promise<UpstreamRound>;
  configure?: (config: typeof DEFAULT_CONFIG) => void;
  beforeReenter?: () => Promise<void>;
  beforeClientDispatch?: () => Promise<void>;
  ledgerStorage?: NativeToolLedgerStorageAdapter;
  onClientDispatchPrepared?: (dispatch: {
    stateKey: import("../types.js").ToolExecutionStateKey;
    bytes: Uint8Array;
    status: number;
    headers: Headers;
  }) => Promise<void>;
} = {}) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.nativeProxyTools.enabled = true;
  options.configure?.(config);
  const storage = new InMemoryToolExecutionStorageAdapter({ now: () => fixedNow });
  const ledgerStorage = options.ledgerStorage ?? new InMemoryNativeToolLedgerStorageAdapter();
  const execute = vi.fn<NonNullable<typeof options.execute>>(options.execute ?? (async (call: UnifiedToolCall) => ({
    isError: false,
    value: { memories: [`result:${call.callId}`] },
  })));
  const reenter = vi.fn(options.reenter ?? (async () => ({
    stream: byteStream(finalFixture()).stream,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream", "x-request-id": "upstream-2" }),
  })));
  let sequence = 0;
  const coordinator = new AnthropicToolLoopCoordinator({
    signal: options.signal,
    registry: createDefaultNativeProxyToolRegistry(),
    storage,
    ledgerStorage,
    dispatcher: { execute },
    limits: config.nativeProxyTools,
    reenter,
    beforeReenter: options.beforeReenter,
    beforeClientDispatch: options.beforeClientDispatch,
    onClientDispatchPrepared: options.onClientDispatchPrepared,
    now: () => fixedNow,
    createId: () => `id-${++sequence}`,
  });
  return { coordinator, storage, ledgerStorage, execute, reenter, config };
}

async function eventually(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

describe("AnthropicToolLoopCoordinator", () => {
  it("completes beyond the old round and call budgets and preserves counters", async () => {
    const harness = coordinatorHarness({ reenter: async (request) => ({
      stream: byteStream(request.round <= 7 ? nativeFixture(9) : finalFixture()).stream,
      status: 200,
      headers: new Headers(),
    }) });
    const decision = await harness.coordinator.handleRound(roundInput(byteStream(nativeFixture(9)).stream));
    expect(decision.kind).toBe("final");
    expect(harness.execute).toHaveBeenCalledTimes(63);
    expect(harness.reenter.mock.calls.at(-1)?.[0]).toMatchObject({ round: 8, totalCalls: 63 });
  });

  it("cancels an idle upstream reader without starting tools or re-entry", async () => {
    const abort = new AbortController();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const harness = coordinatorHarness({ signal: abort.signal });
    const running = harness.coordinator.handleRound(roundInput(stream));
    abort.abort();
    const decision = await running;
    expect(decision).toMatchObject({ kind: "error", code: "native_tool_cancelled", status: 499 });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.reenter).not.toHaveBeenCalled();
  }, 1_000);

  it("keeps a completed tool result but does not re-enter after cancellation", async () => {
    const abort = new AbortController();
    const harness = coordinatorHarness({
      signal: abort.signal,
      beforeReenter: async () => { abort.abort(); },
    });
    const decision = await harness.coordinator.handleRound(roundInput(byteStream(nativeFixture()).stream));
    expect(decision).toMatchObject({ kind: "error", code: "native_tool_cancelled" });
    expect(harness.reenter).not.toHaveBeenCalled();
    expect((await harness.storage.get({ ...scope(), toolBatchId: "id-1" }))?.slots[0]).toMatchObject({
      status: "succeeded", result: { memories: ["result:proxy-1"] },
    });
  });

  it("persists a Client-only round immediately after resuming Client results", async () => {
    const parentStateKey = { ...scope(), toolBatchId: "parent" };
    const onClientDispatchPrepared = vi.fn(async () => {});
    const { coordinator, storage, ledgerStorage, execute, reenter } = coordinatorHarness({ onClientDispatchPrepared });

    const decision = await coordinator.handleRound(roundInput(byteStream(clientFixture()).stream, {
      parentStateKey, parentReentryAttempt: 1, round: 3, totalCalls: 1,
    }));

    expect(decision.kind).toBe("client_dispatch");
    if (decision.kind !== "client_dispatch") throw new Error("expected Client dispatch");
    expect(await storage.get(decision.stateKey)).toMatchObject({
      parentStateKey, parentReentryAttempt: 1, round: 3, totalCalls: 1,
      clientDispatchStatus: "dispatched", slots: [{ callId: "client-1", owner: "client" }],
    });
    expect(onClientDispatchPrepared).toHaveBeenCalledTimes(1);
    expect(visibleToolStarts(decision.bytes)).toEqual([{ index: 0, id: "client-1" }]);
    expect(await ledgerStorage.findRounds(scope(), 0)).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(reenter).not.toHaveBeenCalled();
  });

  it.each([
    ["no-tool", concat(messageStart(), messageStop("end_turn"))],
    ["Client-only", clientFixture()],
  ])("consumes and replays a %s response once without persistent state", async (_name, fixture) => {
    const source = byteStream(fixture);
    const { coordinator, storage, execute, reenter } = coordinatorHarness();

    const decision = await coordinator.handleRound(roundInput(source.stream));

    expect(decision.kind).toBe("replay");
    if (decision.kind === "replay") expect(decision.bytes).toEqual(fixture);
    expect(source.readerCount()).toBe(1);
    expect(await storage.findActiveBySession(scope())).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(reenter).not.toHaveBeenCalled();
  });

  it("allows ordinary response text to mention a Native tool name", async () => {
    const { coordinator } = coordinatorHarness();

    const decision = await coordinator.handleRound(roundInput(byteStream(
      finalFixture("available tool: tdai_memory_search"),
    ).stream));

    expect(decision).toMatchObject({ kind: "replay", status: 200 });
    expect(decoder.decode(decision.bytes)).toContain("tdai_memory_search");
  });

  it("starts Native execution after block stop and before message_stop", async () => {
    const gates = controlledNativeStream();
    const { coordinator, execute } = coordinatorHarness();
    const promise = coordinator.handleRound(roundInput(gates.stream));

    gates.releaseThroughBlockStop();
    await eventually(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(gates.messageStopReleased()).toBe(false);
    gates.releaseMessageStop();

    await expect(promise).resolves.toMatchObject({ kind: "final" });
  });

  it("defers a mutating Skill tool until message_stop", async () => {
    const gates = controlledNativeStream("skill_delete", { skill_id: "skill-1" });
    const { coordinator, execute } = coordinatorHarness();
    const promise = coordinator.handleRound(roundInput(gates.stream));

    gates.releaseThroughBlockStop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(execute).not.toHaveBeenCalled();
    gates.releaseMessageStop();

    await expect(promise).resolves.toMatchObject({ kind: "final" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("never executes a deferred Skill mutation when SSE ends before message_stop", async () => {
    const gates = controlledNativeStream("skill_files_write", {
      skill_id: "skill-1",
      path: "SKILL.md",
      content: "changed",
    });
    const { coordinator, execute } = coordinatorHarness();
    const promise = coordinator.handleRound(roundInput(gates.stream));

    gates.releaseThroughBlockStop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    gates.closeBeforeMessageStop();

    await expect(promise).resolves.toMatchObject({
      kind: "error",
      code: "upstream_stream_incomplete",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("coordinates a CR-only Anthropic event stream without losing the final frame", async () => {
    const crOnly = encoder.encode(decoder.decode(nativeFixture()).replaceAll("\n", "\r"));
    const { coordinator, execute, reenter } = coordinatorHarness();

    const decision = await coordinator.handleRound(roundInput(byteStream(crOnly).stream));

    expect(decision).toMatchObject({ kind: "final", status: 200 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reenter).toHaveBeenCalledTimes(1);
  });

  it("persists Native results and re-enters with the first request snapshot", async () => {
    const source = byteStream(nativeFixture());
    const { coordinator, storage, ledgerStorage, reenter } = coordinatorHarness();

    const decision = await coordinator.handleRound(roundInput(source.stream));

    expect(decision.kind).toBe("final");
    if (decision.kind === "final") {
      expect(decoder.decode(decision.bytes)).toContain("final answer");
      expect(decision.rounds).toHaveLength(2);
      expect(decision.observationStateKey).toMatchObject({ toolBatchId: "id-1" });
    }
    expect(reenter).toHaveBeenCalledTimes(1);
    await expect(ledgerStorage.findRounds(
      { spaceId: "space-1", userId: "user-1", agentSource: "claude-code", sessionId: "session-1" },
      0,
    )).resolves.toEqual([expect.objectContaining({
      blocks: [expect.objectContaining({ kind: "native_tool", callId: "proxy-1" })],
    })]);
    const request = reenter.mock.calls[0][0];
    expect(request).toMatchObject({
      round: 2,
      totalCalls: 1,
      upstreamSnapshot: {
        system: snapshot().system,
        tools: snapshot().tools,
        target: snapshot().target,
      },
    });
    expect(request.messages).toEqual([
      ...snapshot().baseMessages,
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "proxy-1",
          name: "tdai_memory_search",
          input: { query: "rules-1" },
        }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "proxy-1",
          content: "{\"memories\":[\"result:proxy-1\"]}",
        }],
      },
    ]);
    const states = await storage.findActiveBySession(scope());
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      responseStreamStatus: "completed",
      totalCalls: 1,
      observationStatus: "pending",
      observationOutcome: {
        status: 200,
        bodyBase64: expect.any(String),
      },
      slots: [{ callId: "proxy-1", status: "succeeded" }],
    });
  });

  it("does not re-enter when completed Native history cannot be saved", async () => {
    const ledgerStorage = new InMemoryNativeToolLedgerStorageAdapter();
    vi.spyOn(ledgerStorage, "appendRound").mockRejectedValue(new Error("database unavailable"));
    const { coordinator, reenter } = coordinatorHarness({ ledgerStorage });

    const decision = await coordinator.handleRound(roundInput(byteStream(nativeFixture()).stream));

    expect(decision).toMatchObject({
      kind: "error",
      code: "native_tool_history_unavailable",
      status: 503,
    });
    expect(reenter).not.toHaveBeenCalled();
  });

  it("sanitizes an internal re-entry non-2xx body without parsing or leaking it", async () => {
    const exactError = encoder.encode("{\"type\":\"error\",\"marker\":\"tdai_memory_search\"}");
    const { coordinator } = coordinatorHarness({
      reenter: async () => ({
        stream: byteStream(exactError).stream,
        status: 503,
        headers: new Headers({ "content-type": "application/json", "x-request-id": "retry-error" }),
      }),
    });

    const decision = await coordinator.handleRound(roundInput(byteStream(nativeFixture()).stream));

    expect(decision).toMatchObject({
      kind: "error",
      code: "upstream_non_2xx",
      status: 503,
    });
    expect(decision.bytes).not.toEqual(exactError);
    expect(decoder.decode(decision.bytes)).not.toContain("tdai_memory_search");
    expect(decision.headers.get("content-type")).toBe("application/json");
    expect(decision.headers.has("x-request-id")).toBe(false);
  });

  it("allows a later model round to mention a Native tool name in text", async () => {
    const { coordinator } = coordinatorHarness({
      reenter: async () => ({
        stream: byteStream(finalFixture("internal tool tdai_memory_search")).stream,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
      }),
    });

    const decision = await coordinator.handleRound(roundInput(byteStream(nativeFixture()).stream));

    expect(decision).toMatchObject({ kind: "final", status: 200 });
    expect(decoder.decode(decision.bytes)).toContain("tdai_memory_search");
  });

  it("feeds a structured Native failure back as an Anthropic error result", async () => {
    const { coordinator, reenter } = coordinatorHarness({
      execute: async () => ({
        isError: true,
        value: { code: "memory_bridge_unavailable", retryable: true },
      }),
    });

    await coordinator.handleRound(roundInput(byteStream(nativeFixture()).stream));

    expect(reenter.mock.calls[0][0].messages.at(-1)).toEqual({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "proxy-1",
        content: "{\"code\":\"memory_bridge_unavailable\",\"retryable\":true}",
        is_error: true,
      }],
    });
  });

  it("persists multiple Native calls and carries the monotonic total into re-entry", async () => {
    const { coordinator, storage, execute, reenter } = coordinatorHarness();

    await coordinator.handleRound(roundInput(byteStream(nativeFixture(2)).stream));

    expect(execute).toHaveBeenCalledTimes(2);
    expect(reenter.mock.calls[0][0]).toMatchObject({ totalCalls: 2, round: 2 });
    const states = await storage.findActiveBySession(scope());
    expect(states[0]).toMatchObject({
      totalCalls: 2,
      slots: [
        { callId: "proxy-1", status: "succeeded" },
        { callId: "proxy-2", status: "succeeded" },
      ],
    });
  });

  it("renews the parent Client-result lease before every recursive model re-entry", async () => {
    const beforeReenter = vi.fn(async () => {});
    let reentryRound = 0;
    const { coordinator, reenter } = coordinatorHarness({
      beforeReenter,
      reenter: async () => ({
        stream: byteStream(++reentryRound === 1 ? nativeFixture() : finalFixture()).stream,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
      }),
    });

    const decision = await coordinator.handleRound(roundInput(byteStream(nativeFixture()).stream));

    expect(decision.kind).toBe("final");
    expect(reenter).toHaveBeenCalledTimes(2);
    expect(beforeReenter).toHaveBeenCalledTimes(2);
  });

  it("dispatches only Client calls at message_stop for an interleaved mixed round", async () => {
    const releases = new Map<string, (result: NativeToolResult) => void>();
    const { coordinator, storage, execute, reenter } = coordinatorHarness({
      execute: (call) => new Promise((resolve) => {
        releases.set(call.callId, resolve);
      }),
    });

    const decision = await coordinator.handleRound(roundInput(byteStream(mixedFixture()).stream));

    expect(decision.kind).toBe("client_dispatch");
    if (decision.kind !== "client_dispatch") throw new Error("expected Client dispatch");
    expect(visibleToolStarts(decision.bytes)).toEqual([
      { index: 0, id: "c1" },
      { index: 1, id: "c2" },
    ]);
    expect(decoder.decode(decision.bytes)).not.toContain("tdai_memory_search");
    expect(decoder.decode(decision.bytes)).not.toContain("\"p1\"");
    expect(decoder.decode(decision.bytes)).not.toContain("\"p2\"");
    expect(reenter).not.toHaveBeenCalled();
    await eventually(() => expect(execute).toHaveBeenCalledTimes(2));
    const state = await storage.get(decision.stateKey);
    expect(state).toMatchObject({
      responseStreamStatus: "completed",
      clientDispatchStatus: "dispatched",
      totalCalls: 2,
      slots: [
        { callId: "p1", slotIndex: 0, owner: "proxy" },
        { callId: "c1", slotIndex: 1, owner: "client" },
        { callId: "c2", slotIndex: 2, owner: "client" },
        { callId: "p2", slotIndex: 3, owner: "proxy" },
      ],
    });
    releases.get("p2")?.({ isError: false, value: { memories: ["p2"] } });
    releases.get("p1")?.({ isError: false, value: { memories: ["p1"] } });
  });

  it("persists a Client-only continuation produced after a hidden Native round", async () => {
    const beforeClientDispatch = vi.fn(async () => {});
    let storageAtParentCommit:
      | Awaited<ReturnType<InMemoryToolExecutionStorageAdapter["get"]>>
      | undefined;
    const parentStateKey = { ...scope(), toolBatchId: "parent-batch" };
    const onClientDispatchPrepared = vi.fn(async (dispatch: {
      stateKey: import("../types.js").ToolExecutionStateKey;
    }) => {
      storageAtParentCommit = await storage.get(dispatch.stateKey);
    });
    const { coordinator, storage, reenter } = coordinatorHarness({
      reenter: async () => ({
        stream: byteStream(clientFixture()).stream,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
      }),
      beforeClientDispatch,
      onClientDispatchPrepared,
    });

    const decision = await coordinator.handleRound(roundInput(byteStream(nativeFixture()).stream, {
      parentStateKey,
      parentReentryAttempt: 3,
    }));

    expect(decision.kind).toBe("client_dispatch");
    if (decision.kind !== "client_dispatch") throw new Error("expected Client dispatch");
    expect(reenter).toHaveBeenCalledTimes(1);
    expect(beforeClientDispatch).toHaveBeenCalledTimes(1);
    expect(onClientDispatchPrepared).toHaveBeenCalledTimes(1);
    expect(storageAtParentCommit).toMatchObject({
      clientDispatchStatus: "pending",
      parentStateKey,
      parentReentryAttempt: 3,
      clientDispatchOutcome: {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        bodyBase64: expect.any(String),
      },
    });
    expect(visibleToolStarts(decision.bytes)).toEqual([{ index: 0, id: "client-1" }]);
    const states = await storage.findActiveBySession(scope());
    expect(states).toHaveLength(2);
    expect(states[1]).toMatchObject({
      round: 2,
      totalCalls: 1,
      responseStreamStatus: "completed",
      clientDispatchStatus: "dispatched",
      parentStateKey,
      parentReentryAttempt: 3,
      clientDispatchOutcome: {
        status: 200,
        bodyBase64: expect.any(String),
      },
      slots: [{ callId: "client-1", owner: "client", status: "pending" }],
    });
    expect(states[1].upstreamSnapshot.baseMessages).toHaveLength(3);
  });

  it("does not persist an internal Client continuation after its parent fence is lost", async () => {
    const { coordinator, storage } = coordinatorHarness({
      reenter: async () => ({
        stream: byteStream(clientFixture()).stream,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
      }),
      beforeClientDispatch: async () => { throw new Error("parent lease lost"); },
    });

    await expect(coordinator.handleRound(roundInput(byteStream(nativeFixture()).stream)))
      .resolves.toMatchObject({ kind: "error" });
    const states = await storage.findActiveBySession(scope());
    expect(states).toHaveLength(1);
    expect(states[0].slots).toEqual([
      expect.objectContaining({ callId: "proxy-1", owner: "proxy" }),
    ]);
  });

  it("allows Client tool arguments to mention a Native tool name", async () => {
    const onClientDispatchPrepared = vi.fn(async () => {});
    const unsafeClient = concat(
      messageStart(),
      toolFrames(0, "client-unsafe", "client_shell", { command: "tdai_memory_search" }),
      messageStop(),
    );
    const { coordinator, storage } = coordinatorHarness({
      reenter: async () => ({
        stream: byteStream(unsafeClient).stream,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
      }),
      onClientDispatchPrepared,
    });

    const decision = await coordinator.handleRound(roundInput(byteStream(nativeFixture()).stream));

    expect(decision).toMatchObject({ kind: "client_dispatch", status: 200 });
    expect(onClientDispatchPrepared).toHaveBeenCalledTimes(1);
    const states = await storage.findActiveBySession(scope());
    expect(states.at(-1)).toMatchObject({
      clientDispatchStatus: "dispatched",
      slots: [{ callId: "client-unsafe", owner: "client", status: "pending" }],
    });
  });

  it("enforces per-round, total-call, and round limits before offending execution", async () => {
    const perRound = coordinatorHarness({ configure: (config) => {
      config.nativeProxyTools.maxCallsPerRound = 1;
      config.nativeProxyTools.maxTotalCalls = 10;
    } });
    const total = coordinatorHarness({ configure: (config) => {
      config.nativeProxyTools.maxCallsPerRound = 2;
      config.nativeProxyTools.maxTotalCalls = 2;
    } });
    const rounds = coordinatorHarness({ configure: (config) => {
      config.nativeProxyTools.maxRounds = 1;
    } });

    const perRoundDecision = await perRound.coordinator.handleRound(
      roundInput(byteStream(nativeFixture(2)).stream),
    );
    const totalDecision = await total.coordinator.handleRound(roundInput(
      byteStream(nativeFixture()).stream,
      { totalCalls: 2 },
    ));
    const roundDecision = await rounds.coordinator.handleRound(roundInput(
      byteStream(nativeFixture()).stream,
      { round: 2 },
    ));

    for (const decision of [perRoundDecision, totalDecision, roundDecision]) {
      expect(decision.kind).toBe("error");
      if (decision.kind === "error") {
        expect(decision.code).toBe("native_tool_limit_exceeded");
        expect(decoder.decode(decision.bytes)).not.toContain("tdai_memory_search");
        expect(decoder.decode(decision.bytes)).not.toContain("proxy-1");
      }
    }
    await eventually(() => expect(perRound.execute).toHaveBeenCalledTimes(1));
    expect(total.execute).not.toHaveBeenCalled();
    expect(rounds.execute).not.toHaveBeenCalled();
  });

  it("marks a started batch aborted when SSE ends before message_stop", async () => {
    const gates = controlledNativeStream();
    const { coordinator, storage, execute, reenter } = coordinatorHarness();
    const promise = coordinator.handleRound(roundInput(gates.stream));
    gates.releaseThroughBlockStop();
    await eventually(() => expect(execute).toHaveBeenCalledTimes(1));
    gates.closeBeforeMessageStop();

    const decision = await promise;

    expect(decision).toMatchObject({ kind: "error", code: "upstream_stream_incomplete" });
    expect(reenter).not.toHaveBeenCalled();
    const states = await storage.findActiveBySession(scope());
    expect(states).toHaveLength(1);
    expect(states[0].responseStreamStatus).toBe("aborted");
  });

  it("sanitizes a stream read failure and marks the batch aborted", async () => {
    const gates = controlledNativeStream();
    const { coordinator, storage, execute, reenter } = coordinatorHarness();
    const promise = coordinator.handleRound(roundInput(gates.stream));
    gates.releaseThroughBlockStop();
    await eventually(() => expect(execute).toHaveBeenCalledTimes(1));
    gates.failBeforeMessageStop();

    const decision = await promise;

    expect(decision).toMatchObject({ kind: "error", code: "upstream_stream_interrupted" });
    if (decision.kind === "error") {
      expect(decoder.decode(decision.bytes)).not.toContain("secret transport detail");
    }
    expect(reenter).not.toHaveBeenCalled();
    expect((await storage.findActiveBySession(scope()))[0].responseStreamStatus).toBe("aborted");
  });
});
