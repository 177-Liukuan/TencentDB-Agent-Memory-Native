import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import { InMemoryToolExecutionStorageAdapter } from "../../db/in-memory-tool-execution-storage-adapter.js";
import { ResponsesToolLoopCoordinator } from "../responses-tool-loop-coordinator.js";
import { createDefaultNativeProxyToolRegistry } from "../tool-registry.js";
import type { ToolExecutionScope, UpstreamRequestSnapshot } from "../types.js";
import type { NativeReentryRequest } from "../tool-loop-coordinator.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const headers = new Headers({ "content-type": "text/event-stream" });

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); } });
}

function event(type: string, value: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

function callRound(calls: Array<{ index: number; id: string; callId: string; name: string; arguments: string }>): string {
  const frames: string[] = [];
  for (const call of calls) {
    const item = { type: "function_call", id: call.id, call_id: call.callId, name: call.name, arguments: call.arguments };
    frames.push(event("response.output_item.added", { output_index: call.index, item: { ...item, arguments: "" } }));
    frames.push(event("response.function_call_arguments.done", { output_index: call.index, item_id: call.id, arguments: call.arguments }));
    frames.push(event("response.output_item.done", { output_index: call.index, item }));
  }
  frames.push(event("response.completed", { response: { id: "resp_tools", status: "completed", output: calls.map((call) => ({ type: "function_call", id: call.id, call_id: call.callId, name: call.name, arguments: call.arguments })) } }));
  return frames.join("");
}

function finalRound(): string {
  return event("response.output_item.done", { output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "final answer" }] } })
    + event("response.completed", { response: { id: "resp_final", status: "completed", output: [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "final answer" }] }] } });
}

const scope: ToolExecutionScope = { spaceId: "space", userId: "user", agentSource: "codex", sessionId: "session", contextVersion: "v1" };
const snapshot: UpstreamRequestSnapshot = {
  protocol: "responses", baseMessages: [{ role: "user", content: "remember?" }], tools: [], instructions: "be helpful",
  requestParameters: { model: "gpt-5", stream: true },
  target: { id: "target", url: "https://upstream.test/v1/responses", model: "gpt-5", authSource: "agent" },
};

function harness() {
  const storage = new InMemoryToolExecutionStorageAdapter();
  const execute = vi.fn(async () => ({ isError: false, value: { memories: ["rule"] } }));
  const reenter = vi.fn(async (_request: NativeReentryRequest) => ({ stream: stream(finalRound()), status: 200, headers }));
  let id = 0;
  const coordinator = new ResponsesToolLoopCoordinator({
    registry: createDefaultNativeProxyToolRegistry(), storage, dispatcher: { execute }, reenter,
    limits: structuredClone(DEFAULT_CONFIG.nativeProxyTools), createId: () => `batch-${++id}`,
  });
  return { coordinator, storage, execute, reenter };
}

describe("ResponsesToolLoopCoordinator", () => {
  it("starts a read-only Native call at arguments.done before response.completed", async () => {
    const { coordinator, execute } = harness();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const liveStream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const item = { type: "function_call", id: "fc_early", call_id: "call_early", name: "tdai_memory_search", arguments: "{\"query\":\"early\"}" };
    controller.enqueue(encoder.encode(
      event("response.output_item.added", { output_index: 0, item: { ...item, arguments: "" } })
      + event("response.function_call_arguments.done", { output_index: 0, item_id: item.id, arguments: item.arguments }),
    ));
    const pending = coordinator.handleRound({
      stream: liveStream, status: 200, headers, scope, turnSeq: 1, upstreamSnapshot: snapshot, round: 1, totalCalls: 0,
    });

    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    controller.enqueue(encoder.encode(
      event("response.output_item.done", { output_index: 0, item })
      + event("response.completed", { response: { id: "resp_early", status: "completed", output: [item] } }),
    ));
    controller.close();
    await expect(pending).resolves.toMatchObject({ kind: "final", status: 200 });
  });

  it("persists, executes, appends function_call_output, and internally re-enters", async () => {
    const { coordinator, execute, reenter } = harness();
    const decision = await coordinator.handleRound({
      stream: stream(callRound([{ index: 0, id: "fc_1", callId: "call_1", name: "tdai_memory_search", arguments: "{\"query\":\"rules\"}" }])),
      status: 200, headers, scope, turnSeq: 1, upstreamSnapshot: snapshot, round: 1, totalCalls: 0,
    });

    expect(decision.kind).toBe("final");
    expect(decoder.decode(decision.bytes)).toContain("final answer");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reenter.mock.calls[0][0].messages).toEqual([
      { role: "user", content: "remember?" },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "tdai_memory_search", arguments: "{\"query\":\"rules\"}" },
      { type: "function_call_output", call_id: "call_1", output: "{\"memories\":[\"rule\"]}" },
    ]);
  });

  it("hides Native calls and preserves Client calls in a mixed response", async () => {
    const { coordinator } = harness();
    const decision = await coordinator.handleRound({
      stream: stream(callRound([
        { index: 0, id: "fc_native", callId: "call_native", name: "tdai_memory_search", arguments: "{\"query\":\"secret\"}" },
        { index: 1, id: "fc_client", callId: "call_client", name: "client_shell", arguments: "{\"command\":\"pwd\"}" },
      ])), status: 200, headers, scope, turnSeq: 1, upstreamSnapshot: snapshot, round: 1, totalCalls: 0,
    });
    expect(decision.kind).toBe("client_dispatch");
    const visible = decoder.decode(decision.bytes);
    expect(visible).not.toContain("tdai_memory_search");
    expect(visible).not.toContain("secret");
    expect(visible).toContain("client_shell");
  });

  it("does not execute an uncompleted call after SSE interruption", async () => {
    const { coordinator, execute } = harness();
    const incomplete = event("response.output_item.added", { output_index: 0, item: { type: "function_call", id: "fc_open", call_id: "call_open", name: "tdai_memory_search", arguments: "" } });
    const decision = await coordinator.handleRound({ stream: stream(incomplete), status: 200, headers, scope, turnSeq: 1, upstreamSnapshot: snapshot, round: 1, totalCalls: 0 });
    expect(decision).toMatchObject({ kind: "error", code: "upstream_stream_incomplete" });
    expect(execute).not.toHaveBeenCalled();
  });
});
