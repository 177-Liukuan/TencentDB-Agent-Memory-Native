import { describe, expect, it } from "vitest";

import type { NativeToolContextEvent, NativeToolLedgerRound } from "../../native-proxy-tools/types.js";
import {
  createNativeToolContextEventTableDdl,
  createNativeToolLedgerTableDdl,
  decodeNativeToolContextEventRow,
  decodeNativeToolLedgerRow,
  encodeNativeToolContextEventRow,
  encodeNativeToolLedgerRow,
} from "../clickhouse-native-tool-ledger-storage-adapter.js";

const round: NativeToolLedgerRound = {
  ledgerId: "ledger", scope: { spaceId: "s", userId: "u", agentSource: "claude-code", sessionId: "session" },
  contextEpoch: 2, turnSeq: 3, round: 1, clientProtocol: "anthropic",
  blocks: [{ kind: "native_tool", blockIndex: 0, callId: "call", toolName: "tdai_memory_search", input: { query: "q" } }],
  nativeResults: [{ callId: "call", value: "result", isError: false }], createdAt: "2026-09-04T00:00:00.000Z",
};

const event: NativeToolContextEvent = {
  eventId: "event", scope: round.scope, type: "user_prompt", turnSeq: 3,
  turnToken: "123e4567-e89b-42d3-a456-426614174000", createdAt: "2026-09-04T00:00:00.000Z",
};

describe("ClickHouse Native Tool ledger encoding", () => {
  it.each([null, "client-before"])("persists the Client insertion position (%s)", (previousClientToolCallId) => {
    const value = { ...round, previousClientToolCallId };
    expect(decodeNativeToolLedgerRow(encodeNativeToolLedgerRow(value))).toEqual(value);
  });

  it("creates append-only ledger and context-event tables without TTL", () => {
    expect(createNativeToolLedgerTableDdl("native_proxy_tool_ledger")).toContain("ReplacingMergeTree");
    expect(createNativeToolLedgerTableDdl("native_proxy_tool_ledger")).not.toContain("TTL");
    expect(createNativeToolContextEventTableDdl("native_proxy_tool_context_event")).toContain("MergeTree");
  });

  it("round-trips a ledger round", () => {
    expect(decodeNativeToolLedgerRow(encodeNativeToolLedgerRow(round))).toEqual(round);
  });

  it("round-trips a context event", () => {
    expect(decodeNativeToolContextEventRow(encodeNativeToolContextEventRow(event))).toEqual(event);
  });
});
