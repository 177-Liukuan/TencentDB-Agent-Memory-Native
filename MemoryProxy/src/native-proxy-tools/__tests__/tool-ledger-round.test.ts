import { describe, expect, it } from "vitest";

import { buildNativeToolLedgerRound } from "../tool-ledger-round.js";
import type { ToolExecutionContext } from "../types.js";

function context(): ToolExecutionContext {
  return {
    key: { spaceId: "space", userId: "user", agentSource: "claude-code", sessionId: "session", contextVersion: "epoch:3", toolBatchId: "batch" },
    turnSeq: 2, protocol: "anthropic", round: 1, totalCalls: 1,
    assistantSkeleton: [
      { type: "text", text: "checking" },
      { type: "tool_use", id: "native", name: "tdai_memory_search", input: { query: "q" } },
    ],
    slots: [{ callId: "native", slotIndex: 0, contentBlockIndex: 1, toolName: "tdai_memory_search", owner: "proxy", input: { query: "q" }, argumentsComplete: true, status: "succeeded", executionAttempt: 1, result: { hits: 1 }, isError: false }],
    responseStreamStatus: "completed", clientDispatchStatus: "none",
    upstreamSnapshot: { protocol: "anthropic", clientProtocol: "anthropic", baseMessages: [], requestParameters: {}, target: { id: "target", url: "https://example.test", model: "model", authSource: "agent" } },
    revision: 1, expiresAt: "2026-09-04T01:00:00.000Z", createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:01.000Z",
  };
}

describe("Native Tool ledger round", () => {
  it.each(["anthropic", "responses"] as const)("retains the preceding Client call independently of upstream protocol (%s)", (protocol) => {
    const value = context();
    value.protocol = protocol;
    value.upstreamSnapshot.protocol = protocol;
    value.upstreamSnapshot.previousClientToolCallId = "client-before";
    if (protocol === "responses") {
      value.assistantSkeleton = [{ type: "function_call", call_id: "native", name: "tdai_memory_search", arguments: "{\"query\":\"q\"}" }];
      value.slots[0]!.contentBlockIndex = 0;
    }
    expect(buildNativeToolLedgerRound(value)).toMatchObject({ previousClientToolCallId: "client-before" });
    value.upstreamSnapshot.previousClientToolCallId = null;
    expect(buildNativeToolLedgerRound(value)).toMatchObject({ previousClientToolCallId: null });
  });

  it("stores hidden content and the exact Native result used by Anthropic", () => {
    expect(buildNativeToolLedgerRound(context())).toMatchObject({
      ledgerId: "space/user/claude-code/session/epoch%3A3/batch",
      contextEpoch: 3,
      turnSeq: 2,
      blocks: [
        { kind: "hidden_content", blockIndex: 0, value: { type: "text", text: "checking" } },
        { kind: "native_tool", blockIndex: 1, callId: "native", toolName: "tdai_memory_search", input: { query: "q" } },
      ],
      nativeResults: [{ callId: "native", value: "{\"hits\":1}", isError: false }],
    });
  });

  it("stores only call references for client-visible blocks in a mixed round", () => {
    const value = context();
    value.assistantSkeleton.push({ type: "tool_use", id: "client", name: "Read", input: { file_path: "a" } });
    value.slots.push({ callId: "client", slotIndex: 1, contentBlockIndex: 2, toolName: "Read", owner: "client", input: { file_path: "a" }, argumentsComplete: true, status: "succeeded", executionAttempt: 0, result: "file" });
    expect(buildNativeToolLedgerRound(value).blocks).toEqual([
      { kind: "native_tool", blockIndex: 1, callId: "native", toolName: "tdai_memory_search", input: { query: "q" } },
      { kind: "client_tool_ref", blockIndex: 2, callId: "client", toolName: "Read" },
    ]);
  });

  it("rejects unfinished rounds", () => {
    const value = context();
    value.slots[0]!.status = "running";
    expect(() => buildNativeToolLedgerRound(value)).toThrow(/complete/i);
  });
});
