import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import { InMemoryToolExecutionStorageAdapter } from "../../db/in-memory-tool-execution-storage-adapter.js";
import { OpenAIToolLoopCoordinator } from "../openai-tool-loop-coordinator.js";
import { resumeClientToolResults } from "../client-tool-resume.js";
import { createDefaultNativeProxyToolRegistry } from "../tool-registry.js";
import type { ToolExecutionScope, UpstreamRequestSnapshot } from "../types.js";
import type { NativeReentryRequest } from "../tool-loop-coordinator.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sse(...payloads: unknown[]): Uint8Array {
  return encoder.encode(payloads.map((payload) => (
    `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`
  )).join(""));
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

function toolRound(calls: Array<{ id: string; name: string; arguments: string }>, provider = false): Uint8Array {
  return sse(
    { id: "chat-1", choices: [{ index: 0, delta: {
      ...(provider ? { provider_tool: { type: "web_search", id: "srv-1", status: "completed", result: { answer: "opaque" } } } : {}),
      tool_calls: calls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
    }, finish_reason: null }] },
    { id: "chat-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    "[DONE]",
  );
}

function finalRound(): Uint8Array {
  return sse(
    { id: "chat-2", choices: [{ index: 0, delta: { role: "assistant", content: "final answer" }, finish_reason: null }] },
    { id: "chat-2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    "[DONE]",
  );
}

const scope: ToolExecutionScope = {
  spaceId: "space-1", userId: "user-1", agentSource: "codebuddy", sessionId: "session-1", contextVersion: "v1",
};

const snapshot: UpstreamRequestSnapshot = {
  protocol: "openai",
  baseMessages: [{ role: "user", content: "remember?" }],
  tools: [],
  requestParameters: { model: "gpt-test", stream: true },
  target: { id: "target-1", url: "https://upstream.test/chat/completions", model: "gpt-test", authSource: "agent" },
};

function harness() {
  const storage = new InMemoryToolExecutionStorageAdapter();
  const execute = vi.fn(async () => ({ isError: false, value: { hits: ["memory"] } }));
  const reenter = vi.fn(async (_request: NativeReentryRequest) => ({
    stream: stream(finalRound()), status: 200, headers: new Headers({ "content-type": "text/event-stream" }),
  }));
  let id = 0;
  const coordinator = new OpenAIToolLoopCoordinator({
    registry: createDefaultNativeProxyToolRegistry(), storage, dispatcher: { execute },
    limits: structuredClone(DEFAULT_CONFIG.nativeProxyTools), reenter, createId: () => `id-${++id}`,
  });
  return { coordinator, storage, execute, reenter };
}

describe("OpenAI Tool Loop coordinator", () => {
  it.each([false, true])("persists a Client-only continuation (resumed: %s)", async (resumed) => {
    const { coordinator, storage, reenter } = harness();
    const clientBytes = toolRound([{ id: "c1", name: "client_shell", arguments: "{\"command\":\"pwd\"}" }]);
    const parentStateKey = { ...scope, toolBatchId: "parent" };
    reenter.mockImplementationOnce(async () => ({ stream: stream(clientBytes), status: 200, headers: new Headers() }));
    const decision = await coordinator.handleRound({
      stream: stream(resumed ? clientBytes : toolRound([{ id: "p1", name: "tdai_memory_search", arguments: "{\"query\":\"rules\"}" }])),
      status: 200, headers: new Headers(), scope, turnSeq: 1, upstreamSnapshot: snapshot,
      round: resumed ? 3 : 1, totalCalls: resumed ? 1 : 0,
      ...(resumed ? { parentStateKey, parentReentryAttempt: 1 } : {}),
    });

    expect(decision.kind).toBe("client_dispatch");
    if (decision.kind !== "client_dispatch") throw new Error("expected Client dispatch");
    expect(await storage.get(decision.stateKey)).toMatchObject({
      round: resumed ? 3 : 2, totalCalls: 1, clientDispatchStatus: "dispatched",
      slots: [{ callId: "c1", owner: "client" }],
      ...(resumed ? { parentStateKey, parentReentryAttempt: 1 } : {}),
    });
    expect(decoder.decode(decision.bytes)).toContain("client_shell");
    expect(decoder.decode(decision.bytes)).not.toContain("tdai_memory_search");
  });

  it("executes Proxy calls only at the round boundary and internally re-enters", async () => {
    const { coordinator, execute, reenter } = harness();
    const decision = await coordinator.handleRound({
      stream: stream(toolRound([{ id: "p1", name: "tdai_memory_search", arguments: "{\"query\":\"rules\"}" }])),
      status: 200, headers: new Headers({ "content-type": "text/event-stream" }), scope, turnSeq: 1,
      upstreamSnapshot: snapshot, round: 1, totalCalls: 0,
    });

    expect(decision.kind).toBe("final");
    expect(decoder.decode(decision.bytes)).toContain("final answer");
    expect(decoder.decode(decision.bytes)).not.toContain("tdai_memory_search");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reenter.mock.calls[0][0].messages).toEqual([
      { role: "user", content: "remember?" },
      { role: "assistant", content: null, tool_calls: [{ id: "p1", type: "function", function: { name: "tdai_memory_search", arguments: "{\"query\":\"rules\"}" } }] },
      { role: "tool", tool_call_id: "p1", content: "{\"hits\":[\"memory\"]}" },
    ]);
  });

  it("filters Proxy calls, preserves Provider blocks, and dispatches Client calls", async () => {
    const { coordinator, execute } = harness();
    const decision = await coordinator.handleRound({
      stream: stream(toolRound([
        { id: "p1", name: "tdai_memory_search", arguments: "{\"query\":\"rules\"}" },
        { id: "c1", name: "client_shell", arguments: "{\"command\":\"pwd\"}" },
      ], true)),
      status: 200, headers: new Headers({ "content-type": "text/event-stream" }), scope, turnSeq: 1,
      upstreamSnapshot: snapshot, round: 1, totalCalls: 0,
    });

    expect(decision.kind).toBe("client_dispatch");
    const visible = decoder.decode(decision.bytes);
    expect(visible).not.toContain("tdai_memory_search");
    expect(visible).toContain("client_shell");
    expect(visible).toContain("provider_tool");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not execute a collected call when the SSE stream is interrupted", async () => {
    const { coordinator, execute } = harness();
    const incomplete = sse({ id: "chat-1", choices: [{ index: 0, delta: { tool_calls: [{
      index: 0, id: "p1", type: "function", function: { name: "tdai_memory_search", arguments: "{\"query\":\"rules\"}" },
    }] }, finish_reason: null }] });
    const decision = await coordinator.handleRound({
      stream: stream(incomplete), status: 200, headers: new Headers({ "content-type": "text/event-stream" }),
      scope, turnSeq: 1, upstreamSnapshot: snapshot, round: 1, totalCalls: 0,
    });

    expect(decision).toMatchObject({ kind: "error", code: "upstream_stream_incomplete" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts OpenAI Tool messages and rebuilds hidden mixed history", async () => {
    const { coordinator, storage, execute } = harness();
    const initial = await coordinator.handleRound({
      stream: stream(toolRound([
        { id: "p1", name: "tdai_memory_search", arguments: "{\"query\":\"rules\"}" },
        { id: "c1", name: "client_shell", arguments: "{\"command\":\"pwd\"}" },
      ])),
      status: 200, headers: new Headers({ "content-type": "text/event-stream" }), scope, turnSeq: 1,
      upstreamSnapshot: snapshot, round: 1, totalCalls: 0,
    });
    expect(initial.kind).toBe("client_dispatch");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const reenter = vi.fn(async (_request: NativeReentryRequest) => ({
      stream: stream(finalRound()), status: 200, headers: new Headers({ "content-type": "text/event-stream" }),
    }));

    const resumed = await resumeClientToolResults({
      body: { messages: [
        { role: "user", content: "remember?" },
        { role: "tool", tool_call_id: "c1", content: "pwd output" },
      ] },
      scope, storage, dispatcher: { execute }, limits: structuredClone(DEFAULT_CONFIG.nativeProxyTools), reenter,
    });

    expect(resumed.kind).toBe("reentered");
    expect(reenter.mock.calls[0][0].messages).toEqual([
      { role: "user", content: "remember?" },
      { role: "assistant", content: null, tool_calls: [
        { id: "p1", type: "function", function: { name: "tdai_memory_search", arguments: "{\"query\":\"rules\"}" } },
        { id: "c1", type: "function", function: { name: "client_shell", arguments: "{\"command\":\"pwd\"}" } },
      ] },
      { role: "tool", tool_call_id: "p1", content: "{\"hits\":[\"memory\"]}" },
      { role: "tool", tool_call_id: "c1", content: "pwd output" },
    ]);
  });
});
