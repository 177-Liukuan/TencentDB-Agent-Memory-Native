import { describe, expect, it } from "vitest";

import {
  ResponsesAnthropicStreamError,
  convertResponsesJsonToAnthropic,
  convertResponsesSseBytesToAnthropic,
  createResponsesToAnthropicSseTransform,
} from "../responses-anthropic-response.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function frame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function parseAnthropic(text: string): Array<Record<string, unknown>> {
  return text.trim().split(/\n\n/).map((value) => {
    const data = value.split(/\n/).find((line) => line.startsWith("data: "))?.slice(6);
    if (!data) throw new Error(`missing data: ${value}`);
    return JSON.parse(data) as Record<string, unknown>;
  });
}

describe("Responses to Anthropic response conversion", () => {
  it("converts fragmented reasoning, text, function calls, usage, and terminal events in output order", () => {
    const input = [
      frame("response.created", {
        response: {
          id: "resp_1",
          model: "deepseek-v4-flash",
          usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 3 }, output_tokens: 0 },
        },
      }),
      frame("response.output_item.added", {
        output_index: 0,
        item: { type: "reasoning", id: "rs_1", content: [] },
      }),
      frame("response.reasoning_text.delta", {
        output_index: 0,
        item_id: "rs_1",
        delta: "think",
      }),
      frame("response.reasoning_text.done", {
        output_index: 0,
        item_id: "rs_1",
        text: "think",
      }),
      frame("response.output_item.added", {
        output_index: 1,
        item: { type: "message", id: "msg_1", role: "assistant", content: [] },
      }),
      frame("response.output_text.delta", {
        output_index: 1,
        item_id: "msg_1",
        delta: "hello",
      }),
      frame("response.output_text.done", {
        output_index: 1,
        item_id: "msg_1",
        text: "hello",
      }),
      frame("response.output_item.added", {
        output_index: 2,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "Bash", arguments: "" },
      }),
      frame("response.function_call_arguments.delta", {
        output_index: 2,
        item_id: "fc_1",
        delta: "{\"command\":",
      }),
      frame("response.function_call_arguments.delta", {
        output_index: 2,
        item_id: "fc_1",
        delta: "\"pwd\"}",
      }),
      frame("response.function_call_arguments.done", {
        output_index: 2,
        item_id: "fc_1",
        arguments: "{\"command\":\"pwd\"}",
      }),
      frame("response.completed", {
        response: {
          id: "resp_1",
          model: "deepseek-v4-flash",
          status: "completed",
          output: [],
          usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 3 }, output_tokens: 8 },
        },
      }),
    ].join("");

    const bytes = encoder.encode(input);
    const split = 37;
    const output = convertResponsesSseBytesToAnthropic([
      bytes.slice(0, split),
      bytes.slice(split, split + 19),
      bytes.slice(split + 19),
    ]);
    const events = parseAnthropic(decoder.decode(output));

    expect(events[0]).toMatchObject({
      type: "message_start",
      message: {
        id: "resp_1",
        type: "message",
        role: "assistant",
        model: "deepseek-v4-flash",
        content: [],
        usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 3 },
      },
    });
    expect(events.filter((event) => event.type === "content_block_start")).toEqual([
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "rs_1" } },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call_1", name: "Bash", input: {} } },
    ]);
    expect(events.filter((event) => event.type === "content_block_delta")).toEqual([
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hello" } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"command\":" } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "\"pwd\"}" } },
    ]);
    expect(events.at(-2)).toEqual({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 8 },
    });
    expect(events.at(-1)).toEqual({ type: "message_stop" });
  });

  it("streams through a TransformStream without buffering the complete response", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame("response.created", { response: { id: "r", model: "m" } })));
        controller.enqueue(encoder.encode(frame("response.output_text.delta", { output_index: 0, item_id: "m", delta: "hi" })));
        controller.enqueue(encoder.encode(frame("response.completed", { response: { id: "r", model: "m", usage: { output_tokens: 1 } } })));
        controller.close();
      },
    }).pipeThrough(createResponsesToAnthropicSseTransform());

    const text = await new Response(stream).text();
    expect(parseAnthropic(text).map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  it("fails on an interrupted stream instead of fabricating message_stop", () => {
    expect(() => convertResponsesSseBytesToAnthropic([
      encoder.encode(frame("response.created", { response: { id: "r", model: "m" } })),
    ])).toThrow(ResponsesAnthropicStreamError);
  });

  it.each(["web_search_call", "future_provider_call"])(
    "rejects Responses-only output item %s instead of silently dropping it",
    (type) => {
      expect(() => convertResponsesSseBytesToAnthropic([encoder.encode([
        frame("response.created", { response: { id: "r", model: "m" } }),
        frame("response.output_item.added", {
          output_index: 0,
          item: { type, id: "provider_1", status: "in_progress" },
        }),
      ].join(""))])).toThrow(/cannot be represented/);
    },
  );

  it("converts a non-streaming Responses object to an Anthropic message", () => {
    expect(convertResponsesJsonToAnthropic({
      id: "resp_2",
      model: "deepseek-v4-pro",
      status: "completed",
      output: [
        { type: "reasoning", id: "rs_2", content: [{ type: "reasoning_text", text: "why" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        { type: "function_call", call_id: "call_2", name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
      ],
      usage: {
        input_tokens: 20,
        input_tokens_details: { cached_tokens: 5 },
        output_tokens: 9,
      },
    })).toEqual({
      id: "resp_2",
      type: "message",
      role: "assistant",
      model: "deepseek-v4-pro",
      content: [
        { type: "thinking", thinking: "why", signature: "rs_2" },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "call_2", name: "Read", input: { path: "/tmp/a" } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 5 },
    });
  });
});
