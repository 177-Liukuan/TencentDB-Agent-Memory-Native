import { describe, expect, it } from "vitest";

import { createDefaultNativeProxyToolRegistry } from "../../../native-proxy-tools/tool-registry.js";
import { ResponsesStreamParser } from "../responses-stream.js";

const encoder = new TextEncoder();
const registry = createDefaultNativeProxyToolRegistry();

function sse(event: string, payload: Record<string, unknown>): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

describe("ResponsesStreamParser", () => {
  it("completes a fragmented function call only at arguments.done", () => {
    const parser = new ResponsesStreamParser(registry);
    parser.push(sse("response.output_item.added", {
      type: "response.output_item.added", output_index: 2,
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "tdai_memory_search", arguments: "" },
    }));
    expect(parser.push(sse("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 2, delta: "{\"query\":\"old",
    }))).not.toContainEqual(expect.objectContaining({ type: "tool_call_completed" }));
    expect(parser.push(sse("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 2, delta: " rules\"}",
    }))).not.toContainEqual(expect.objectContaining({ type: "tool_call_completed" }));

    expect(parser.push(sse("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 2,
      arguments: "{\"query\":\"old rules\"}",
    }))).toContainEqual(expect.objectContaining({
      type: "tool_call_completed",
      call: expect.objectContaining({
        callId: "call_1", toolName: "tdai_memory_search", owner: "proxy",
        contentBlockIndex: 2, input: { query: "old rules" },
      }),
    }));
  });

  it("falls back to output_item.done and preserves interleaved slot order", () => {
    const parser = new ResponsesStreamParser(registry);
    parser.push(sse("response.output_item.added", {
      type: "response.output_item.added", output_index: 4,
      item: { type: "function_call", id: "fc_client", call_id: "call_client", name: "client_shell", arguments: "" },
    }));
    parser.push(sse("response.output_item.added", {
      type: "response.output_item.added", output_index: 1,
      item: { type: "function_call", id: "fc_proxy", call_id: "call_proxy", name: "tdai_memory_search", arguments: "" },
    }));
    const first = parser.push(sse("response.output_item.done", {
      type: "response.output_item.done", output_index: 4,
      item: { type: "function_call", id: "fc_client", call_id: "call_client", name: "client_shell", arguments: "{\"command\":\"pwd\"}" },
    }));
    const second = parser.push(sse("response.output_item.done", {
      type: "response.output_item.done", output_index: 1,
      item: { type: "function_call", id: "fc_proxy", call_id: "call_proxy", name: "tdai_memory_search", arguments: "{\"query\":\"rules\"}" },
    }));

    expect(first).toContainEqual(expect.objectContaining({
      call: expect.objectContaining({ owner: "client", slotIndex: 0 }),
    }));
    expect(second).toContainEqual(expect.objectContaining({
      call: expect.objectContaining({ owner: "proxy", slotIndex: 1 }),
    }));
  });

  it("does not classify provider output items as client tools", () => {
    const parser = new ResponsesStreamParser(registry);
    expect(parser.push(sse("response.output_item.done", {
      type: "response.output_item.done", output_index: 0,
      item: { type: "web_search_call", id: "ws_1", status: "completed" },
    }))).not.toContainEqual(expect.objectContaining({ type: "tool_call_completed" }));
    parser.push(sse("response.completed", {
      type: "response.completed", response: { id: "resp_1", status: "completed", output: [] },
    }));
    expect(parser.finish()).not.toContainEqual(expect.objectContaining({ type: "protocol_error" }));
    expect(parser.snapshot().outputItems).toEqual([
      { type: "web_search_call", id: "ws_1", status: "completed" },
    ]);
  });

  it("reports failed responses and an interrupted stream", () => {
    const failed = new ResponsesStreamParser(registry);
    expect(failed.push(sse("response.failed", {
      type: "response.failed", response: { id: "resp_bad", status: "failed", error: { code: "server_error" } },
    }))).toContainEqual(expect.objectContaining({ type: "protocol_error", code: "response_failed" }));

    const interrupted = new ResponsesStreamParser(registry);
    interrupted.push(sse("response.output_item.added", {
      type: "response.output_item.added", output_index: 0,
      item: { type: "function_call", id: "fc_open", call_id: "call_open", name: "tdai_memory_search", arguments: "" },
    }));
    expect(interrupted.finish()).toContainEqual(expect.objectContaining({
      type: "protocol_error", code: "unexpected_eof",
    }));
    expect(interrupted.snapshot().toolCalls).toEqual([]);
  });
});
