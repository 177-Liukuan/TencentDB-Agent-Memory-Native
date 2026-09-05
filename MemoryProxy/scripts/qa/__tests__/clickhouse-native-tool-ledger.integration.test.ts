import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type ClickHouseClient } from "@clickhouse/client";

import { DEFAULT_CONFIG } from "../../../src/config.js";
import { ClickHouseNativeToolLedgerStorageAdapter, createNativeToolLedgerTableDdl, encodeNativeToolLedgerRow } from "../../../src/db/clickhouse-native-tool-ledger-storage-adapter.js";
import { reconstructAnthropicToolLedger } from "../../../src/native-proxy-tools/tool-history-reconstructor.js";
import type { NativeToolLedgerRound, NativeToolSessionScope } from "../../../src/native-proxy-tools/types.js";

const describeIntegration = process.env.NATIVE_TOOL_CLICKHOUSE_TEST === "1" ? describe : describe.skip;
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; }

describeIntegration("real ClickHouse Native Tool ledger", () => {
  let cleanup: ClickHouseClient;
  let first: ClickHouseNativeToolLedgerStorageAdapter;
  let second: ClickHouseNativeToolLedgerStorageAdapter;
  let ledgerTable = "";
  let eventTable = "";
  const scope: NativeToolSessionScope = { spaceId: "native-tool-integration", userId: "user", agentSource: "claude-code", sessionId: randomUUID() };
  const legacyRound: NativeToolLedgerRound = {
    ledgerId: randomUUID(), scope, contextEpoch: 0, turnSeq: 1, round: 1, clientProtocol: "anthropic",
    blocks: [{ kind: "native_tool", blockIndex: 0, callId: "legacy-call", toolName: "tdai_memory_search", input: {} }],
    nativeResults: [{ callId: "legacy-call", value: "old-result", isError: false }], createdAt: new Date().toISOString(),
  };

  beforeAll(async () => {
    const url = required("NATIVE_TOOL_CLICKHOUSE_URL");
    const database = required("NATIVE_TOOL_CLICKHOUSE_DATABASE");
    const user = required("NATIVE_TOOL_CLICKHOUSE_USER");
    const password = process.env.NATIVE_TOOL_CLICKHOUSE_PASSWORD ?? "";
    ledgerTable = `native_proxy_tool_ledger_test_${randomUUID().replaceAll("-", "_")}`;
    eventTable = `native_proxy_tool_event_test_${randomUUID().replaceAll("-", "_")}`;
    const config = structuredClone(DEFAULT_CONFIG);
    config.clickhouse = { ...config.clickhouse, enabled: true, url, database, user, password };
    config.nativeProxyTools.enabled = true;
    config.nativeProxyTools.ledgerStorage = { backend: "clickhouse", table: ledgerTable, eventTable };
    cleanup = createClient({ url, database, username: user, password });
    // 先建旧版表，再由正常启动代码补列，验证升级不要求删除已有历史。
    await cleanup.command({ query: createNativeToolLedgerTableDdl(ledgerTable).replace(",\n previous_client_tool_call_id Nullable(String) DEFAULT NULL", "") });
    const legacyRow = encodeNativeToolLedgerRow(legacyRound);
    delete legacyRow.previous_client_tool_call_id;
    await cleanup.insert({ table: ledgerTable, values: [legacyRow], format: "JSONEachRow" });
    first = new ClickHouseNativeToolLedgerStorageAdapter(config);
    second = new ClickHouseNativeToolLedgerStorageAdapter(config);
    await first.initializeAndProbe();
    await second.initializeAndProbe();
  }, 30_000);

  afterAll(async () => {
    await cleanup?.command({ query: `DROP TABLE IF EXISTS ${ledgerTable} SYNC` });
    await cleanup?.command({ query: `DROP TABLE IF EXISTS ${eventTable} SYNC` });
    await Promise.allSettled([first?.close(), second?.close(), cleanup?.close()]);
  }, 30_000);

  it("shares prompt and compact events across proxy instances", async () => {
    const turn = await first.recordUserPrompt(scope);
    expect(await second.findTurnByToken(scope, turn.turnToken)).toEqual(turn);
    await first.beginCompact(scope, "manual");
    expect(await second.getSessionContext(scope)).toMatchObject({ currentTurnSeq: 1, currentEpoch: 0, pendingCompactEpoch: 1 });
    await second.completeCompact(scope, "manual");
    expect(await first.getSessionContext(scope)).toMatchObject({ currentEpoch: 1, pendingCompactEpoch: null });
  }, 30_000);

  it("upgrades an existing ledger table without treating unknown old positions as turn-start", async () => {
    const rows = await second.findRounds(scope, 0);
    expect(rows).toEqual([legacyRound]);
    expect(rows[0]).not.toHaveProperty("previousClientToolCallId");
  }, 30_000);

  it("writes the same completed round idempotently and reads it from another instance", async () => {
    const round: NativeToolLedgerRound = {
      ledgerId: randomUUID(), scope, contextEpoch: 1, turnSeq: 1, round: 1, clientProtocol: "anthropic",
      blocks: [{ kind: "native_tool", blockIndex: 0, callId: "call", toolName: "tdai_memory_search", input: { query: "q" } }],
      nativeResults: [{ callId: "call", value: "result", isError: false }], createdAt: new Date().toISOString(),
    };
    await first.appendRound(round);
    await second.appendRound(structuredClone(round));
    expect(await second.findRounds(scope, 1)).toContainEqual(round);
  }, 30_000);

  it("persists Client positions across instances and reconstructs hidden calls without runtime state", async () => {
    const positionScope = { ...scope, sessionId: randomUUID() };
    const rows: NativeToolLedgerRound[] = ["native-a", "native-b"].map((id, index) => ({
      ledgerId: randomUUID(), scope: positionScope, contextEpoch: 0, turnSeq: 1, round: index + 1, clientProtocol: "anthropic",
      blocks: [{ kind: "native_tool", blockIndex: 0, callId: id, toolName: "tdai_memory_search", input: {} }],
      nativeResults: [{ callId: id, value: id, isError: false }], createdAt: new Date().toISOString(),
      previousClientToolCallId: index === 0 ? null : "client-1",
    }));
    for (const row of rows) {
      await first.appendRound(row);
      await second.appendRound(structuredClone(row));
    }
    const persisted = await second.findRounds(positionScope, 0);
    expect(persisted).toEqual(rows);
    const messages = reconstructAnthropicToolLedger({
      messages: [
        { role: "user", content: "question" },
        { role: "assistant", content: [{ type: "tool_use", id: "client-1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "client-1", content: "result" }] },
      ],
      turns: [{ turnSeq: 1, insertAfterItem: 1 }], rounds: persisted,
    });
    expect([messages[1], messages[3], messages[5]]).toMatchObject([
      { content: [{ id: "native-a" }] }, { content: [{ id: "client-1" }] }, { content: [{ id: "native-b" }] },
    ]);
  }, 30_000);
});
