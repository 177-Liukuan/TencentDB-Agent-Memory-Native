import { randomUUID } from "node:crypto";

import type { ProxyConfig } from "../types.js";
import type {
  NativeToolContextEvent,
  NativeToolContextEventType,
  NativeToolLedgerRound,
  NativeToolProtocol,
  NativeToolSessionContext,
  NativeToolSessionScope,
  NativeToolUserTurn,
} from "../native-proxy-tools/types.js";
import {
  NativeToolLedgerStorageConflictError,
  NativeToolLedgerStorageError,
  type NativeToolLedgerStorageAdapter,
} from "./native-tool-ledger-storage-adapter.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
interface Command { query: string; query_params?: Record<string, unknown>; clickhouse_settings?: Record<string, unknown> }
interface Insert { table: string; values: Record<string, unknown>[]; format: "JSONEachRow"; clickhouse_settings?: Record<string, unknown> }
interface Query { query: string; query_params?: Record<string, unknown>; format: "JSONEachRow"; clickhouse_settings?: Record<string, unknown> }
export interface NativeToolLedgerClickHouseClient {
  command(input: Command): Promise<unknown>;
  insert(input: Insert): Promise<unknown>;
  query(input: Query): Promise<{ json(): Promise<unknown[]> }>;
  close(): Promise<unknown>;
}

export interface NativeToolLedgerRow extends Record<string, unknown> {
  ledger_id: string; space_id: string; user_id: string; agent_source: string; session_id: string;
  context_epoch: number | string; turn_seq: number | string; round: number | string; client_protocol: string;
  blocks_json: string; native_results_json: string; created_at: string;
}
export interface NativeToolContextEventRow extends Record<string, unknown> {
  event_id: string; space_id: string; user_id: string; agent_source: string; session_id: string;
  event_type: string; turn_seq: number | string; turn_token: string; target_epoch: number | string;
  trigger: string; created_at: string;
}

function assertIdentifier(value: string): void {
  if (!IDENTIFIER.test(value)) throw new NativeToolLedgerStorageError("Native Tool ClickHouse identifier is invalid");
}
function clickHouseTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new NativeToolLedgerStorageError("Native Tool timestamp is invalid");
  return new Date(timestamp).toISOString().replace("T", " ").replace("Z", "").slice(0, 23);
}
function isoTime(value: string): string {
  const timestamp = Date.parse(value) || Date.parse(`${value.replace(" ", "T")}Z`);
  if (!Number.isFinite(timestamp)) throw new NativeToolLedgerStorageError("Native Tool ClickHouse row is corrupt");
  return new Date(timestamp).toISOString();
}
function parseJson<T>(value: string): T {
  try { return JSON.parse(value) as T; } catch { throw new NativeToolLedgerStorageError("Native Tool ClickHouse row is corrupt"); }
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

export function createNativeToolLedgerTableDdl(table: string): string {
  assertIdentifier(table);
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    " ledger_id String, space_id String, user_id String, agent_source LowCardinality(String), session_id String,",
    " context_epoch UInt32, turn_seq UInt64, round UInt32, client_protocol LowCardinality(String),",
    " blocks_json String, native_results_json String, created_at DateTime64(3, 'UTC')",
    ") ENGINE = ReplacingMergeTree(created_at)",
    "ORDER BY (space_id, user_id, agent_source, session_id, context_epoch, turn_seq, round, ledger_id)",
  ].join("\n");
}

export function createNativeToolContextEventTableDdl(table: string): string {
  assertIdentifier(table);
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    " event_id String, space_id String, user_id String, agent_source LowCardinality(String), session_id String,",
    " event_type LowCardinality(String), turn_seq UInt64 DEFAULT 0, turn_token String DEFAULT '',",
    " target_epoch UInt32 DEFAULT 0, trigger LowCardinality(String) DEFAULT '', created_at DateTime64(3, 'UTC')",
    ") ENGINE = MergeTree",
    "ORDER BY (space_id, user_id, agent_source, session_id, created_at, event_id)",
  ].join("\n");
}

export function encodeNativeToolLedgerRow(value: NativeToolLedgerRound): NativeToolLedgerRow {
  return {
    ledger_id: value.ledgerId, space_id: value.scope.spaceId, user_id: value.scope.userId,
    agent_source: value.scope.agentSource, session_id: value.scope.sessionId,
    context_epoch: value.contextEpoch, turn_seq: value.turnSeq, round: value.round,
    client_protocol: value.clientProtocol, blocks_json: JSON.stringify(value.blocks),
    native_results_json: JSON.stringify(value.nativeResults), created_at: clickHouseTime(value.createdAt),
  };
}
export function decodeNativeToolLedgerRow(row: NativeToolLedgerRow): NativeToolLedgerRound {
  if (!( ["anthropic", "openai", "responses"] as string[]).includes(row.client_protocol)) {
    throw new NativeToolLedgerStorageError("Native Tool ClickHouse row is corrupt");
  }
  return {
    ledgerId: row.ledger_id,
    scope: { spaceId: row.space_id, userId: row.user_id, agentSource: row.agent_source, sessionId: row.session_id },
    contextEpoch: Number(row.context_epoch), turnSeq: Number(row.turn_seq), round: Number(row.round),
    clientProtocol: row.client_protocol as NativeToolProtocol,
    blocks: parseJson(row.blocks_json), nativeResults: parseJson(row.native_results_json), createdAt: isoTime(row.created_at),
  };
}
export function encodeNativeToolContextEventRow(value: NativeToolContextEvent): NativeToolContextEventRow {
  return {
    event_id: value.eventId, space_id: value.scope.spaceId, user_id: value.scope.userId,
    agent_source: value.scope.agentSource, session_id: value.scope.sessionId, event_type: value.type,
    turn_seq: value.turnSeq ?? 0, turn_token: value.turnToken ?? "", target_epoch: value.targetEpoch ?? 0,
    trigger: value.trigger ?? "", created_at: clickHouseTime(value.createdAt),
  };
}
export function decodeNativeToolContextEventRow(row: NativeToolContextEventRow): NativeToolContextEvent {
  const type = row.event_type as NativeToolContextEventType;
  if (!( ["user_prompt", "compact_pending", "compact_completed", "compact_error"] as string[]).includes(type)) {
    throw new NativeToolLedgerStorageError("Native Tool context event row is corrupt");
  }
  return {
    eventId: row.event_id,
    scope: { spaceId: row.space_id, userId: row.user_id, agentSource: row.agent_source, sessionId: row.session_id },
    type,
    ...(Number(row.turn_seq) > 0 ? { turnSeq: Number(row.turn_seq) } : {}),
    ...(row.turn_token ? { turnToken: row.turn_token } : {}),
    ...(Number(row.target_epoch) > 0 ? { targetEpoch: Number(row.target_epoch) } : {}),
    ...(row.trigger ? { trigger: row.trigger as "manual" | "auto" } : {}),
    createdAt: isoTime(row.created_at),
  };
}

export class ClickHouseNativeToolLedgerStorageAdapter implements NativeToolLedgerStorageAdapter {
  private client?: NativeToolLedgerClickHouseClient;
  private initialized = false;
  private closed = false;
  private readonly ledgerTable: string;
  private readonly eventTable: string;

  constructor(private readonly config: Pick<ProxyConfig, "clickhouse" | "nativeProxyTools">, options: { client?: NativeToolLedgerClickHouseClient } = {}) {
    this.ledgerTable = config.nativeProxyTools.ledgerStorage.table;
    this.eventTable = config.nativeProxyTools.ledgerStorage.eventTable;
    [config.clickhouse.database, this.ledgerTable, this.eventTable].forEach(assertIdentifier);
    this.client = options.client;
  }

  async initializeAndProbe(): Promise<void> {
    this.assertOpen(); if (this.initialized) return; await this.ensureClient();
    try {
      await this.getClient().command({ query: createNativeToolLedgerTableDdl(this.ledgerTable), clickhouse_settings: { wait_end_of_query: 1 } });
      await this.getClient().command({ query: createNativeToolContextEventTableDdl(this.eventTable), clickhouse_settings: { wait_end_of_query: 1 } });
      await this.getClient().query({ query: `SELECT ledger_id FROM ${this.ledgerTable} LIMIT 0`, format: "JSONEachRow" });
    } catch { throw new NativeToolLedgerStorageError("ClickHouse Native Tool ledger capability probe failed"); }
    this.initialized = true;
  }

  async appendRound(round: NativeToolLedgerRound): Promise<void> {
    this.assertReady();
    const existing = await this.findRound(round.ledgerId);
    if (existing) {
      if (same(existing, round)) return;
      throw new NativeToolLedgerStorageConflictError(`Native Tool ledger conflict: ${round.ledgerId}`);
    }
    await this.insert(this.ledgerTable, encodeNativeToolLedgerRow(round), "Native Tool ledger insert failed");
    const stored = await this.findRound(round.ledgerId);
    if (!stored || !same(stored, round)) throw new NativeToolLedgerStorageConflictError(`Native Tool ledger insert could not be verified: ${round.ledgerId}`);
  }

  async findRounds(scope: NativeToolSessionScope, contextEpoch: number): Promise<NativeToolLedgerRound[]> {
    this.assertReady();
    const rows = await this.queryRows<NativeToolLedgerRow>([
      `SELECT * FROM ${this.ledgerTable} FINAL`, this.scopeWhere(), "AND context_epoch={contextEpoch:UInt32}",
      "ORDER BY turn_seq, round, ledger_id",
    ].join("\n"), { ...scope, contextEpoch });
    return rows.map(decodeNativeToolLedgerRow);
  }

  async recordUserPrompt(scope: NativeToolSessionScope): Promise<NativeToolUserTurn> {
    this.assertReady();
    const context = await this.getSessionContext(scope);
    const value = { turnSeq: context.currentTurnSeq + 1, turnToken: randomUUID(), createdAt: new Date().toISOString() };
    await this.appendEvent({ eventId: randomUUID(), scope, type: "user_prompt", ...value });
    return value;
  }

  async findTurnByToken(scope: NativeToolSessionScope, token: string): Promise<NativeToolUserTurn | null> {
    this.assertReady();
    const rows = await this.queryRows<NativeToolContextEventRow>([
      `SELECT * FROM ${this.eventTable}`, this.scopeWhere(), "AND event_type='user_prompt' AND turn_token={token:String}",
      "ORDER BY created_at LIMIT 1",
    ].join("\n"), { ...scope, token });
    const event = rows[0] ? decodeNativeToolContextEventRow(rows[0]) : null;
    return event?.turnSeq && event.turnToken ? { turnSeq: event.turnSeq, turnToken: event.turnToken, createdAt: event.createdAt } : null;
  }

  async getSessionContext(scope: NativeToolSessionScope): Promise<NativeToolSessionContext> {
    this.assertReady();
    const rows = await this.queryRows<NativeToolContextEventRow>([
      `SELECT * FROM ${this.eventTable}`, this.scopeWhere(), "ORDER BY created_at, event_id",
    ].join("\n"), { ...scope });
    const events = rows.map(decodeNativeToolContextEventRow);
    const currentTurnSeq = events.reduce((max, event) => event.type === "user_prompt" ? Math.max(max, event.turnSeq ?? 0) : max, 0);
    const currentEpoch = events.reduce((max, event) => event.type === "compact_completed" ? Math.max(max, event.targetEpoch ?? 0) : max, 0);
    const pending = events.filter((event) => event.type === "compact_pending" && (event.targetEpoch ?? 0) > currentEpoch).map((event) => event.targetEpoch!);
    return { currentTurnSeq, currentEpoch, pendingCompactEpoch: pending.length ? Math.min(...pending) : null, compactStateError: events.some((event) => event.type === "compact_error") };
  }

  async beginCompact(scope: NativeToolSessionScope, trigger: "manual" | "auto"): Promise<{ changed: boolean; targetEpoch: number }> {
    const context = await this.getSessionContext(scope);
    if (context.pendingCompactEpoch !== null) return { changed: false, targetEpoch: context.pendingCompactEpoch };
    const targetEpoch = context.currentEpoch + 1;
    await this.appendEvent({ eventId: randomUUID(), scope, type: "compact_pending", targetEpoch, trigger, createdAt: new Date().toISOString() });
    return { changed: true, targetEpoch };
  }

  async completeCompact(scope: NativeToolSessionScope, trigger: "manual" | "auto"): Promise<{ changed: boolean; currentEpoch: number; error?: "post_without_pending" }> {
    const context = await this.getSessionContext(scope);
    if (context.pendingCompactEpoch === null) {
      await this.appendEvent({ eventId: randomUUID(), scope, type: "compact_error", trigger, createdAt: new Date().toISOString() });
      return { changed: false, currentEpoch: context.currentEpoch, error: "post_without_pending" };
    }
    await this.appendEvent({ eventId: randomUUID(), scope, type: "compact_completed", targetEpoch: context.pendingCompactEpoch, trigger, createdAt: new Date().toISOString() });
    return { changed: true, currentEpoch: context.pendingCompactEpoch };
  }

  async close(): Promise<void> { if (!this.closed) { this.closed = true; await this.client?.close().catch(() => {}); } }
  private async appendEvent(event: NativeToolContextEvent): Promise<void> { await this.insert(this.eventTable, encodeNativeToolContextEventRow(event), "Native Tool context event insert failed"); }
  private async findRound(ledgerId: string): Promise<NativeToolLedgerRound | null> {
    const rows = await this.queryRows<NativeToolLedgerRow>(`SELECT * FROM ${this.ledgerTable} FINAL WHERE ledger_id={ledgerId:String} LIMIT 1`, { ledgerId });
    return rows[0] ? decodeNativeToolLedgerRow(rows[0]) : null;
  }
  private scopeWhere(): string { return "WHERE space_id={spaceId:String} AND user_id={userId:String} AND agent_source={agentSource:String} AND session_id={sessionId:String}"; }
  private async queryRows<T>(query: string, query_params: Record<string, unknown>): Promise<T[]> {
    try { return await (await this.getClient().query({ query, query_params, format: "JSONEachRow", clickhouse_settings: { date_time_output_format: "iso" } })).json() as T[]; }
    catch { throw new NativeToolLedgerStorageError("ClickHouse Native Tool ledger query failed"); }
  }
  private async insert(table: string, value: Record<string, unknown>, message: string): Promise<void> {
    try { await this.getClient().insert({ table, values: [value], format: "JSONEachRow", clickhouse_settings: { wait_end_of_query: 1, date_time_input_format: "best_effort" } }); }
    catch { throw new NativeToolLedgerStorageError(message); }
  }
  private async ensureClient(): Promise<void> {
    if (this.client) return;
    if (!this.config.clickhouse.enabled || !this.config.clickhouse.url) throw new NativeToolLedgerStorageError("ClickHouse Native Tool ledger is unavailable");
    const { createClient } = await import("@clickhouse/client");
    const bootstrap = createClient({ url: this.config.clickhouse.url, username: this.config.clickhouse.user, password: this.config.clickhouse.password });
    try { await bootstrap.command({ query: `CREATE DATABASE IF NOT EXISTS ${this.config.clickhouse.database}` }); } finally { await bootstrap.close(); }
    this.client = createClient({ url: this.config.clickhouse.url, username: this.config.clickhouse.user, password: this.config.clickhouse.password, database: this.config.clickhouse.database, request_timeout: Math.max(10_000, this.config.nativeProxyTools.toolTimeoutMs * 2), keep_alive: { enabled: true } }) as unknown as NativeToolLedgerClickHouseClient;
  }
  private getClient(): NativeToolLedgerClickHouseClient { if (!this.client) throw new NativeToolLedgerStorageError("Native Tool ledger client is not initialized"); return this.client; }
  private assertReady(): void { this.assertOpen(); if (!this.initialized) throw new NativeToolLedgerStorageError("Native Tool ledger is not initialized"); }
  private assertOpen(): void { if (this.closed) throw new NativeToolLedgerStorageError("Native Tool ledger is closed"); }
}
