import { describe, expect, it } from "vitest";

import {
  AnthropicResponsesConversionError,
  convertAnthropicRequestToResponses,
} from "../anthropic-responses-request.js";

describe("Anthropic to Responses request conversion", () => {
  it("converts messages, tool history, tool schemas, and request controls without Anthropic fields", () => {
    const converted = convertAnthropicRequestToResponses({
      model: "deepseek-v4-flash",
      stream: true,
      max_tokens: 4096,
      temperature: 0.2,
      system: [
        { type: "text", text: "base", cache_control: { type: "ephemeral" } },
        { type: "text", text: "memory" },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            { type: "tool_use", id: "call_1", name: "Bash", input: { command: "pwd" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: "ok" },
            { type: "text", text: "continue" },
          ],
        },
      ],
      tools: [{
        name: "Bash",
        description: "Run a command",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
        cache_control: { type: "ephemeral" },
      }],
      tool_choice: { type: "tool", name: "Bash" },
    });

    expect(converted).toEqual({
      model: "deepseek-v4-flash",
      stream: true,
      max_output_tokens: 4096,
      temperature: 0.2,
      instructions: "base\nmemory",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "inspect" },
            { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
          ],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "calling" }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "Bash",
          arguments: "{\"command\":\"pwd\"}",
        },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "continue" }],
        },
      ],
      tools: [{
        type: "function",
        name: "Bash",
        description: "Run a command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      }],
      tool_choice: { type: "function", name: "Bash" },
    });
  });

  it("maps Anthropic thinking history and tool errors into Responses input items", () => {
    expect(convertAnthropicRequestToResponses({
      model: "deepseek-v4-flash",
      thinking: { type: "enabled", budget_tokens: 2048 },
      messages: [
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "reason", signature: "rs_1" }],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "call_1",
            is_error: true,
            content: [{ type: "text", text: "failed" }],
          }],
        },
      ],
    })).toMatchObject({
      reasoning: { effort: "high" },
      input: [
        {
          type: "reasoning",
          id: "rs_1",
          content: [{ type: "reasoning_text", text: "reason" }],
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "{\"is_error\":true,\"content\":\"failed\"}",
        },
      ],
    });
  });

  it("fails closed for blocks that cannot be represented by the Responses upstream", () => {
    expect(() => convertAnthropicRequestToResponses({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: [{ type: "document", source: { type: "text", data: "x" } }] }],
    })).toThrow(AnthropicResponsesConversionError);
  });

  it.each(["stop_sequences", "top_k"])(
    "fails closed instead of silently dropping unsupported %s",
    (field) => {
      expect(() => convertAnthropicRequestToResponses({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hello" }],
        [field]: field === "stop_sequences" ? ["done"] : 5,
      })).toThrow(new RegExp(field));
    },
  );
});
