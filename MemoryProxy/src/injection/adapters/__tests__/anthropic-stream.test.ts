import { describe, expect, it } from "vitest";

import { createDefaultNativeProxyToolRegistry } from "../../../native-proxy-tools/tool-registry.js";
import { AnthropicAdapter } from "../anthropic.js";
import {
  AnthropicStreamParser,
  type AnthropicStreamSnapshot,
} from "../anthropic-stream.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const registry = createDefaultNativeProxyToolRegistry();

function frame(
  event: string,
  payload: Record<string, unknown>,
  lineEnding = "\n",
): Uint8Array {
  return encoder.encode(
    `event: ${event}${lineEnding}data: ${JSON.stringify(payload)}${lineEnding}${lineEnding}`,
  );
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function toolStart(index: number, id: string, name: string): Uint8Array {
  return frame("content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name, input: {} },
  });
}

function inputDelta(index: number, partialJson: string): Uint8Array {
  return frame("content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partialJson },
  });
}

function blockStop(index: number): Uint8Array {
  return frame("content_block_stop", { type: "content_block_stop", index });
}

function messageStop(): Uint8Array {
  return frame("message_stop", { type: "message_stop" });
}

function complete(parser: AnthropicStreamParser, bytes: Uint8Array): AnthropicStreamSnapshot {
  parser.push(bytes);
  parser.finish();
  return parser.snapshot();
}

describe("AnthropicStreamParser", () => {
  it("waits for content_block_stop before completing fragmented tool input", () => {
    const parser = new AnthropicStreamParser(registry);

    expect(parser.push(toolStart(0, "p1", "tdai_memory_search"))).not.toContainEqual(
      expect.objectContaining({ type: "tool_call_completed" }),
    );
    expect(parser.push(inputDelta(0, "{\"query\":\"old"))).not.toContainEqual(
      expect.objectContaining({ type: "tool_call_completed" }),
    );
    expect(parser.push(inputDelta(0, " rules\"}"))).not.toContainEqual(
      expect.objectContaining({ type: "tool_call_completed" }),
    );

    expect(parser.push(blockStop(0))).toContainEqual(expect.objectContaining({
      type: "tool_call_completed",
      call: expect.objectContaining({
        callId: "p1",
        toolName: "tdai_memory_search",
        owner: "proxy",
        contentBlockIndex: 0,
        input: { query: "old rules" },
      }),
    }));
  });

  it("decodes UTF-8 split across chunks and accepts CRLF plus multi-line data", () => {
    const parser = new AnthropicStreamParser(registry);
    parser.push(frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }, "\r\n"));

    const deltaText = [
      "event: content_block_delta\r\n",
      "data: {\"type\":\"content_block_delta\",\r\n",
      "data: \"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"中文记忆\"}}\r\n",
      "\r\n",
    ].join("");
    const deltaBytes = encoder.encode(deltaText);
    const firstChineseByte = deltaBytes.findIndex((value) => value >= 0xe0);
    expect(firstChineseByte).toBeGreaterThan(0);

    expect(parser.push(deltaBytes.slice(0, firstChineseByte + 1))).toEqual([]);
    const events = parser.push(deltaBytes.slice(firstChineseByte + 1));
    expect(events).toContainEqual(expect.objectContaining({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "中文记忆" },
    }));
    parser.push(frame("content_block_stop", {
      type: "content_block_stop",
      index: 0,
    }, "\r\n"));
    parser.push(frame("message_stop", { type: "message_stop" }, "\r\n"));
    parser.finish();

    expect(parser.snapshot().blocks).toEqual([
      expect.objectContaining({
        index: 0,
        completed: true,
        block: { type: "text", text: "中文记忆" },
      }),
    ]);
  });

  it("assembles text and thinking while preserving opaque Provider deltas", () => {
    const parser = new AnthropicStreamParser(registry);
    const bytes = concat(
      frame("message_start", {
        type: "message_start",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      }),
      frame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "answer" },
      }),
      blockStop(0),
      frame("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "thinking", thinking: "", signature: "" },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "thinking_delta", thinking: "reason" },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "signature_delta", signature: "signed" },
      }),
      blockStop(1),
      frame("content_block_start", {
        type: "content_block_start",
        index: 2,
        content_block: { type: "web_search_tool_result", tool_use_id: "srv-1", content: [] },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 2,
        delta: { type: "future_provider_delta", payload: { opaque: true } },
      }),
      blockStop(2),
      frame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 7 },
      }),
      messageStop(),
    );

    const snapshot = complete(parser, bytes);

    expect(snapshot.messageCompleted).toBe(true);
    expect(snapshot.stopReason).toBe("end_turn");
    expect(snapshot.usage).toEqual({ input_tokens: 10, output_tokens: 7 });
    expect(snapshot.blocks).toEqual([
      expect.objectContaining({ block: { type: "text", text: "answer" } }),
      expect.objectContaining({
        block: { type: "thinking", thinking: "reason", signature: "signed" },
      }),
      expect.objectContaining({
        block: { type: "web_search_tool_result", tool_use_id: "srv-1", content: [] },
        opaqueDeltas: [{ type: "future_provider_delta", payload: { opaque: true } }],
      }),
    ]);
  });

  it("classifies unowned tool_use blocks as Client Tools in generation order", () => {
    const parser = new AnthropicStreamParser(registry);

    parser.push(toolStart(3, "c1", "client_shell"));
    parser.push(inputDelta(3, "{\"command\":\"pwd\"}"));
    const clientEvents = parser.push(blockStop(3));
    parser.push(toolStart(5, "p1", "tdai_memory_search"));
    parser.push(inputDelta(5, "{\"query\":\"rules\"}"));
    const proxyEvents = parser.push(blockStop(5));

    expect(clientEvents).toContainEqual(expect.objectContaining({
      type: "tool_call_completed",
      call: expect.objectContaining({ callId: "c1", owner: "client", slotIndex: 0 }),
    }));
    expect(proxyEvents).toContainEqual(expect.objectContaining({
      type: "tool_call_completed",
      call: expect.objectContaining({ callId: "p1", owner: "proxy", slotIndex: 1 }),
    }));
  });

  it("reports malformed tool JSON only when its block stops", () => {
    const parser = new AnthropicStreamParser(registry);
    parser.push(toolStart(0, "p-bad", "tdai_memory_search"));
    const deltaEvents = parser.push(inputDelta(0, "{\"query\":"));
    expect(deltaEvents).not.toContainEqual(expect.objectContaining({ type: "protocol_error" }));

    const stopEvents = parser.push(blockStop(0));
    expect(stopEvents).toContainEqual(expect.objectContaining({
      type: "tool_call_completed",
      call: expect.objectContaining({
        callId: "p-bad",
        owner: "proxy",
        parseError: {
          code: "invalid_tool_input_json",
          message: "Tool input is not valid JSON",
        },
      }),
    }));
  });

  it("keeps original bytes and frame metadata for safe replay", () => {
    const original = concat(
      encoder.encode(": keep-alive\n\n"),
      frame("message_start", {
        type: "message_start",
        message: { id: "msg-raw", content: [], usage: {} },
      }),
      messageStop(),
    );
    const snapshot = complete(new AnthropicStreamParser(registry), original);

    expect(snapshot.rawBytes).toEqual(original);
    expect(decoder.decode(snapshot.rawBytes)).toBe(decoder.decode(original));
    expect(snapshot.frames[0]).not.toHaveProperty("event");
    expect(snapshot.frames[0]).not.toHaveProperty("data");
    expect(snapshot.frames[1]).toMatchObject({ event: "message_start" });
  });

  it("emits protocol errors for malformed SSE JSON and incomplete EOF", () => {
    const parser = new AnthropicStreamParser(registry);
    const malformed = parser.push(encoder.encode(
      "event: content_block_delta\ndata: {not-json}\n\n",
    ));
    expect(malformed).toContainEqual(expect.objectContaining({
      type: "protocol_error",
      code: "malformed_sse_json",
    }));

    parser.push(frame("message_start", {
      type: "message_start",
      message: { id: "msg-incomplete", content: [], usage: {} },
    }));
    expect(parser.finish()).toContainEqual({
      type: "protocol_error",
      code: "unexpected_eof",
      message: "Anthropic stream ended before message_stop",
    });
    expect(parser.snapshot().messageCompleted).toBe(false);
  });

  it("rejects message_stop while a content block is still open", () => {
    const parser = new AnthropicStreamParser(registry);
    parser.push(toolStart(4, "p-open", "tdai_memory_search"));

    expect(parser.push(messageStop())).toContainEqual({
      type: "protocol_error",
      code: "incomplete_content_block",
      message: "Anthropic message_stop arrived with open content blocks: 4",
    });
  });

  it("is exposed by the existing Anthropic request adapter", () => {
    const parser = new AnthropicAdapter().createStreamParser(registry);
    parser.push(messageStop());
    parser.finish();

    expect(parser.snapshot().messageCompleted).toBe(true);
  });
});
