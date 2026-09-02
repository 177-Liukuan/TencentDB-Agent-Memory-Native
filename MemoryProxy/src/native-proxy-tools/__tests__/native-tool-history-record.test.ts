import { describe, expect, it } from "vitest";

import { createHistoryAnchor } from "../history-anchor.js";
import { buildNativeToolHistoryRecord } from "../native-tool-history-record.js";
import { buildOpenAIAssistantSkeleton } from "../openai-response-rebuilder.js";
import type { ToolExecutionContext } from "../types.js";

function context(protocol: "anthropic" | "openai" | "responses"): ToolExecutionContext {
  const logicalBaseMessages = [{ role: "user", content: [{ type: "text", text: "question" }] }];
  return {
    key: { spaceId: "space", userId: "user", agentSource: "claude-code", sessionId: "session", contextVersion: "v1", toolBatchId: "batch" },
    turnSeq: 1, protocol, round: 1, totalCalls: 1,
    assistantSkeleton: [], slots: [], responseStreamStatus: "completed", clientDispatchStatus: "none",
    upstreamSnapshot: {
      protocol, clientProtocol: protocol, baseMessages: logicalBaseMessages, logicalBaseMessages,
      historyAnchor: createHistoryAnchor(logicalBaseMessages), logicalTurnId: "logical-turn",
      requestParameters: { model: "model", stream: true },
      target: { id: "target", url: "https://example.test", model: "model", authSource: "agent" },
    },
    revision: 1, expiresAt: "2026-09-02T01:00:00.000Z", createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:01.000Z",
  };
}

describe("completed Native Tool history records", () => {
  it("builds an Anthropic mixed segment and its exact client projection", () => {
    const value = context("anthropic");
    value.assistantSkeleton = [
      { type: "text", text: "checking" },
      { type: "tool_use", id: "native", name: "tdai_memory_search", input: { query: "q" } },
      { type: "tool_use", id: "client", name: "Read", input: { file_path: "a" } },
    ];
    value.slots = [
      { callId: "native", slotIndex: 0, contentBlockIndex: 1, toolName: "tdai_memory_search", owner: "proxy", input: {}, argumentsComplete: true, status: "succeeded", executionAttempt: 1, result: "memory", isError: false },
      { callId: "client", slotIndex: 1, contentBlockIndex: 2, toolName: "Read", owner: "client", input: {}, argumentsComplete: true, status: "succeeded", executionAttempt: 0, result: "file", isError: false },
    ];

    const record = buildNativeToolHistoryRecord(value);
    expect(record.proxyCallIds).toEqual(["native"]);
    expect(record.clientCallIds).toEqual(["client"]);
    expect(record.clientProjection).toEqual([
      { role: "assistant", content: [{ type: "text", text: "checking" }, { type: "tool_use", id: "client", name: "Read", input: { file_path: "a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "client", content: "file" }] },
    ]);
  });

  it("stores an Anthropic client segment when the upstream protocol is Responses", () => {
    const value = context("responses");
    value.upstreamSnapshot.clientProtocol = "anthropic";
    value.assistantSkeleton = [
      { type: "reasoning", content: [{ type: "reasoning_text", text: "think" }] },
      { type: "function_call", id: "fc", call_id: "native", name: "tdai_memory_search", arguments: "{\"query\":\"q\"}" },
    ];
    value.slots = [{ callId: "native", slotIndex: 0, contentBlockIndex: 1, toolName: "tdai_memory_search", owner: "proxy", input: { query: "q" }, argumentsComplete: true, status: "succeeded", executionAttempt: 1, result: { hits: 1 }, isError: false }];

    const record = buildNativeToolHistoryRecord(value);
    expect(record.clientProtocol).toBe("anthropic");
    expect(record.upstreamProtocol).toBe("responses");
    expect(record.fullSegment).toEqual([
      { role: "assistant", content: [
        { type: "thinking", thinking: "think" },
        { type: "tool_use", id: "native", name: "tdai_memory_search", input: { query: "q" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "native", content: "{\"hits\":1}" }] },
    ]);
  });

  it("keeps Chat Completions text and Provider fields beside Native calls", () => {
    const value = context("openai");
    value.assistantSkeleton = buildOpenAIAssistantSkeleton({
      calls: [{ callId: "native", toolName: "tdai_memory_search", input: { query: "q" }, slotIndex: 0 }],
      content: "checking",
      extras: { provider_tool: { type: "web_search", id: "server-1", status: "completed" } },
    });
    value.slots = [{ callId: "native", slotIndex: 0, contentBlockIndex: 0, toolName: "tdai_memory_search", owner: "proxy", input: { query: "q" }, argumentsComplete: true, status: "succeeded", executionAttempt: 1, result: "memory", isError: false }];

    expect(buildNativeToolHistoryRecord(value).fullSegment).toEqual([
      {
        role: "assistant",
        content: "checking",
        provider_tool: { type: "web_search", id: "server-1", status: "completed" },
        tool_calls: [{ id: "native", type: "function", function: { name: "tdai_memory_search", arguments: "{\"query\":\"q\"}" } }],
      },
      { role: "tool", tool_call_id: "native", content: "memory" },
    ]);
  });

  it("refuses to persist an incomplete result", () => {
    const value = context("anthropic");
    value.slots = [{ callId: "native", slotIndex: 0, contentBlockIndex: 0, toolName: "tdai_memory_search", owner: "proxy", argumentsComplete: true, status: "running", executionAttempt: 1 }];
    expect(() => buildNativeToolHistoryRecord(value)).toThrow(/complete/i);
  });
});
