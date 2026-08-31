import type {
  ToolExecutionContext,
  ToolExecutionScope,
  ToolExecutionStateKey,
} from "../native-proxy-tools/types.js";
import {
  ToolExecutionConflictError,
  ToolExecutionStorageError,
  cloneToolExecutionContext,
  isToolExecutionContextExpired,
  isValidClientDispatchTransition,
  mergeToolCallSlots,
  sameToolExecutionScope,
  serializeToolExecutionStateKey,
  validateToolExecutionContext,
  type ClientDispatchCas,
  type SlotExecutionClaim,
  type SlotResultCas,
  type StreamSnapshotCas,
  type ToolExecutionStorageAdapter,
} from "./tool-execution-storage-adapter.js";

/** Shared only by deterministic tests; this is never a production fallback. */
export interface InMemoryToolExecutionBackend {
  readonly rows: Map<string, ToolExecutionContext>;
  readonly locks: Map<string, Promise<void>>;
}

export function createInMemoryToolExecutionBackend(): InMemoryToolExecutionBackend {
  return {
    rows: new Map(),
    locks: new Map(),
  };
}

export interface InMemoryToolExecutionStorageAdapterOptions {
  backend?: InMemoryToolExecutionBackend;
  now?: () => Date;
}

export class InMemoryToolExecutionStorageAdapter implements ToolExecutionStorageAdapter {
  private readonly backend: InMemoryToolExecutionBackend;
  private readonly now: () => Date;
  private closed = false;

  constructor(options: InMemoryToolExecutionStorageAdapterOptions = {}) {
    this.backend = options.backend ?? createInMemoryToolExecutionBackend();
    this.now = options.now ?? (() => new Date());
  }

  async initializeAndProbe(): Promise<void> {
    this.assertOpen();
  }

  async create(context: ToolExecutionContext): Promise<void> {
    this.assertOpen();
    validateToolExecutionContext(context);
    const storageKey = serializeToolExecutionStateKey(context.key);
    await this.withKeyLock(storageKey, () => {
      if (this.backend.rows.has(storageKey)) {
        throw new ToolExecutionConflictError(`Tool execution batch already exists: ${context.key.toolBatchId}`);
      }
      this.backend.rows.set(storageKey, cloneToolExecutionContext(context));
    });
  }

  async get(key: ToolExecutionStateKey): Promise<ToolExecutionContext | null> {
    this.assertOpen();
    const current = this.backend.rows.get(serializeToolExecutionStateKey(key));
    if (!current || isToolExecutionContextExpired(current, this.now())) return null;
    return cloneToolExecutionContext(current);
  }

  async findByCallId(
    scope: ToolExecutionScope,
    callId: string,
  ): Promise<ToolExecutionContext | null> {
    this.assertOpen();
    const matches = this.activeRows(scope)
      .filter((context) => context.slots.some((slot) => slot.callId === callId))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    return matches.length > 0 ? cloneToolExecutionContext(matches[0]) : null;
  }

  async findActiveBySession(scope: ToolExecutionScope): Promise<ToolExecutionContext[]> {
    this.assertOpen();
    return this.activeRows(scope)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
      .map(cloneToolExecutionContext);
  }

  async compareAndSetStreamSnapshot(update: StreamSnapshotCas): Promise<boolean> {
    return this.mutate(update.key, update.expectedRevision, (current) => {
      if (current.responseStreamStatus === "aborted") return null;
      if (
        current.responseStreamStatus === "completed"
        && update.responseStreamStatus !== "completed"
      ) return null;
      const slots = mergeToolCallSlots(current.slots, update.slots);
      if (!slots) return null;
      current.assistantSkeleton = structuredClone(update.assistantSkeleton);
      current.slots = slots;
      current.responseStreamStatus = update.responseStreamStatus;
      return current;
    });
  }

  async compareAndSetClientDispatchStatus(update: ClientDispatchCas): Promise<boolean> {
    return this.mutate(update.key, update.expectedRevision, (current) => {
      if (
        current.clientDispatchStatus !== update.expectedStatus
        || !isValidClientDispatchTransition(update.expectedStatus, update.nextStatus)
      ) return null;
      current.clientDispatchStatus = update.nextStatus;
      return current;
    });
  }

  async tryClaimSlotExecution(claim: SlotExecutionClaim): Promise<boolean> {
    if (!claim.leaseOwner || !Number.isFinite(Date.parse(claim.leaseUntil))) return false;
    if (Date.parse(claim.leaseUntil) <= this.now().getTime()) return false;
    return this.mutate(claim.key, claim.expectedRevision, (current) => {
      const slot = current.slots.find((candidate) => candidate.callId === claim.callId);
      if (!slot || slot.owner !== "proxy" || !slot.argumentsComplete) return null;
      const expiredRunningLease = slot.status === "running"
        && (!slot.executionLeaseUntil || Date.parse(slot.executionLeaseUntil) <= this.now().getTime());
      if (slot.status !== "pending" && !expiredRunningLease) return null;

      slot.status = "running";
      slot.executionAttempt += 1;
      slot.executionLeaseOwner = claim.leaseOwner;
      slot.executionLeaseUntil = claim.leaseUntil;
      return current;
    });
  }

  async compareAndSetSlotResult(update: SlotResultCas): Promise<boolean> {
    return this.mutate(update.key, update.expectedRevision, (current) => {
      const slot = current.slots.find((candidate) => candidate.callId === update.callId);
      if (!slot || slot.status === "succeeded" || slot.status === "failed") return null;
      if (slot.owner === "proxy") {
        if (
          slot.status !== "running"
          || !update.leaseOwner
          || slot.executionLeaseOwner !== update.leaseOwner
        ) return null;
      } else if (slot.status !== "pending" || update.leaseOwner !== undefined) {
        return null;
      }

      slot.status = update.isError ? "failed" : "succeeded";
      slot.result = structuredClone(update.result);
      slot.isError = update.isError;
      return current;
    });
  }

  async markAborted(
    key: ToolExecutionStateKey,
    expectedRevision: number,
  ): Promise<boolean> {
    return this.mutate(key, expectedRevision, (current) => {
      if (current.responseStreamStatus !== "streaming") return null;
      current.responseStreamStatus = "aborted";
      return current;
    });
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private activeRows(scope: ToolExecutionScope): ToolExecutionContext[] {
    const now = this.now();
    return [...this.backend.rows.values()].filter((context) => (
      sameToolExecutionScope(context.key, scope)
      && !isToolExecutionContextExpired(context, now)
    ));
  }

  private async mutate(
    key: ToolExecutionStateKey,
    expectedRevision: number,
    update: (current: ToolExecutionContext) => ToolExecutionContext | null,
  ): Promise<boolean> {
    this.assertOpen();
    const storageKey = serializeToolExecutionStateKey(key);
    return this.withKeyLock(storageKey, () => {
      const stored = this.backend.rows.get(storageKey);
      if (
        !stored
        || stored.revision !== expectedRevision
        || isToolExecutionContextExpired(stored, this.now())
      ) return false;
      const next = update(cloneToolExecutionContext(stored));
      if (!next) return false;
      next.revision = stored.revision + 1;
      next.updatedAt = this.now().toISOString();
      validateToolExecutionContext(next);
      this.backend.rows.set(storageKey, cloneToolExecutionContext(next));
      return true;
    });
  }

  private async withKeyLock<T>(storageKey: string, operation: () => T): Promise<T> {
    const previous = this.backend.locks.get(storageKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.backend.locks.set(storageKey, tail);
    await previous;
    try {
      return operation();
    } finally {
      release();
      void tail.finally(() => {
        if (this.backend.locks.get(storageKey) === tail) {
          this.backend.locks.delete(storageKey);
        }
      });
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new ToolExecutionStorageError("Tool execution storage Adapter is closed");
  }
}
