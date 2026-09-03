import { describe, expect, it } from "vitest";

import { AnthropicStreamParser } from "../../injection/adapters/anthropic-stream.js";
import type { ToolCallSlot } from "../types.js";
import {
  buildClientVisibleAnthropicSse,
  buildFullAssistantMessage,
  buildToolResultMessage,
  replayAnthropicBytes,
} from "../anthropic-response-rebuilder.js";
import { createDefaultNativeProxyToolRegistry } from "../tool-registry.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function messageStart(lineEnding = "\n"): Uint8Array {
  return frame("message_start", {
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
  }, lineEnding);
}

function blockStart(index: number, contentBlock: Record<string, unknown>): Uint8Array {
  return frame("content_block_start", {
    type: "content_block_start",
    index,
    content_block: contentBlock,
  });
}

function blockDelta(index: number, delta: Record<string, unknown>): Uint8Array {
  return frame("content_block_delta", {
    type: "content_block_delta",
    index,
    delta,
  });
}

function blockStop(index: number): Uint8Array {
  return frame("content_block_stop", { type: "content_block_stop", index });
}

function messageEnd(lineEnding = "\n"): Uint8Array {
  return concat(
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 20 },
    }, lineEnding),
    frame("message_stop", { type: "message_stop" }, lineEnding),
  );
}

function parse(bytes: Uint8Array, finish = true) {
  const parser = new AnthropicStreamParser(createDefaultNativeProxyToolRegistry());
  parser.push(bytes);
  if (finish) parser.finish();
  return parser.snapshot();
}

function clientOnlyFixture(): Uint8Array {
  return concat(
    encoder.encode(": keep-alive\r\n\r\n"),
    messageStart("\r\n"),
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "client-1", name: "client_shell", input: {} },
    }, "\r\n"),
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{\"command\":\"pwd\"}" },
    }, "\r\n"),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }, "\r\n"),
    messageEnd("\r\n"),
  );
}

function mixedFixture(): Uint8Array {
  return concat(
    encoder.encode(": upstream-comment\n\n"),
    messageStart(),
    blockStart(0, { type: "tool_use", id: "proxy-call-1", name: "tdai_memory_search", input: {} }),
    blockDelta(0, { type: "input_json_delta", partial_json: "{\"query\":\"rules\"}" }),
    blockStop(0),
    blockStart(1, { type: "thinking", thinking: "", signature: "" }),
    blockDelta(1, { type: "thinking_delta", thinking: "reason" }),
    blockDelta(1, { type: "signature_delta", signature: "signed" }),
    blockStop(1),
    encoder.encode("event: ping\ndata: {\"type\":\"ping\"}\n\n"),
    blockStart(2, { type: "tool_use", id: "client-call-1", name: "client_shell", input: {} }),
    blockDelta(2, { type: "input_json_delta", partial_json: "{\"command\":\"pwd\"}" }),
    blockStop(2),
    blockStart(3, { type: "tool_use", id: "proxy-call-2", name: "tdai_memory_search", input: {} }),
    blockDelta(3, { type: "input_json_delta", partial_json: "{\"query\":\"identity\"}" }),
    blockStop(3),
    blockStart(4, { type: "web_search_tool_result", tool_use_id: "provider-1", content: [] }),
    blockDelta(4, { type: "future_provider_delta", payload: { opaque: true } }),
    blockStop(4),
    messageEnd(),
  );
}

function lifecycleIndexes(sse: string): number[] {
  return sse
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    .filter((payload) => typeof payload.type === "string" && payload.type.startsWith("content_block_"))
    .map((payload) => payload.index as number);
}

describe("Anthropic response rebuilder", () => {
  it("replays a pure Client Tool response byte for byte", () => {
    const fixture = clientOnlyFixture();
    const replayed = replayAnthropicBytes(parse(fixture));

    expect(replayed).toEqual(fixture);
  });

  it("removes every Native frame and remaps visible indexes", () => {
    const output = decoder.decode(buildClientVisibleAnthropicSse(
      parse(mixedFixture()),
      new Set([0, 3]),
    ));

    expect(output).not.toContain("tdai_memory_search");
    expect(output).not.toContain("proxy-call-1");
    expect(output).not.toContain("proxy-call-2");
    expect(output).toContain("client-call-1");
    expect(output).toContain("thinking_delta");
    expect(output).toContain("signature_delta");
    expect(output).toContain("future_provider_delta");
    expect(output).toContain(": upstream-comment");
    expect(output).toContain("event: ping");
    expect(lifecycleIndexes(output)).toEqual([
      0, 0, 0, 0,
      1, 1, 1,
      2, 2, 2,
    ]);
  });

  it("filters by content block ownership rather than matching tool names", () => {
    const fixture = concat(
      messageStart(),
      blockStart(0, { type: "tool_use", id: "native-a", name: "tdai_memory_search", input: {} }),
      blockDelta(0, { type: "input_json_delta", partial_json: "{\"query\":\"a\"}" }),
      blockStop(0),
      blockStart(1, { type: "tool_use", id: "native-b", name: "tdai_memory_search", input: {} }),
      blockDelta(1, { type: "input_json_delta", partial_json: "{\"query\":\"b\"}" }),
      blockStop(1),
      blockStart(2, { type: "tool_use", id: "client-visible", name: "client_tool", input: {} }),
      blockStop(2),
      messageEnd(),
    );

    const output = decoder.decode(buildClientVisibleAnthropicSse(parse(fixture), new Set([0, 1])));
    expect(output).not.toContain("native-a");
    expect(output).not.toContain("native-b");
    expect(output).toContain("client-visible");
    expect(lifecycleIndexes(output)).toEqual([0, 0]);
  });

  it("reconstructs the complete assistant message including opaque Provider blocks", () => {
    const message = buildFullAssistantMessage(parse(mixedFixture()));

    expect(message).toEqual({
      role: "assistant",
      content: [
        { type: "tool_use", id: "proxy-call-1", name: "tdai_memory_search", input: { query: "rules" } },
        { type: "thinking", thinking: "reason", signature: "signed" },
        { type: "tool_use", id: "client-call-1", name: "client_shell", input: { command: "pwd" } },
        { type: "tool_use", id: "proxy-call-2", name: "tdai_memory_search", input: { query: "identity" } },
        { type: "web_search_tool_result", tool_use_id: "provider-1", content: [] },
      ],
    });
  });

  it("builds ordered Anthropic tool results independent of completion order", () => {
    const slots: ToolCallSlot[] = [
      {
        callId: "proxy-2",
        slotIndex: 3,
        contentBlockIndex: 7,
        toolName: "tdai_memory_search",
        owner: "proxy",
        input: { query: "second" },
        argumentsComplete: true,
        status: "succeeded",
        executionAttempt: 1,
        result: { memories: ["second"] },
        isError: false,
      },
      {
        callId: "client-1",
        slotIndex: 1,
        contentBlockIndex: 2,
        toolName: "client_shell",
        owner: "client",
        input: { command: "pwd" },
        argumentsComplete: true,
        status: "failed",
        executionAttempt: 0,
        result: { error: "denied" },
        isError: true,
      },
    ];

    expect(buildToolResultMessage(slots)).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "client-1",
          content: "{\"error\":\"denied\"}",
          is_error: true,
        },
        {
          type: "tool_result",
          tool_use_id: "proxy-2",
          content: "{\"memories\":[\"second\"]}",
        },
      ],
    });
  });

  it("rejects replay and reconstruction before message_stop", () => {
    const incomplete = parse(concat(
      messageStart(),
      blockStart(0, { type: "text", text: "" }),
      blockDelta(0, { type: "text_delta", text: "partial" }),
    ));

    expect(() => replayAnthropicBytes(incomplete)).toThrow(/message_stop/);
    expect(() => buildClientVisibleAnthropicSse(incomplete, new Set())).toThrow(/message_stop/);
    expect(() => buildFullAssistantMessage(incomplete)).toThrow(/message_stop/);
  });

  it("filters by Tool Call position without rewriting unrelated Provider frames", () => {
    const fixture = concat(
      messageStart(),
      blockStart(0, { type: "tool_use", id: "native-secret", name: "tdai_memory_search", input: {} }),
      blockDelta(0, { type: "input_json_delta", partial_json: "{\"query\":\"private-rule\"}" }),
      blockStop(0),
      frame("ping", { type: "ping", provider_trace: "native-secret" }),
      messageEnd(),
    );

    const visible = decoder.decode(buildClientVisibleAnthropicSse(parse(fixture), new Set([0])));
    expect(visible).not.toContain('"type":"tool_use"');
    expect(visible).toContain('"type":"ping"');
    expect(visible).toContain('"provider_trace":"native-secret"');
  });
});
