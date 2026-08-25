import { describe, expect, it } from "vitest";

import { buildFormResponse, stripSessionInitArtifacts } from "../form.js";

describe("buildFormResponse", () => {
  it("keeps the existing AskUserQuestion asset-selection form contract", async () => {
    const response = buildFormResponse({
      teams: [],
      stage: "asset_confirm",
      stream: true,
      modelId: "deepseek-v4-pro",
    });

    const sse = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(sse).toContain('"name":"AskUserQuestion"');
    expect(sse).toContain("是，关联团队资产");
    expect(sse).toContain("否，本次不关联");
    expect(sse).toContain('"stop_reason":"tool_use"');
  });
});

describe("stripSessionInitArtifacts", () => {
  it("removes paired session-init tool_use and tool_result artifacts", () => {
    const messages: Record<string, unknown>[] = [
      { role: "user", content: "original request" },
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "toolu_cc_session_init_asset_confirm",
          name: "AskUserQuestion",
          input: { questions: [] },
        }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_cc_session_init_asset_confirm",
          content: "yes",
        }],
      },
    ];
    const snapshot = structuredClone(messages);

    const result = stripSessionInitArtifacts(messages);

    expect(result.messages).toEqual([{ role: "user", content: "original request" }]);
    expect(result.removed).toBe(2);
    expect(messages).toEqual(snapshot);
  });

  it("keeps real user text when it shares a message with a session-init tool_result", () => {
    const userText = { type: "text", text: "original request" };
    const messages: Record<string, unknown>[] = [
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "toolu_cc_session_init_team",
          name: "AskUserQuestion",
          input: {},
        }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_cc_session_init_team",
            content: "team-a",
          },
          userText,
        ],
      },
    ];

    const result = stripSessionInitArtifacts(messages);

    expect(result.messages).toEqual([{ role: "user", content: [userText] }]);
    expect((result.messages[0].content as unknown[])[0]).toBe(userText);
  });

  it("preserves genuine thinking, redacted thinking, and ordinary tool calls exactly", () => {
    const thinking = {
      type: "thinking",
      thinking: "provider reasoning",
      signature: "opaque-provider-signature",
    };
    const redactedThinking = {
      type: "redacted_thinking",
      data: "opaque-redacted-payload",
    };
    const ordinaryTool = {
      type: "tool_use",
      id: "toolu_real_weather",
      name: "get_weather",
      input: { city: "Shenzhen" },
    };
    const ordinaryResult = {
      type: "tool_result",
      tool_use_id: "toolu_real_weather",
      content: "sunny",
    };
    const messages: Record<string, unknown>[] = [
      { role: "assistant", content: [thinking, redactedThinking, ordinaryTool] },
      { role: "user", content: [ordinaryResult] },
    ];

    const result = stripSessionInitArtifacts(messages);

    expect(result.removed).toBe(0);
    expect(result.messages).toBe(messages);
    expect((result.messages[0].content as unknown[])[0]).toBe(thinking);
    expect((result.messages[0].content as unknown[])[1]).toBe(redactedThinking);
    expect((result.messages[0].content as unknown[])[2]).toBe(ordinaryTool);
    expect((result.messages[1].content as unknown[])[0]).toBe(ordinaryResult);
  });

  it("removes only the fake blocks when real thinking and tools share the same messages", () => {
    const thinking = {
      type: "thinking",
      thinking: "provider reasoning",
      signature: "opaque-provider-signature",
    };
    const ordinaryTool = {
      type: "tool_use",
      id: "toolu_real_weather",
      name: "get_weather",
      input: { city: "Shenzhen" },
    };
    const ordinaryResult = {
      type: "tool_result",
      tool_use_id: "toolu_real_weather",
      content: "sunny",
    };
    const userText = { type: "text", text: "continue with my original request" };
    const messages: Record<string, unknown>[] = [
      {
        role: "assistant",
        content: [
          thinking,
          {
            type: "tool_use",
            id: "toolu_cc_session_init_task",
            name: "AskUserQuestion",
            input: {},
          },
          ordinaryTool,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_cc_session_init_task",
            content: "task-a",
          },
          ordinaryResult,
          userText,
        ],
      },
    ];

    const result = stripSessionInitArtifacts(messages);

    expect(result.messages).toEqual([
      { role: "assistant", content: [thinking, ordinaryTool] },
      { role: "user", content: [ordinaryResult, userText] },
    ]);
    expect((result.messages[0].content as unknown[])[0]).toBe(thinking);
    expect((result.messages[0].content as unknown[])[1]).toBe(ordinaryTool);
    expect((result.messages[1].content as unknown[])[0]).toBe(ordinaryResult);
    expect((result.messages[1].content as unknown[])[1]).toBe(userText);
  });

  it("preserves an orphan prefixed tool_result when no matching tool_use exists", () => {
    const messages: Record<string, unknown>[] = [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_cc_session_init_unknown",
        content: "unmatched",
      }],
    }];

    const result = stripSessionInitArtifacts(messages);

    expect(result.removed).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("returns non-session-init history byte-for-byte and reference-identical", () => {
    const messages: Record<string, unknown>[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const serialized = JSON.stringify(messages);

    const result = stripSessionInitArtifacts(messages);

    expect(result.messages).toBe(messages);
    expect(JSON.stringify(result.messages)).toBe(serialized);
  });
});
