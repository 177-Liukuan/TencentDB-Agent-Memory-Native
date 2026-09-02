import { buildHistoryAnchors, canonicalHistoryJson } from "./history-anchor.js";
import type { NativeToolHistoryStorageAdapter } from "../db/native-tool-history-storage-adapter.js";
import type { ToolExecutionStorageAdapter } from "../db/tool-execution-storage-adapter.js";
import { buildNativeToolHistoryRecord } from "./native-tool-history-record.js";
import type {
  JsonValue,
  NativeToolHistoryRecord,
  NativeToolHistoryScope,
  NativeToolProtocol,
} from "./types.js";

export class NativeToolHistoryConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "NativeToolHistoryConflictError";
  }
}

function same(left: unknown, right: unknown): boolean {
  return canonicalHistoryJson(left) === canonicalHistoryJson(right);
}

function segmentMatches(items: readonly JsonValue[], start: number, projection: readonly JsonValue[]): boolean {
  return projection.every((item, offset) => same(items[start + offset], item));
}

function countProtocolIds(protocol: NativeToolProtocol, items: readonly JsonValue[]): {
  calls: Map<string, number>;
  results: Map<string, number>;
} {
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  const add = (target: Map<string, number>, id: unknown): void => {
    if (typeof id === "string") target.set(id, (target.get(id) ?? 0) + 1);
  };
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    if (protocol === "anthropic") {
      if (item.type === "tool_use") add(calls, item.id);
      if (item.type === "tool_result") add(results, item.tool_use_id);
    } else if (protocol === "openai") {
      if (item.role === "tool") add(results, item.tool_call_id);
      if (Array.isArray(item.tool_calls)) {
        for (const call of item.tool_calls) add(calls, (call as Record<string, unknown>).id);
      }
    } else {
      if (item.type === "function_call") add(calls, item.call_id);
      if (item.type === "function_call_output") add(results, item.call_id);
    }
    for (const child of Object.values(item)) inspect(child);
  };
  items.forEach(inspect);
  return { calls, results };
}

function validateRecordVisibility(
  protocol: NativeToolProtocol,
  items: readonly JsonValue[],
  records: readonly NativeToolHistoryRecord[],
): void {
  const { calls, results } = countProtocolIds(protocol, items);
  for (const record of records) {
    for (const callId of record.proxyCallIds) {
      if (calls.get(callId) !== 1 || results.get(callId) !== 1) {
        throw new NativeToolHistoryConflictError(`Native Tool history is ambiguous for call ${callId}`);
      }
    }
  }
}

export async function materializeNativeToolHistory(input: {
  protocol: NativeToolProtocol;
  items: readonly JsonValue[];
  /** Original client-visible items used for stable anchor lookup. */
  anchorItems?: readonly JsonValue[];
  scope: NativeToolHistoryScope;
  storage: NativeToolHistoryStorageAdapter;
}): Promise<{ items: JsonValue[]; historyIds: string[] }> {
  const original = structuredClone([...(input.anchorItems ?? input.items)]);
  const anchors = buildHistoryAnchors(original);
  const records = (await input.storage.findByAnchors(input.scope, anchors))
    .filter((record) => record.clientProtocol === input.protocol);
  const grouped = new Map<string, NativeToolHistoryRecord[]>();
  for (const record of records) {
    const key = `${record.anchor.itemCount}:${record.anchor.prefixDigest}`;
    const group = grouped.get(key) ?? [];
    group.push(record);
    grouped.set(key, group);
  }
  const orderedGroups = [...grouped.values()].sort((left, right) =>
    right[0].anchor.itemCount - left[0].anchor.itemCount
      || right[0].anchor.prefixDigest.localeCompare(left[0].anchor.prefixDigest));
  const output = structuredClone([...input.items]);
  for (const group of orderedGroups) {
    const ordered = [...group].sort((left, right) =>
      left.round - right.round
        || left.createdAt.localeCompare(right.createdAt)
        || left.historyId.localeCompare(right.historyId));
    const start = ordered[0].anchor.itemCount;
    const projection = ordered.flatMap((record) => record.clientProjection);
    const fullSegment = ordered.flatMap((record) => record.fullSegment);
    if (projection.length > 0) {
      if (!segmentMatches(original, start, projection)) {
        throw new NativeToolHistoryConflictError(
          `Client Tool projection conflicts with Native Tool history ${ordered.map((record) => record.historyId).join(", ")}`,
        );
      }
      output.splice(start, projection.length, ...structuredClone(fullSegment));
    } else {
      output.splice(start, 0, ...structuredClone(fullSegment));
    }
  }
  validateRecordVisibility(input.protocol, output, records);
  return {
    items: output,
    historyIds: records.map((record) => record.historyId),
  };
}

/** Lazily migrate terminal records that still exist in the short-lived state table. */
export async function backfillActiveCompletedNativeToolHistory(input: {
  scope: NativeToolHistoryScope & { contextVersion: string };
  stateStorage: ToolExecutionStorageAdapter;
  historyStorage: NativeToolHistoryStorageAdapter;
}): Promise<void> {
  const states = await input.stateStorage.findActiveBySession(input.scope);
  for (const state of states) {
    if (state.responseStreamStatus !== "completed"
      || state.slots.some((slot) => !["succeeded", "failed"].includes(slot.status))) continue;
    await input.historyStorage.appendCompletedBatch(buildNativeToolHistoryRecord(state));
  }
}
