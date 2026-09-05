import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import { InMemoryToolExecutionStorageAdapter } from "../../db/in-memory-tool-execution-storage-adapter.js";
import { AnthropicClientResponsesToolLoopCoordinator } from "../anthropic-client-responses-tool-loop.js";
import { createDefaultNativeProxyToolRegistry } from "../tool-registry.js";
import type { NativeReentryRequest } from "../tool-loop-coordinator.js";
import type { ToolExecutionScope, UpstreamRequestSnapshot } from "../types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const headers = new Headers({ "content-type": "text/event-stream" });

function event(type: string, value: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

function stream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(value));
      controller.close();
    },
  });
}

function callRound(calls: Array<{ index: number; id: string; callId: string; name: string; arguments: string }>): string {
  const output = calls.map((call) => ({
    type: "function_call",
    id: call.id,
    call_id: call.callId,
    name: call.name,
    arguments: call.arguments,
  }));
  return event("response.created", { response: { id: "resp_tools", model: "deepseek-v4-flash" } })
    + calls.map((call) => {
      const item = output[call.index];
      return event("response.output_item.added", { output_index: call.index, item: { ...item, arguments: "" } })
        + event("response.function_call_arguments.done", { output_index: call.index, item_id: call.id, arguments: call.arguments })
        + event("response.output_item.done", { output_index: call.index, item });
    }).join("")
    + event("response.completed", {
      response: {
        id: "resp_tools",
        model: "deepseek-v4-flash",
        status: "completed",
        output,
        usage: { input_tokens: 10, output_tokens: 4 },
      },
    });
}

function mixedCallRoundWithReasoning(reasoningDeltas: string[]): string {
  const reasoning = {
    type: "reasoning",
    id: "rs_mixed",
    content: [{ type: "reasoning_text", text: reasoningDeltas.join("") }],
  };
  const native = {
    type: "function_call",
    id: "fc_native",
    call_id: "call_native",
    name: "tdai_memory_search",
    arguments: "{\"query\":\"hidden\"}",
  };
  const client = {
    type: "function_call",
    id: "fc_client",
    call_id: "call_client",
    name: "Bash",
    arguments: "{\"command\":\"pwd\"}",
  };
  return event("response.created", { response: { id: "resp_mixed", model: "deepseek-v4-flash" } })
    + event("response.output_item.added", {
      output_index: 0,
      item: { type: "reasoning", id: reasoning.id, content: [] },
    })
    + reasoningDeltas.map((delta) => event("response.reasoning_text.delta", {
      output_index: 0,
      item_id: reasoning.id,
      delta,
    })).join("")
    + event("response.reasoning_text.done", { output_index: 0, item_id: reasoning.id })
    + event("response.output_item.done", { output_index: 0, item: reasoning })
    + event("response.output_item.added", { output_index: 1, item: { ...native, arguments: "" } })
    + event("response.function_call_arguments.done", {
      output_index: 1,
      item_id: native.id,
      arguments: native.arguments,
    })
    + event("response.output_item.done", { output_index: 1, item: native })
    + event("response.output_item.added", { output_index: 2, item: { ...client, arguments: "" } })
    + event("response.function_call_arguments.done", {
      output_index: 2,
      item_id: client.id,
      arguments: client.arguments,
    })
    + event("response.output_item.done", { output_index: 2, item: client })
    + event("response.completed", {
      response: {
        id: "resp_mixed",
        model: "deepseek-v4-flash",
        status: "completed",
        output: [reasoning, native, client],
        usage: { input_tokens: 10, output_tokens: 8 },
      },
    });
}

function anthropicEvents(bytes: Uint8Array): Record<string, unknown>[] {
  return decoder.decode(bytes).split(/\r?\n\r?\n/).flatMap((frame) => {
    const data = frame.split(/\r?\n/).find((line) => line.startsWith("data: "));
    if (!data) return [];
    return [JSON.parse(data.slice(6)) as Record<string, unknown>];
  });
}

function finalRound(): string {
  const item = {
    type: "message",
    id: "msg_final",
    role: "assistant",
    content: [{ type: "output_text", text: "final answer" }],
  };
  return event("response.created", { response: { id: "resp_final", model: "deepseek-v4-flash" } })
    + event("response.output_item.done", { output_index: 0, item })
    + event("response.completed", {
      response: {
        id: "resp_final",
        model: "deepseek-v4-flash",
        status: "completed",
        output: [item],
        usage: { input_tokens: 20, output_tokens: 3 },
      },
    });
}

const scope: ToolExecutionScope = {
  spaceId: "space",
  userId: "user",
  agentSource: "claude-code",
  sessionId: "session",
  contextVersion: "v1",
};

const snapshot: UpstreamRequestSnapshot = {
  protocol: "responses",
  baseMessages: [{ type: "message", role: "user", content: "remember?" }],
  logicalBaseMessages: [{ role: "user", content: [{ type: "text", text: "remember?" }] }],
  tools: [],
  instructions: "be helpful",
  requestParameters: { model: "deepseek-v4-flash", stream: true },
  target: {
    id: "target",
    url: "https://api.deepseek.com/responses",
    model: "deepseek-v4-flash",
    authSource: "agent",
  },
};

function harness(onClientDispatchPrepared?: (dispatch: { bytes: Uint8Array }) => Promise<void>) {
  const storage = new InMemoryToolExecutionStorageAdapter();
  const execute = vi.fn(async () => ({ isError: false, value: { memories: ["rule"] } }));
  const reenter = vi.fn(async (_request: NativeReentryRequest) => ({
    stream: stream(finalRound()),
    status: 200,
    headers,
  }));
  let id = 0;
  const coordinator = new AnthropicClientResponsesToolLoopCoordinator({
    registry: createDefaultNativeProxyToolRegistry(),
    storage,
    dispatcher: { execute },
    reenter,
    limits: structuredClone(DEFAULT_CONFIG.nativeProxyTools),
    createId: () => `batch-${++id}`,
    onClientDispatchPrepared,
    model: "deepseek-v4-flash",
  });
  return { coordinator, storage, execute, reenter };
}

describe("Anthropic client / Responses upstream Tool Loop", () => {
  it.each([false, true])("persists converted Client-only continuations (resumed: %s)", async (resumed) => {
    const onPrepared = vi.fn(async (_dispatch: { bytes: Uint8Array }) => {});
    const { coordinator, storage, reenter } = harness(onPrepared);
    const client = callRound([{ index: 0, id: "fc_client", callId: "c1", name: "Bash", arguments: "{\"command\":\"pwd\"}" }]);
    const parentStateKey = { ...scope, toolBatchId: "parent" };
    reenter.mockImplementationOnce(async () => ({ stream: stream(client), status: 200, headers }));

    const decision = await coordinator.handleRound({
      stream: stream(resumed ? client : callRound([{ index: 0, id: "fc_native", callId: "p1", name: "tdai_memory_search", arguments: "{\"query\":\"rules\"}" }])),
      status: 200, headers, scope, turnSeq: 1, upstreamSnapshot: snapshot,
      round: resumed ? 3 : 1, totalCalls: resumed ? 1 : 0,
      ...(resumed ? { parentStateKey, parentReentryAttempt: 1 } : {}),
    });

    expect(decision.kind).toBe("client_dispatch");
    if (decision.kind !== "client_dispatch") throw new Error("expected Client dispatch");
    expect(onPrepared).toHaveBeenCalledTimes(1);
    expect(await storage.get(decision.stateKey)).toMatchObject({
      round: resumed ? 3 : 2, totalCalls: 1, clientDispatchStatus: "dispatched",
      slots: [{ callId: "c1", owner: "client" }],
      clientDispatchOutcome: { bodyBase64: Buffer.from(decision.bytes).toString("base64") },
    });
    expect(decoder.decode(decision.bytes)).toContain("event: message_start");
    expect(decoder.decode(decision.bytes)).not.toContain("response.output_item");
    expect(decoder.decode(decision.bytes)).not.toContain("tdai_memory_search");
  });

  it("executes a Native call using Responses re-entry and returns only Anthropic SSE", async () => {
    const { coordinator, execute, reenter } = harness();
    const decision = await coordinator.handleRound({
      stream: stream(callRound([
        { index: 0, id: "fc_native", callId: "call_native", name: "tdai_memory_search", arguments: "{\"query\":\"rules\"}" },
      ])),
      status: 200,
      headers,
      scope,
      turnSeq: 1,
      upstreamSnapshot: snapshot,
      round: 1,
      totalCalls: 0,
    });

    const visible = decoder.decode(decision.bytes);
    expect(decision.kind).toBe("final");
    expect(visible).toContain("event: message_start");
    expect(visible).toContain("final answer");
    expect(visible).not.toContain("response.output_item");
    expect(visible).not.toContain("tdai_memory_search");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reenter.mock.calls[0][0].messages).toEqual([
      { type: "message", role: "user", content: "remember?" },
      { type: "function_call", id: "fc_native", call_id: "call_native", name: "tdai_memory_search", arguments: "{\"query\":\"rules\"}" },
      { type: "function_call_output", call_id: "call_native", output: "{\"memories\":[\"rule\"]}" },
    ]);
  });

  it("persists and reports a mixed Client dispatch in Anthropic format", async () => {
    const prepared = vi.fn(async (_dispatch: { bytes: Uint8Array }) => {});
    const { coordinator, storage } = harness(prepared);
    const decision = await coordinator.handleRound({
      stream: stream(callRound([
        { index: 0, id: "fc_native", callId: "call_native", name: "tdai_memory_search", arguments: "{\"query\":\"hidden\"}" },
        { index: 1, id: "fc_client", callId: "call_client", name: "Bash", arguments: "{\"command\":\"pwd\"}" },
      ])),
      status: 200,
      headers,
      scope,
      turnSeq: 1,
      upstreamSnapshot: snapshot,
      round: 1,
      totalCalls: 0,
    });

    expect(decision.kind).toBe("client_dispatch");
    if (decision.kind !== "client_dispatch") return;
    const visible = decoder.decode(decision.bytes);
    expect(visible).toContain('"type":"tool_use"');
    expect(visible).toContain('"id":"call_client"');
    expect(visible).toContain('"name":"Bash"');
    expect(visible).not.toContain("tdai_memory_search");
    expect(decoder.decode(prepared.mock.calls[0][0].bytes)).toBe(visible);
    const persisted = await storage.get(decision.stateKey);
    expect(Buffer.from(persisted!.clientDispatchOutcome!.bodyBase64, "base64").toString()).toBe(visible);
  });

  it.each([
    ["one reasoning delta", ["tdai_memory_search"]],
    ["several reasoning deltas", ["tdai_", "memory", "_search"]],
  ])("allows a Native tool name in %s while hiding its Tool Call", async (_label, deltas) => {
    const { coordinator } = harness();

    const decision = await coordinator.handleRound({
      stream: stream(mixedCallRoundWithReasoning(deltas)),
      status: 200,
      headers,
      scope,
      turnSeq: 1,
      upstreamSnapshot: snapshot,
      round: 1,
      totalCalls: 0,
    });

    expect(decision.kind).toBe("client_dispatch");
    const events = anthropicEvents(decision.bytes);
    const thinking = events.flatMap((entry) => {
      const delta = entry.delta as Record<string, unknown> | undefined;
      return delta?.type === "thinking_delta" && typeof delta.thinking === "string"
        ? [delta.thinking]
        : [];
    }).join("");
    const toolUses = events.flatMap((entry) => {
      const block = entry.content_block as Record<string, unknown> | undefined;
      return entry.type === "content_block_start" && block?.type === "tool_use" ? [block] : [];
    });
    expect(thinking).toContain("tdai_memory_search");
    expect(toolUses).toEqual([
      expect.objectContaining({ id: "call_client", name: "Bash" }),
    ]);
    expect(JSON.stringify(toolUses)).not.toContain("call_native");
    expect(JSON.stringify(toolUses)).not.toContain("hidden");
  });

  it("converts a pure Client response without creating durable state", async () => {
    const { coordinator, storage } = harness();
    const decision = await coordinator.handleRound({
      stream: stream(callRound([
        { index: 0, id: "fc_client", callId: "call_client", name: "Bash", arguments: "{\"command\":\"pwd\"}" },
      ])),
      status: 200,
      headers,
      scope,
      turnSeq: 1,
      upstreamSnapshot: snapshot,
      round: 1,
      totalCalls: 0,
    });

    expect(decision.kind).toBe("replay");
    expect(decoder.decode(decision.bytes)).toContain('"type":"tool_use"');
    expect(await storage.findActiveBySession(scope)).toEqual([]);
  });
});
