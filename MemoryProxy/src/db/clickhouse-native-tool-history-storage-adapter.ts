import { createHash } from "node:crypto";

import type { ProxyConfig } from "../types.js";
import { canonicalHistoryJson } from "../native-proxy-tools/history-anchor.js";
import type {
  HistoryAnchor,
  NativeToolCompressionReceipt,
  NativeToolHistoryRecord,
  NativeToolHistoryScope,
  NativeToolProtocol,
} from "../native-proxy-tools/types.js";
import {
  NativeToolHistoryStorageConflictError,
  NativeToolHistoryStorageError,
  type NativeToolHistoryStorageAdapter,
} from "./native-tool-history-storage-adapter.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NO_EXPIRY_SENTINEL = "2100-01-01 00:00:00.000";

interface ClickHouseCommand { query: string; query_params?: Record<string, unknown>; clickhouse_settings?: Record<string, unknown> }
interface ClickHouseInsert { table: string; values: Record<string, unknown>[]; format: "JSONEachRow"; clickhouse_settings?: Record<string, unknown> }
interface ClickHouseQuery { query: string; query_params?: Record<string, unknown>; format: "JSONEachRow"; clickhouse_settings?: Record<string, unknown> }
export interface NativeToolHistoryClickHouseClient {
  command(input: ClickHouseCommand): Promise<unknown>;
  insert(input: ClickHouseInsert): Promise<unknown>;
  query(input: ClickHouseQuery): Promise<{ json(): Promise<unknown[]> }>;
  close(): Promise<unknown>;
}

export interface NativeToolHistoryRow extends Record<string, unknown> {
  history_id: string;
  logical_turn_id: string;
  space_id: string;
  user_id: string;
  agent_source: string;
  session_id: string;
  client_protocol: string;
  upstream_protocol: string;
  anchor_version: number | string;
  anchor_prefix_digest: string;
  anchor_item_count: number | string;
  round: number | string;
  full_segment_json: string;
  client_projection_json: string;
  proxy_call_ids: string[];
  client_call_ids: string[];
  has_expiry: number | string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

function assertIdentifier(value: string, path: string): void {
  if (!IDENTIFIER.test(value)) throw new NativeToolHistoryStorageError(`${path} must be a safe ClickHouse identifier`);
}

function clickHouseTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new NativeToolHistoryStorageError("Native Tool history timestamp is invalid");
  return new Date(timestamp).toISOString().replace("T", " ").replace("Z", "").slice(0, 23);
}

function isoTime(value: string): string {
  const timestamp = Date.parse(value) || Date.parse(`${value.replace(" ", "T")}Z`);
  if (!Number.isFinite(timestamp)) throw new NativeToolHistoryStorageError("ClickHouse Native Tool history row is corrupt");
  return new Date(timestamp).toISOString();
}

function json<T>(value: string): T {
  try { return JSON.parse(value) as T; } catch { throw new NativeToolHistoryStorageError("ClickHouse Native Tool history row is corrupt"); }
}

export function createNativeToolHistoryTableDdl(table: string): string {
  assertIdentifier(table, "Native Tool history table");
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    "  history_id String,",
    "  logical_turn_id String,",
    "  space_id String, user_id String, agent_source LowCardinality(String), session_id String,",
    "  client_protocol LowCardinality(String), upstream_protocol LowCardinality(String),",
    "  anchor_version UInt8, anchor_prefix_digest FixedString(64), anchor_item_count UInt64,",
    "  round UInt32, full_segment_json String, client_projection_json String,",
    "  proxy_call_ids Array(String), client_call_ids Array(String),",
    "  has_expiry UInt8, expires_at DateTime64(3, 'UTC'),",
    "  created_at DateTime64(3, 'UTC'), updated_at DateTime64(3, 'UTC')",
    ") ENGINE = ReplacingMergeTree(updated_at)",
    "ORDER BY (space_id, user_id, agent_source, session_id, history_id)",
    "TTL expires_at DELETE WHERE has_expiry = 1",
  ].join("\n");
}

export function createNativeToolCheckpointTableDdl(table: string): string {
  assertIdentifier(table, "Native Tool checkpoint table");
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    "  receipt_id String, space_id String, user_id String, agent_source LowCardinality(String), session_id String,",
    "  source_root_digest FixedString(64), history_ids Array(String), summary_digest String DEFAULT '',",
    "  next_context_root String DEFAULT '', created_at DateTime64(3, 'UTC'), confirmed_at Nullable(DateTime64(3, 'UTC')),",
    "  updated_at DateTime64(3, 'UTC')",
    ") ENGINE = ReplacingMergeTree(updated_at)",
    "ORDER BY (space_id, user_id, agent_source, session_id, receipt_id)",
  ].join("\n");
}

export function encodeNativeToolHistoryRow(record: NativeToolHistoryRecord): NativeToolHistoryRow {
  return {
    history_id: record.historyId,
    logical_turn_id: record.logicalTurnId,
    space_id: record.scope.spaceId,
    user_id: record.scope.userId,
    agent_source: record.scope.agentSource,
    session_id: record.scope.sessionId,
    client_protocol: record.clientProtocol,
    upstream_protocol: record.upstreamProtocol,
    anchor_version: record.anchor.version,
    anchor_prefix_digest: record.anchor.prefixDigest,
    anchor_item_count: record.anchor.itemCount,
    round: record.round,
    full_segment_json: JSON.stringify(record.fullSegment),
    client_projection_json: JSON.stringify(record.clientProjection),
    proxy_call_ids: [...record.proxyCallIds],
    client_call_ids: [...record.clientCallIds],
    has_expiry: record.expiresAt ? 1 : 0,
    expires_at: record.expiresAt ? clickHouseTime(record.expiresAt) : NO_EXPIRY_SENTINEL,
    created_at: clickHouseTime(record.createdAt),
    updated_at: clickHouseTime(record.createdAt),
  };
}

export function decodeNativeToolHistoryRow(row: NativeToolHistoryRow): NativeToolHistoryRecord {
  const clientProtocol = row.client_protocol as NativeToolProtocol;
  const upstreamProtocol = row.upstream_protocol as NativeToolProtocol;
  if (!(["anthropic", "openai", "responses"] as string[]).includes(clientProtocol)
    || !(["anthropic", "openai", "responses"] as string[]).includes(upstreamProtocol)
    || Number(row.anchor_version) !== 1
    || !/^[a-f0-9]{64}$/.test(row.anchor_prefix_digest)) {
    throw new NativeToolHistoryStorageError("ClickHouse Native Tool history row is corrupt");
  }
  return {
    historyId: row.history_id,
    logicalTurnId: row.logical_turn_id,
    scope: { spaceId: row.space_id, userId: row.user_id, agentSource: row.agent_source, sessionId: row.session_id },
    clientProtocol,
    upstreamProtocol,
    anchor: { version: 1, prefixDigest: row.anchor_prefix_digest, itemCount: Number(row.anchor_item_count) },
    round: Number(row.round),
    fullSegment: json(row.full_segment_json),
    clientProjection: json(row.client_projection_json),
    proxyCallIds: [...row.proxy_call_ids],
    clientCallIds: [...row.client_call_ids],
    createdAt: isoTime(row.created_at),
    ...(Number(row.has_expiry) === 1 ? { expiresAt: isoTime(row.expires_at) } : {}),
  };
}

export class ClickHouseNativeToolHistoryStorageAdapter implements NativeToolHistoryStorageAdapter {
  private client?: NativeToolHistoryClickHouseClient;
  private readonly database: string;
  private readonly table: string;
  private readonly checkpointTable: string;
  private initialized = false;
  private closed = false;

  constructor(
    private readonly config: Pick<ProxyConfig, "clickhouse" | "nativeProxyTools">,
    options: { client?: NativeToolHistoryClickHouseClient } = {},
  ) {
    this.database = config.clickhouse.database;
    this.table = config.nativeProxyTools.historyStorage.table;
    this.checkpointTable = config.nativeProxyTools.historyStorage.checkpointTable;
    [this.database, this.table, this.checkpointTable].forEach((value) => assertIdentifier(value, "ClickHouse identifier"));
    this.client = options.client;
  }

  async initializeAndProbe(): Promise<void> {
    this.assertOpen();
    if (this.initialized) return;
    await this.ensureClient();
    try {
      await this.getClient().command({ query: createNativeToolHistoryTableDdl(this.table), clickhouse_settings: { wait_end_of_query: 1 } });
      await this.getClient().command({ query: createNativeToolCheckpointTableDdl(this.checkpointTable), clickhouse_settings: { wait_end_of_query: 1 } });
      await this.getClient().query({ query: `SELECT history_id FROM ${this.table} LIMIT 0`, format: "JSONEachRow" });
    } catch {
      throw new NativeToolHistoryStorageError("ClickHouse Native Tool history capability probe failed");
    }
    this.initialized = true;
  }

  async appendCompletedBatch(record: NativeToolHistoryRecord): Promise<void> {
    this.assertReady();
    const withExpiry = record.expiresAt || this.config.nativeProxyTools.historyStorage.ttlDays === 0
      ? structuredClone(record)
      : { ...structuredClone(record), expiresAt: new Date(Date.parse(record.createdAt)
        + this.config.nativeProxyTools.historyStorage.ttlDays * 86_400_000).toISOString() };
    const existing = await this.findById(record.historyId);
    if (existing) {
      if (canonicalHistoryJson(existing) === canonicalHistoryJson(withExpiry)) return;
      throw new NativeToolHistoryStorageConflictError(`Native Tool history conflict: ${record.historyId}`);
    }
    try {
      await this.getClient().insert({
        table: this.table,
        values: [encodeNativeToolHistoryRow(withExpiry)],
        format: "JSONEachRow",
        clickhouse_settings: {
          wait_end_of_query: 1,
          date_time_input_format: "best_effort",
          insert_deduplicate: 1,
          insert_deduplication_token: createHash("sha256").update(record.historyId).digest("hex"),
        },
      });
    } catch { throw new NativeToolHistoryStorageError("ClickHouse Native Tool history insert failed"); }
    const observed = await this.findById(record.historyId);
    if (!observed || canonicalHistoryJson(observed) !== canonicalHistoryJson(withExpiry)) {
      throw new NativeToolHistoryStorageConflictError(`Native Tool history insert could not be verified: ${record.historyId}`);
    }
  }

  async findByAnchors(scope: NativeToolHistoryScope, anchors: readonly HistoryAnchor[]): Promise<NativeToolHistoryRecord[]> {
    this.assertReady();
    if (anchors.length === 0) return [];
    const result = await this.getClient().query({
      query: [
        `SELECT * FROM ${this.table} FINAL`,
        "WHERE space_id={spaceId:String} AND user_id={userId:String} AND agent_source={agentSource:String} AND session_id={sessionId:String}",
        "AND has(arrayZip({anchorItemCounts:Array(UInt64)}, {anchorDigests:Array(String)}), (anchor_item_count, toString(anchor_prefix_digest)))",
        "AND (has_expiry=0 OR expires_at > now64(3))",
        "ORDER BY anchor_item_count, round, created_at, history_id",
      ].join("\n"),
      query_params: {
        ...scope,
        anchorItemCounts: anchors.map((anchor) => anchor.itemCount),
        anchorDigests: anchors.map((anchor) => anchor.prefixDigest),
      },
      format: "JSONEachRow",
      clickhouse_settings: { date_time_output_format: "iso" },
    });
    return (await result.json() as NativeToolHistoryRow[]).map(decodeNativeToolHistoryRow);
  }

  async saveCompressionReceipt(receipt: NativeToolCompressionReceipt): Promise<void> {
    this.assertReady();
    const existing = await this.findCompressionReceiptRow(receipt.receiptId);
    if (existing) {
      const storedIdentity = {
        receiptId: String(existing.receipt_id),
        scope: {
          spaceId: String(existing.space_id), userId: String(existing.user_id),
          agentSource: String(existing.agent_source), sessionId: String(existing.session_id),
        },
        sourceRootDigest: String(existing.source_root_digest),
        historyIds: Array.isArray(existing.history_ids) ? existing.history_ids.map(String) : [],
        createdAt: isoTime(String(existing.created_at)),
      };
      const requestedIdentity = {
        receiptId: receipt.receiptId, scope: receipt.scope,
        sourceRootDigest: receipt.sourceRootDigest, historyIds: receipt.historyIds,
        createdAt: receipt.createdAt,
      };
      if (canonicalHistoryJson(storedIdentity) !== canonicalHistoryJson(requestedIdentity)) {
        throw new NativeToolHistoryStorageConflictError(`Native Tool compression receipt conflict: ${receipt.receiptId}`);
      }
    }
    const receiptUpdatedAt = new Date(Math.max(
      Date.now(),
      Date.parse(receipt.createdAt) + (receipt.summaryDigest || receipt.confirmedAt ? 1 : 0),
    )).toISOString();
    const row: Record<string, unknown> = {
      receipt_id: receipt.receiptId,
      ...Object.fromEntries(Object.entries(receipt.scope).map(([key, value]) => [key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), value])),
      source_root_digest: receipt.sourceRootDigest,
      history_ids: receipt.historyIds,
      summary_digest: receipt.summaryDigest ?? "",
      next_context_root: receipt.nextContextRoot ?? "",
      created_at: clickHouseTime(receipt.createdAt),
      confirmed_at: receipt.confirmedAt ? clickHouseTime(receipt.confirmedAt) : null,
      updated_at: clickHouseTime(receiptUpdatedAt),
    };
    try {
      await this.getClient().insert({ table: this.checkpointTable, values: [row], format: "JSONEachRow",
        clickhouse_settings: { wait_end_of_query: 1, date_time_input_format: "best_effort" } });
    } catch { throw new NativeToolHistoryStorageError("ClickHouse Native Tool compression receipt insert failed"); }
  }

  async findPendingCompressionReceipts(scope: NativeToolHistoryScope): Promise<NativeToolCompressionReceipt[]> {
    this.assertReady();
    const result = await this.getClient().query({
      query: [
        `SELECT * FROM ${this.checkpointTable} FINAL`,
        "WHERE space_id={spaceId:String} AND user_id={userId:String} AND agent_source={agentSource:String} AND session_id={sessionId:String}",
        "AND isNull(confirmed_at)",
        "ORDER BY created_at, receipt_id",
      ].join("\n"),
      query_params: { ...scope },
      format: "JSONEachRow",
      clickhouse_settings: { date_time_output_format: "iso" },
    });
    return (await result.json() as Record<string, unknown>[]).map((row) => ({
      receiptId: String(row.receipt_id),
      scope: {
        spaceId: String(row.space_id), userId: String(row.user_id),
        agentSource: String(row.agent_source), sessionId: String(row.session_id),
      },
      sourceRootDigest: String(row.source_root_digest),
      historyIds: Array.isArray(row.history_ids) ? row.history_ids.map(String) : [],
      ...(row.summary_digest ? { summaryDigest: String(row.summary_digest) } : {}),
      ...(row.next_context_root ? { nextContextRoot: String(row.next_context_root) } : {}),
      createdAt: isoTime(String(row.created_at)),
      ...(row.confirmed_at ? { confirmedAt: isoTime(String(row.confirmed_at)) } : {}),
    }));
  }

  async confirmCompression(receiptId: string, nextContextRoot: string): Promise<void> {
    this.assertReady();
    const existing = await this.findCompressionReceiptRow(receiptId);
    if (!existing) throw new NativeToolHistoryStorageError("Native Tool compression receipt was not found");
    const now = clickHouseTime(new Date(Math.max(
      Date.now(),
      Date.parse(String(existing.updated_at)) + 1,
    )).toISOString());
    try {
      await this.getClient().insert({
        table: this.checkpointTable,
        values: [{ ...existing, next_context_root: nextContextRoot, confirmed_at: now, updated_at: now }],
        format: "JSONEachRow",
        clickhouse_settings: { wait_end_of_query: 1, date_time_input_format: "best_effort" },
      });
    } catch { throw new NativeToolHistoryStorageError("ClickHouse Native Tool compression confirmation failed"); }
  }

  async backfillActiveCompletedStates(_scope: NativeToolHistoryScope): Promise<void> {}

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client?.close().catch(() => {});
  }

  private async findById(historyId: string): Promise<NativeToolHistoryRecord | null> {
    const result = await this.getClient().query({
      query: `SELECT * FROM ${this.table} FINAL WHERE history_id={historyId:String} ORDER BY updated_at DESC LIMIT 1`,
      query_params: { historyId }, format: "JSONEachRow", clickhouse_settings: { date_time_output_format: "iso" },
    });
    const rows = await result.json() as NativeToolHistoryRow[];
    return rows[0] ? decodeNativeToolHistoryRow(rows[0]) : null;
  }

  private async findCompressionReceiptRow(receiptId: string): Promise<Record<string, unknown> | null> {
    const result = await this.getClient().query({
      query: `SELECT * FROM ${this.checkpointTable} FINAL WHERE receipt_id={receiptId:String} LIMIT 1`,
      query_params: { receiptId },
      format: "JSONEachRow",
      clickhouse_settings: { date_time_output_format: "iso" },
    });
    const rows = await result.json() as Record<string, unknown>[];
    return rows[0] ?? null;
  }

  private async ensureClient(): Promise<void> {
    if (this.client) return;
    if (!this.config.clickhouse.enabled || !this.config.clickhouse.url) throw new NativeToolHistoryStorageError("ClickHouse Native Tool history is unavailable");
    const { createClient } = await import("@clickhouse/client");
    const bootstrap = createClient({ url: this.config.clickhouse.url, username: this.config.clickhouse.user, password: this.config.clickhouse.password });
    try { await bootstrap.command({ query: `CREATE DATABASE IF NOT EXISTS ${this.database}` }); } finally { await bootstrap.close(); }
    this.client = createClient({
      url: this.config.clickhouse.url, username: this.config.clickhouse.user, password: this.config.clickhouse.password,
      database: this.database, request_timeout: Math.max(10_000, this.config.nativeProxyTools.toolTimeoutMs * 2), keep_alive: { enabled: true },
    }) as unknown as NativeToolHistoryClickHouseClient;
  }

  private getClient(): NativeToolHistoryClickHouseClient {
    if (!this.client) throw new NativeToolHistoryStorageError("ClickHouse Native Tool history client is not initialized");
    return this.client;
  }
  private assertReady(): void { this.assertOpen(); if (!this.initialized) throw new NativeToolHistoryStorageError("Native Tool history storage is not initialized"); }
  private assertOpen(): void { if (this.closed) throw new NativeToolHistoryStorageError("Native Tool history storage is closed"); }
}
