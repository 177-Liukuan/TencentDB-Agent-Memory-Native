import { describe, expect, it } from "vitest";

import { createDefaultNativeProxyToolRegistry } from "../../../native-proxy-tools/tool-registry.js";
import { OpenAIAdapter } from "../openai.js";

const encoder = new TextEncoder();

function data(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`);
}

describe("OpenAI Chat Completions stream parser", () => {
  it("collects interleaved function calls and completes them only at the round boundary", () => {
    const parser = new OpenAIAdapter().createStreamParser!(createDefaultNativeProxyToolRegistry());

    const first = parser.push(data({
      id: "chat-1",
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: [
        { index: 0, id: "proxy-1", type: "function", function: { name: "tdai_memory_search", arguments: "{\"query\":" } },
        { index: 1, id: "client-1", type: "function", function: { name: "client_shell", arguments: "{\"command\":" } },
      ] }, finish_reason: null }],
    }));
    expect(first.some((event) => event.type === "tool_call_completed")).toBe(false);

    parser.push(data({
      id: "chat-1",
      choices: [{ index: 0, delta: { tool_calls: [
        { index: 1, function: { arguments: "\"pwd\"}" } },
        { index: 0, function: { arguments: "\"rules\"}" } },
      ] }, finish_reason: null }],
    }));
    const completed = parser.push(data({
      id: "chat-1",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    }));

    expect(completed.filter((event) => event.type === "tool_call_completed")).toMatchObject([
      { call: { callId: "proxy-1", toolName: "tdai_memory_search", owner: "proxy", slotIndex: 0, input: { query: "rules" } } },
      { call: { callId: "client-1", toolName: "client_shell", owner: "client", slotIndex: 1, input: { command: "pwd" } } },
    ]);
    expect(completed.at(-1)).toMatchObject({ type: "message_completed", stopReason: "tool_calls" });
  });

  it("preserves provider tool protocol chunks without creating Proxy or Client slots", () => {
    const parser = new OpenAIAdapter().createStreamParser!(createDefaultNativeProxyToolRegistry());
    const provider = data({
      id: "chat-provider",
      choices: [{ index: 0, delta: {
        provider_tool: { type: "web_search", id: "srv-1", status: "completed", result: { answer: "opaque" } },
      }, finish_reason: null }],
    });

    const events = parser.push(provider);
    parser.push(data({ id: "chat-provider", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
    parser.push(data("[DONE]"));

    expect(events.some((event) => event.type === "tool_call_completed")).toBe(false);
    expect(parser.snapshot().rawBytes).toEqual(new Uint8Array([
      ...provider,
      ...data({ id: "chat-provider", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      ...data("[DONE]"),
    ]));
    expect(parser.snapshot()).toMatchObject({
      assistantContent: null,
      assistantExtras: {
        provider_tool: { type: "web_search", id: "srv-1", status: "completed", result: { answer: "opaque" } },
      },
    });
  });

  it("retains assistant text and reasoning beside a function call for later history restoration", () => {
    const parser = new OpenAIAdapter().createStreamParser!(createDefaultNativeProxyToolRegistry());
    parser.push(data({ choices: [{ index: 0, delta: {
      role: "assistant", content: "checking ", reasoning_content: "think ",
      tool_calls: [{ index: 0, id: "proxy-1", type: "function", function: { name: "tdai_memory_search", arguments: "{}" } }],
    }, finish_reason: null }] }));
    parser.push(data({ choices: [{ index: 0, delta: { content: "now", reasoning_content: "again" }, finish_reason: "tool_calls" }] }));

    expect(parser.snapshot()).toMatchObject({
      assistantContent: "checking now",
      assistantExtras: { reasoning_content: "think again" },
    });
  });

  it("reports malformed function arguments at the conservative round boundary", () => {
    const parser = new OpenAIAdapter().createStreamParser!(createDefaultNativeProxyToolRegistry());
    parser.push(data({
      choices: [{ index: 0, delta: { tool_calls: [{
        index: 0,
        id: "bad-1",
        type: "function",
        function: { name: "tdai_memory_search", arguments: "{" },
      }] }, finish_reason: null }],
    }));
    const events = parser.push(data({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_call_completed",
      call: expect.objectContaining({
        callId: "bad-1",
        parseError: { code: "invalid_tool_input_json", message: "Tool input is not valid JSON" },
      }),
    }));
  });
});
