import { canonicalHistoryJson } from "../native-proxy-tools/history-anchor.js";
import type {
  HistoryAnchor,
  NativeToolCompressionReceipt,
  NativeToolHistoryRecord,
  NativeToolHistoryScope,
} from "../native-proxy-tools/types.js";
import {
  NativeToolHistoryStorageConflictError,
  NativeToolHistoryStorageError,
  type NativeToolHistoryStorageAdapter,
} from "./native-tool-history-storage-adapter.js";

function scopeKey(scope: NativeToolHistoryScope): string {
  return JSON.stringify([scope.spaceId, scope.userId, scope.agentSource, scope.sessionId]);
}

export class InMemoryNativeToolHistoryStorageAdapter implements NativeToolHistoryStorageAdapter {
  private readonly records: Map<string, NativeToolHistoryRecord>;
  private readonly receipts: Map<string, NativeToolCompressionReceipt>;
  private closed = false;

  constructor(options: { backend?: InMemoryNativeToolHistoryBackend } = {}) {
    this.records = options.backend?.records ?? new Map();
    this.receipts = options.backend?.receipts ?? new Map();
  }

  async initializeAndProbe(): Promise<void> { this.assertOpen(); }

  async appendCompletedBatch(record: NativeToolHistoryRecord): Promise<void> {
    this.assertOpen();
    const clone = structuredClone(record);
    const existing = this.records.get(record.historyId);
    if (existing) {
      if (canonicalHistoryJson(existing) === canonicalHistoryJson(clone)) return;
      throw new NativeToolHistoryStorageConflictError(`Native Tool history conflict: ${record.historyId}`);
    }
    this.records.set(record.historyId, clone);
  }

  async findByAnchors(
    scope: NativeToolHistoryScope,
    anchors: readonly HistoryAnchor[],
  ): Promise<NativeToolHistoryRecord[]> {
    this.assertOpen();
    const accepted = new Set(anchors.map((anchor) => `${anchor.itemCount}:${anchor.prefixDigest}`));
    return [...this.records.values()]
      .filter((record) => scopeKey(record.scope) === scopeKey(scope))
      .filter((record) => accepted.has(`${record.anchor.itemCount}:${record.anchor.prefixDigest}`))
      .sort((left, right) => left.anchor.itemCount - right.anchor.itemCount
        || left.round - right.round
        || left.createdAt.localeCompare(right.createdAt)
        || left.historyId.localeCompare(right.historyId))
      .map((record) => structuredClone(record));
  }

  async saveCompressionReceipt(receipt: NativeToolCompressionReceipt): Promise<void> {
    this.assertOpen();
    const existing = this.receipts.get(receipt.receiptId);
    if (existing) {
      const immutable = (value: NativeToolCompressionReceipt) => ({
        receiptId: value.receiptId,
        scope: value.scope,
        sourceRootDigest: value.sourceRootDigest,
        historyIds: value.historyIds,
        createdAt: value.createdAt,
      });
      if (canonicalHistoryJson(immutable(existing)) !== canonicalHistoryJson(immutable(receipt))) {
        throw new NativeToolHistoryStorageConflictError(`Native Tool compression receipt conflict: ${receipt.receiptId}`);
      }
    }
    this.receipts.set(receipt.receiptId, structuredClone(receipt));
  }

  async findPendingCompressionReceipts(scope: NativeToolHistoryScope): Promise<NativeToolCompressionReceipt[]> {
    this.assertOpen();
    return [...this.receipts.values()]
      .filter((receipt) => scopeKey(receipt.scope) === scopeKey(scope) && !receipt.confirmedAt)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((receipt) => structuredClone(receipt));
  }

  async confirmCompression(receiptId: string, nextContextRoot: string): Promise<void> {
    this.assertOpen();
    const receipt = this.receipts.get(receiptId);
    if (!receipt) throw new NativeToolHistoryStorageError("Native Tool compression receipt was not found");
    receipt.nextContextRoot = nextContextRoot;
    receipt.confirmedAt = new Date().toISOString();
  }

  async backfillActiveCompletedStates(_scope: NativeToolHistoryScope): Promise<void> {}

  async close(): Promise<void> { this.closed = true; }

  private assertOpen(): void {
    if (this.closed) throw new NativeToolHistoryStorageError("Native Tool history storage is closed");
  }
}

export interface InMemoryNativeToolHistoryBackend {
  records: Map<string, NativeToolHistoryRecord>;
  receipts: Map<string, NativeToolCompressionReceipt>;
}

export function createInMemoryNativeToolHistoryBackend(): InMemoryNativeToolHistoryBackend {
  return { records: new Map(), receipts: new Map() };
}
