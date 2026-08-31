import { describe, expect, it } from "vitest";

import { buildClientVisibleOpenAISse, buildOpenAIToolMessages } from "../openai-response-rebuilder.js";
import type { ToolCallSlot } from "../types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("OpenAI response rebuilding", () => {
  it("removes only Proxy function-call deltas and preserves Provider blocks byte-semantically", () => {
    const provider = { type: "web_search", id: "provider-1", status: "completed", result: { answer: "opaque" } };
    const bytes = encoder.encode([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { provider_tool: provider, tool_calls: [
        { index: 0, id: "proxy-1", type: "function", function: { name: "tdai_memory_search", arguments: "{}" } },
        { index: 1, id: "client-1", type: "function", function: { name: "client_shell", arguments: "{}" } },
      ] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""));

    const visible = decoder.decode(buildClientVisibleOpenAISse(bytes, new Set([0])));

    expect(visible).not.toContain("tdai_memory_search");
    expect(visible).not.toContain("proxy-1");
    expect(visible).toContain("client_shell");
    expect(visible).toContain(JSON.stringify(provider).slice(1, -1));
    expect(visible).toContain("[DONE]");
  });

  it("builds ordered assistant and per-call tool messages", () => {
    const slots: ToolCallSlot[] = [
      { callId: "p1", slotIndex: 0, contentBlockIndex: 0, toolName: "tdai_memory_search", owner: "proxy", input: { query: "x" }, argumentsComplete: true, status: "succeeded", executionAttempt: 1, result: { hits: [] }, isError: false },
      { callId: "c1", slotIndex: 1, contentBlockIndex: 1, toolName: "client_shell", owner: "client", input: { command: "pwd" }, argumentsComplete: true, status: "failed", executionAttempt: 0, result: "denied", isError: true },
    ];

    expect(buildOpenAIToolMessages(slots)).toEqual([
      { role: "assistant", content: null, tool_calls: [
        { id: "p1", type: "function", function: { name: "tdai_memory_search", arguments: "{\"query\":\"x\"}" } },
        { id: "c1", type: "function", function: { name: "client_shell", arguments: "{\"command\":\"pwd\"}" } },
      ] },
      { role: "tool", tool_call_id: "p1", content: "{\"hits\":[]}" },
      { role: "tool", tool_call_id: "c1", content: "denied" },
    ]);
  });
});
