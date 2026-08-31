import { describe, expect, it } from "vitest";

import type { AgentContextMetadata } from "../../types.js";
import { ResponsesAdapter } from "../responses.js";

const metadata: AgentContextMetadata = {
  protocol: "responses",
  traceId: "responses-trace",
  keyId: "responses-key",
  modelId: "gpt-5",
  stream: true,
  agentSource: "codex",
};

describe("ResponsesAdapter", () => {
  it("round-trips instructions, input items, flat function tools, and provider tools", () => {
    const body = {
      model: "gpt-5",
      stream: true,
      instructions: "You are Codex.",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "opaque" }] },
        { type: "function_call_output", call_id: "call_old", output: "done" },
      ],
      tools: [
        {
          type: "function",
          name: "client_shell",
          description: "Run shell",
          parameters: { type: "object", properties: { command: { type: "string" } } },
          strict: true,
        },
        { type: "web_search_preview", search_context_size: "medium" },
      ],
      reasoning: { effort: "medium", summary: "auto" },
    };

    const adapter = new ResponsesAdapter();
    expect(adapter.serialize(adapter.parse(body, metadata))).toEqual(body);
  });

  it("serializes injected tools with the flat Responses function schema", () => {
    const adapter = new ResponsesAdapter();
    const context = adapter.parse({
      model: "gpt-5",
      stream: true,
      input: "remember this",
      tools: [{ type: "web_search_preview" }],
    }, metadata);
    context.tools?.push({
      name: "tdai_memory_search",
      description: "Search memory",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    });

    expect(adapter.serialize(context).tools).toEqual([
      { type: "web_search_preview" },
      {
        type: "function",
        name: "tdai_memory_search",
        description: "Search memory",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        strict: true,
      },
    ]);
  });

  it("applies prompt injection to instructions without changing opaque input items", () => {
    const adapter = new ResponsesAdapter();
    const context = adapter.parse({
      instructions: "base",
      input: [
        { role: "user", content: "question" },
        { type: "computer_call", id: "provider_1", action: { type: "screenshot" } },
      ],
    }, metadata);
    const system = context.messages.find((message) => message.role === "system");
    system?.blocks.push({ type: "text", content: "injected" });

    expect(adapter.serialize(context)).toMatchObject({
      instructions: "base\ninjected",
      input: [
        { role: "user", content: "question" },
        { type: "computer_call", id: "provider_1", action: { type: "screenshot" } },
      ],
    });
  });
});
