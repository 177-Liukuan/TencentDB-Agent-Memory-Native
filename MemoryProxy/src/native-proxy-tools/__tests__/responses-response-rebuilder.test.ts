import { describe, expect, it } from "vitest";

import {
  buildClientVisibleResponsesSse,
  buildResponsesToolInputItems,
} from "../responses-response-rebuilder.js";
import type { JsonValue, ToolCallSlot } from "../types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function frame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

describe("Responses response rebuilding", () => {
  it("builds ordered function_call_output items after the original output skeleton", () => {
    const slots: ToolCallSlot[] = [
      { callId: "call_client", slotIndex: 1, contentBlockIndex: 2, toolName: "client_shell", owner: "client", input: { command: "pwd" }, argumentsComplete: true, status: "succeeded", executionAttempt: 0, result: "ok" },
      { callId: "call_native", slotIndex: 0, contentBlockIndex: 1, toolName: "tdai_memory_search", owner: "proxy", input: { query: "rules" }, argumentsComplete: true, status: "succeeded", executionAttempt: 1, result: { memories: [] } },
    ];
    const skeleton: JsonValue[] = [
      { type: "reasoning", id: "rs_1", summary: [] },
      { type: "function_call", id: "fc_native", call_id: "call_native", name: "tdai_memory_search", arguments: "{\"query\":\"rules\"}" },
      { type: "function_call", id: "fc_client", call_id: "call_client", name: "client_shell", arguments: "{\"command\":\"pwd\"}" },
    ];

    expect(buildResponsesToolInputItems(skeleton, slots)).toEqual([
      ...skeleton,
      { type: "function_call_output", call_id: "call_native", output: "{\"memories\":[]}" },
      { type: "function_call_output", call_id: "call_client", output: "ok" },
    ]);
  });

  it("removes native events, compacts indexes, and preserves provider/client output", () => {
    const raw = encoder.encode([
      frame("response.output_item.added", { output_index: 0, item: { type: "reasoning", id: "rs_1" } }),
      frame("response.output_item.done", { output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } }),
      frame("response.output_item.added", { output_index: 1, item: { type: "function_call", id: "fc_native", call_id: "call_native", name: "tdai_memory_search", arguments: "" } }),
      frame("response.function_call_arguments.done", { output_index: 1, item_id: "fc_native", arguments: "{\"query\":\"secret\"}" }),
      frame("response.output_item.done", { output_index: 1, item: { type: "function_call", id: "fc_native", call_id: "call_native", name: "tdai_memory_search", arguments: "{\"query\":\"secret\"}" } }),
      frame("response.output_item.done", { output_index: 2, item: { type: "web_search_call", id: "ws_1", status: "completed" } }),
      frame("response.output_item.done", { output_index: 3, item: { type: "function_call", id: "fc_client", call_id: "call_client", name: "client_shell", arguments: "{\"command\":\"pwd\"}" } }),
      frame("response.completed", { response: { id: "resp_1", status: "completed", output: [
        { type: "reasoning", id: "rs_1", summary: [] },
        { type: "function_call", id: "fc_native", call_id: "call_native", name: "tdai_memory_search", arguments: "{\"query\":\"secret\"}" },
        { type: "web_search_call", id: "ws_1", status: "completed" },
        { type: "function_call", id: "fc_client", call_id: "call_client", name: "client_shell", arguments: "{\"command\":\"pwd\"}" },
      ] } }),
    ].join(""));

    const visible = decoder.decode(buildClientVisibleResponsesSse(raw, new Set([1])));
    expect(visible).not.toContain("tdai_memory_search");
    expect(visible).not.toContain("call_native");
    expect(visible).not.toContain("secret");
    expect(visible).toContain("web_search_call");
    expect(visible).toContain("client_shell");
    expect(visible).toContain('"output_index":2');
    const completed = visible.split("\n\n").find((value) => value.includes("response.completed")) ?? "";
    const payload = JSON.parse(completed.split("data: ")[1]) as { response: { output: unknown[] } };
    expect(payload.response.output).toHaveLength(3);
  });
});
