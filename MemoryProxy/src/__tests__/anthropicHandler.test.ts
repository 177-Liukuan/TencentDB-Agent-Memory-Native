import { describe, expect, it } from "vitest";

import {
  buildRetryBody,
  buildUpstreamBody,
  sanitizeThinkingBlocks,
} from "../anthropicHandler.js";

const passthroughTarget = {
  url: "https://api.deepseek.com/anthropic",
  model: "deepseek-v4-pro",
  authHeaders: null,
  bodyOverrides: null,
  retryTarget: null,
  turnSeq: 0,
  routedFrom: "",
};

describe("sanitizeThinkingBlocks", () => {
  it("preserves provider-owned thinking blocks without validating signatures", () => {
    const body: Record<string, unknown> = {
      model: "test-model",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "provider-owned reasoning",
              signature: "provider-specific-signature",
            },
            {
              type: "redacted_thinking",
              data: "provider-owned-redacted-payload",
            },
            {
              type: "tool_use",
              id: "tool-1",
              name: "get_weather",
              input: { city: "Shenzhen" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "sunny",
            },
          ],
        },
      ],
    };

    const result = sanitizeThinkingBlocks(body);

    expect(result.removed).toBe(0);
    expect(result.body).toBe(body);
  });
});

describe("Anthropic upstream session-init cleanup", () => {
  it("strips the same artifacts on first forwarding and retry without mutating the source body", () => {
    const body: Record<string, unknown> = {
      model: "deepseek-v4-pro",
      thinking: { type: "enabled", budget_tokens: 4096 },
      system: [{ type: "text", text: "<session_context>agent prompt</session_context>" }],
      messages: [
        { role: "user", content: "original request" },
        {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "toolu_cc_session_init_agent",
            name: "AskUserQuestion",
            input: {},
          }],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_cc_session_init_agent",
            content: "agent-a",
          }],
        },
      ],
      tools: [{
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 5,
      }],
    };
    const snapshot = structuredClone(body);
    const expectedMessages = [{ role: "user", content: "original request" }];

    const first = buildUpstreamBody(body, passthroughTarget).body;
    const retry = buildRetryBody(body);

    expect(first.messages).toEqual(expectedMessages);
    expect(retry.messages).toEqual(expectedMessages);
    expect(first.system).toEqual(body.system);
    expect(retry.system).toEqual(body.system);
    expect(first.tools).toEqual(body.tools);
    expect(retry.tools).toEqual(body.tools);
    expect(first.thinking).toEqual(body.thinking);
    expect(retry.thinking).toEqual(body.thinking);
    expect(body).toEqual(snapshot);
  });

  it("keeps body overrides while stripping only session-init artifacts", () => {
    const body: Record<string, unknown> = {
      model: "original-model",
      messages: [
        {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "toolu_cc_session_init_task",
            name: "AskUserQuestion",
            input: {},
          }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_cc_session_init_task",
              content: "task-a",
            },
            { type: "text", text: "original request" },
          ],
        },
      ],
    };

    const result = buildUpstreamBody(body, {
      ...passthroughTarget,
      bodyOverrides: { model: "routed-model", max_tokens: 8192 },
    }).body;

    expect(result).toEqual({
      model: "routed-model",
      max_tokens: 8192,
      messages: [{
        role: "user",
        content: [{ type: "text", text: "original request" }],
      }],
    });
  });
});
