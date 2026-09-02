import type {
  HistoryAnchor,
  NativeToolCompressionReceipt,
  NativeToolHistoryRecord,
  NativeToolHistoryScope,
} from "../native-proxy-tools/types.js";

export interface NativeToolHistoryStorageAdapter {
  initializeAndProbe(): Promise<void>;
  appendCompletedBatch(record: NativeToolHistoryRecord): Promise<void>;
  findByAnchors(
    scope: NativeToolHistoryScope,
    anchors: readonly HistoryAnchor[],
  ): Promise<NativeToolHistoryRecord[]>;
  saveCompressionReceipt(receipt: NativeToolCompressionReceipt): Promise<void>;
  findPendingCompressionReceipts(scope: NativeToolHistoryScope): Promise<NativeToolCompressionReceipt[]>;
  confirmCompression(receiptId: string, nextContextRoot: string): Promise<void>;
  backfillActiveCompletedStates(scope: NativeToolHistoryScope): Promise<void>;
  close(): Promise<void>;
}

export class NativeToolHistoryStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NativeToolHistoryStorageError";
  }
}

export class NativeToolHistoryStorageConflictError extends NativeToolHistoryStorageError {
  constructor(message: string) {
    super(message);
    this.name = "NativeToolHistoryStorageConflictError";
  }
}
