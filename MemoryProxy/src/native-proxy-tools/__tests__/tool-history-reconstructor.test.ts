import { describe, expect, it } from "vitest";

import {
  materializeClaudeToolLedgerHistory,
  NativeToolLedgerConflictError,
  reconstructAnthropicToolLedger,
} from "../tool-history-reconstructor.js";
import { createClaudeTurnMarker } from "../turn-marker.js";
import { InMemoryNativeToolLedgerStorageAdapter } from "../../db/in-memory-native-tool-ledger-storage-adapter.js";
import type { JsonValue, NativeToolLedgerRound, NativeToolSessionScope } from "../types.js";

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
  it("distinguishes two mixed responses whose independent model loops both used round 1", () => {
    const messages: JsonValue[] = [{ role: "user", content: "问题" }];
    const rounds: NativeToolLedgerRound[] = [];
    for (const suffix of ["a", "b"]) {
      messages.push(
        { role: "assistant", content: [{ type: "tool_use", id: `client-${suffix}`, name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: `client-${suffix}`, content: suffix }] },
      );
      rounds.push(nativeRound({
        ledgerId: suffix, round: 1,
        blocks: [
          { kind: "native_tool", blockIndex: 0, callId: `native-${suffix}`, toolName: "tdai_memory_search", input: {} },
          { kind: "client_tool_ref", blockIndex: 1, callId: `client-${suffix}`, toolName: "Read" },
        ],
        nativeResults: [{ callId: `native-${suffix}`, value: suffix, isError: false }],
      }));
    }
    const result = reconstructAnthropicToolLedger({ messages, rounds: rounds.reverse(), turns: [{ turnSeq: 1, insertAfterItem: 1 }] });
    expect(result[1]).toMatchObject({ content: [{ id: "native-a" }, { id: "client-a" }] });
    expect(result[3]).toMatchObject({ content: [{ id: "native-b" }, { id: "client-b" }] });
    expect(result[2]).toMatchObject({ content: [{ tool_use_id: "native-a" }, { tool_use_id: "client-a" }] });
    expect(result[4]).toMatchObject({ content: [{ tool_use_id: "native-b" }, { tool_use_id: "client-b" }] });
  });

  // 原问题不是 A/B 之间排错，而是两者跨过了中间由 Claude Code 保存的 Bash。
  it.each([1, 4])("restores hidden rounds around consecutive Client calls even when round restarts at %s", (lastRound) => {
    const messages: JsonValue[] = [{ role: "user", content: "问题" }];
    for (const id of ["client-1", "client-2"]) {
      messages.push(
        { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: id }, { type: "text", text: "保留提醒" }] },
      );
    }
    const hidden = (id: string, round: number, previousClientToolCallId: string | null) => nativeRound({
      ledgerId: id, round, previousClientToolCallId,
      blocks: [{ kind: "native_tool", blockIndex: 0, callId: id, toolName: "tdai_memory_search", input: {} }],
      nativeResults: [{ callId: id, value: id, isError: false }],
    });
    const restored = reconstructAnthropicToolLedger({
      messages, turns: [{ turnSeq: 1, insertAfterItem: 1 }],
      rounds: [hidden("native-c", lastRound + 1, "client-2"), hidden("native-a", 1, null), hidden("native-b", lastRound, "client-2")],
    });
    const blocks = restored.flatMap((message) => (message as { content: JsonValue[] }).content);
    const calls = blocks.filter((block) => (block as { type?: string }).type === "tool_use");
    const results = blocks.filter((block) => (block as { type?: string }).type === "tool_result");
    expect(calls.map((block) => (block as { id: string }).id)).toEqual(["native-a", "client-1", "client-2", "native-b", "native-c"]);
    expect(results.map((block) => (block as { tool_use_id: string }).tool_use_id)).toEqual(["native-a", "client-1", "client-2", "native-b", "native-c"]);
    expect(blocks.filter((block) => (block as { text?: string }).text === "保留提醒")).toHaveLength(2);
    expect(messages).toHaveLength(5);
  });

  it("does not move the first Native call ahead of earlier Client work in the same turn", () => {
    const result = reconstructAnthropicToolLedger({
      messages: [
        { role: "user", content: "问题" },
        { role: "assistant", content: [{ type: "tool_use", id: "read", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "read", content: "file" }] },
        { role: "assistant", content: "回答" },
      ],
      turns: [{ turnSeq: 1, insertAfterItem: 1 }],
      rounds: [nativeRound({ round: 1, previousClientToolCallId: "read" })],
    });
    expect(result[1]).toMatchObject({ content: [{ id: "read" }] });
    expect(result[3]).toMatchObject({ content: [{ id: "native-a" }] });
  });

  it.each(["absent", "duplicate", "missing-result", "previous-turn", "legacy"])("rejects an unusable Client position (%s) instead of guessing", (kind) => {
    const messages: JsonValue[] = [
      { role: "user", content: "问题" },
      { role: "assistant", content: [{ type: "tool_use", id: "read", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "read", content: "file" }] },
    ];
    if (kind === "duplicate") messages.push(...structuredClone(messages.slice(1)));
    if (kind === "missing-result") messages.pop();
    if (kind === "previous-turn") messages.push({ role: "user", content: "新问题" });
    expect(() => reconstructAnthropicToolLedger({
      messages,
      turns: [{ turnSeq: 1, insertAfterItem: kind === "previous-turn" ? 4 : 1 }],
      rounds: [nativeRound(kind === "legacy" ? {} : { previousClientToolCallId: kind === "absent" ? "unknown" : "read" })],
    })).toThrow(NativeToolLedgerConflictError);
  });

  it("captures only the latest real turn's visible Client position before adding hidden history", async () => {
    const storage = new InMemoryNativeToolLedgerStorageAdapter();
    const first = await storage.recordUserPrompt(scope);
    const marker = (token: string): JsonValue => ({ role: "user", content: [{ type: "text", text: "问题" }, { type: "text", text: createClaudeTurnMarker(token) }] });
    const messages: JsonValue[] = [marker(first.turnToken),
      { role: "assistant", content: [{ type: "tool_use", id: "read", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "read", content: "file" }] },
    ];
    expect(await materializeClaudeToolLedgerHistory({ messages, scope, storage })).toMatchObject({ previousClientToolCallId: "read" });
    const second = await storage.recordUserPrompt(scope);
    messages.push(marker(second.turnToken));
    expect(await materializeClaudeToolLedgerHistory({ messages, scope, storage })).toMatchObject({ previousClientToolCallId: null });
  });

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
        nativeRound({ ledgerId: "before", round: 0, previousClientToolCallId: null }),
        nativeRound({
          ledgerId: "mixed", round: 1,
          blocks: [{ kind: "client_tool_ref", blockIndex: 0, callId: "client-b", toolName: "Read" }],
          nativeResults: [],
        }),
        nativeRound({
          ledgerId: "after", round: 2, previousClientToolCallId: "client-b",
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
