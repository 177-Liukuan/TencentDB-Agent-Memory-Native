import { describe, expect, it } from "vitest";

import {
  materializeClaudeToolLedgerHistory,
  NativeToolLedgerConflictError,
  reconstructAnthropicToolLedger,
} from "../tool-history-reconstructor.js";
import { createClaudeTurnMarker } from "../turn-marker.js";
import { InMemoryNativeToolLedgerStorageAdapter } from "../../db/in-memory-native-tool-ledger-storage-adapter.js";
import type { NativeToolLedgerRound, NativeToolSessionScope } from "../types.js";

const scope: NativeToolSessionScope = {
  spaceId: "space-1",
  userId: "user-1",
  agentSource: "claude-code",
  sessionId: "session-1",
};

function nativeRound(overrides: Partial<NativeToolLedgerRound> = {}): NativeToolLedgerRound {
  return {
    ledgerId: "ledger-1",
    scope,
    contextEpoch: 0,
    turnSeq: 1,
    round: 0,
    clientProtocol: "anthropic",
    blocks: [
      {
        kind: "native_tool",
        blockIndex: 0,
        callId: "native-a",
        toolName: "tdai_memory_search",
        input: { query: "q" },
      },
    ],
    nativeResults: [{ callId: "native-a", value: { memories: ["m"] }, isError: false }],
    createdAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("Anthropic Tool Ledger reconstruction", () => {
  it("inserts a pure Native round between the user request and final answer", () => {
    const result = reconstructAnthropicToolLedger({
      messages: [
        { role: "user", content: "问题" },
        { role: "assistant", content: [{ type: "text", text: "最终回答" }] },
      ],
      turns: [{ turnSeq: 1, insertAfterItem: 1 }],
      rounds: [nativeRound()],
    });

    expect(result).toEqual([
      { role: "user", content: "问题" },
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "native-a",
          name: "tdai_memory_search",
          input: { query: "q" },
        }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "native-a",
          content: { memories: ["m"] },
        }],
      },
      { role: "assistant", content: [{ type: "text", text: "最终回答" }] },
    ]);
  });

  it("fills Native calls into a mixed Assistant message and reorders all results", () => {
    const result = reconstructAnthropicToolLedger({
      messages: [
        { role: "user", content: "问题" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "先查一下" },
            { type: "thinking", thinking: "需要读取文件" },
            { type: "tool_use", id: "client-b", name: "Read", input: { file_path: "a.ts" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "保留这条提示" },
            { type: "tool_result", tool_use_id: "client-b", content: "file" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "最终回答" }] },
      ],
      turns: [{ turnSeq: 1, insertAfterItem: 1 }],
      rounds: [nativeRound({
        blocks: [
          {
            kind: "native_tool", blockIndex: 1, callId: "native-a",
            toolName: "tdai_memory_search", input: { query: "q" },
          },
          { kind: "client_tool_ref", blockIndex: 3, callId: "client-b", toolName: "Read" },
          {
            kind: "native_tool", blockIndex: 4, callId: "native-c",
            toolName: "skill_view", input: { skill_id: "s" },
          },
        ],
        nativeResults: [
          { callId: "native-a", value: "memory", isError: false },
          { callId: "native-c", value: "skill", isError: true },
        ],
      })],
    });

    expect(result[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "先查一下" },
        { type: "tool_use", id: "native-a", name: "tdai_memory_search", input: { query: "q" } },
        { type: "thinking", thinking: "需要读取文件" },
        { type: "tool_use", id: "client-b", name: "Read", input: { file_path: "a.ts" } },
        { type: "tool_use", id: "native-c", name: "skill_view", input: { skill_id: "s" } },
      ],
    });
    expect(result[2]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "保留这条提示" },
        { type: "tool_result", tool_use_id: "native-a", content: "memory" },
        { type: "tool_result", tool_use_id: "client-b", content: "file" },
        { type: "tool_result", tool_use_id: "native-c", content: "skill", is_error: true },
      ],
    });
  });

  it("places pure rounds before and after a visible client-tool round", () => {
    const result = reconstructAnthropicToolLedger({
      messages: [
        { role: "user", content: "问题" },
        { role: "assistant", content: [{ type: "tool_use", id: "client-b", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "client-b", content: "file" }] },
        { role: "assistant", content: [{ type: "text", text: "完成" }] },
      ],
      turns: [{ turnSeq: 1, insertAfterItem: 1 }],
      rounds: [
        nativeRound({ ledgerId: "before", round: 0 }),
        nativeRound({
          ledgerId: "mixed", round: 1,
          blocks: [{ kind: "client_tool_ref", blockIndex: 0, callId: "client-b", toolName: "Read" }],
          nativeResults: [],
        }),
        nativeRound({
          ledgerId: "after", round: 2,
          blocks: [{
            kind: "native_tool", blockIndex: 0, callId: "native-c",
            toolName: "skill_view", input: { skill_id: "s" },
          }],
          nativeResults: [{ callId: "native-c", value: "skill", isError: false }],
        }),
      ],
    });

    expect((result[1] as Record<string, unknown>).content).toEqual([
      { type: "tool_use", id: "native-a", name: "tdai_memory_search", input: { query: "q" } },
    ]);
    expect((result[3] as Record<string, unknown>).content).toEqual([
      { type: "tool_use", id: "client-b", name: "Read", input: {} },
    ]);
    expect((result[5] as Record<string, unknown>).content).toEqual([
      { type: "tool_use", id: "native-c", name: "skill_view", input: { skill_id: "s" } },
    ]);
    expect(result.at(-1)).toEqual({ role: "assistant", content: [{ type: "text", text: "完成" }] });
  });

  it("rejects a mixed round when its client call is absent", () => {
    expect(() => reconstructAnthropicToolLedger({
      messages: [
        { role: "user", content: "问题" },
        { role: "assistant", content: [{ type: "text", text: "回答" }] },
      ],
      turns: [{ turnSeq: 1, insertAfterItem: 1 }],
      rounds: [nativeRound({
        blocks: [{ kind: "client_tool_ref", blockIndex: 0, callId: "missing", toolName: "Read" }],
        nativeResults: [],
      })],
    })).toThrow(NativeToolLedgerConflictError);
  });

  it("uses persisted hook turns and restores only the current epoch", async () => {
    const storage = new InMemoryNativeToolLedgerStorageAdapter();
    const oldTurn = await storage.recordUserPrompt(scope);
    await storage.appendRound(nativeRound({ ledgerId: "old", turnSeq: oldTurn.turnSeq }));
    await storage.beginCompact(scope, "manual");
    await storage.completeCompact(scope, "manual");
    const currentTurn = await storage.recordUserPrompt(scope);
    await storage.appendRound(nativeRound({
      ledgerId: "current",
      contextEpoch: 1,
      turnSeq: currentTurn.turnSeq,
      blocks: [{
        kind: "native_tool", blockIndex: 0, callId: "native-current",
        toolName: "tdai_memory_search", input: { query: "current" },
      }],
      nativeResults: [{ callId: "native-current", value: "current-result", isError: false }],
    }));

    const result = await materializeClaudeToolLedgerHistory({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "新问题" },
            { type: "text", text: createClaudeTurnMarker(currentTurn.turnToken) },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "回答" }] },
      ],
      scope,
      storage,
    });

    expect(result.currentEpoch).toBe(1);
    expect(result.turnSeq).toBe(2);
    expect(JSON.stringify(result.messages)).toContain("native-current");
    expect(JSON.stringify(result.messages)).not.toContain("native-a");
    expect(JSON.stringify(result.messages)).not.toContain("tdai-native-turn");
  });

  it("stops instead of dropping a current-epoch round whose turn marker is absent", async () => {
    const storage = new InMemoryNativeToolLedgerStorageAdapter();
    const turn = await storage.recordUserPrompt(scope);
    await storage.appendRound(nativeRound({ turnSeq: turn.turnSeq }));

    await expect(materializeClaudeToolLedgerHistory({
      messages: [{ role: "user", content: "history was replaced" }],
      scope,
      storage,
    })).rejects.toThrow(NativeToolLedgerConflictError);
  });
});
