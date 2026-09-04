import { randomUUID } from "node:crypto";

import type {
  NativeToolContextEvent,
  NativeToolLedgerRound,
  NativeToolSessionContext,
  NativeToolSessionScope,
  NativeToolUserTurn,
} from "../native-proxy-tools/types.js";
import {
  NativeToolLedgerStorageConflictError,
  NativeToolLedgerStorageError,
  type NativeToolLedgerStorageAdapter,
} from "./native-tool-ledger-storage-adapter.js";

function scopeKey(scope: NativeToolSessionScope): string {
  return JSON.stringify([scope.spaceId, scope.userId, scope.agentSource, scope.sessionId]);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface InMemoryNativeToolLedgerBackend {
  rounds: Map<string, NativeToolLedgerRound>;
  events: NativeToolContextEvent[];
}

export function createInMemoryNativeToolLedgerBackend(): InMemoryNativeToolLedgerBackend {
  return { rounds: new Map(), events: [] };
}

export class InMemoryNativeToolLedgerStorageAdapter implements NativeToolLedgerStorageAdapter {
  private readonly backend: InMemoryNativeToolLedgerBackend;
  private closed = false;

  constructor(options: { backend?: InMemoryNativeToolLedgerBackend } = {}) {
    this.backend = options.backend ?? createInMemoryNativeToolLedgerBackend();
  }

  async initializeAndProbe(): Promise<void> { this.assertOpen(); }

  async appendRound(round: NativeToolLedgerRound): Promise<void> {
    this.assertOpen();
    const existing = this.backend.rounds.get(round.ledgerId);
    if (existing) {
      if (sameValue(existing, round)) return;
      throw new NativeToolLedgerStorageConflictError(`Native Tool ledger conflict: ${round.ledgerId}`);
    }
    this.backend.rounds.set(round.ledgerId, structuredClone(round));
  }

  async findRounds(scope: NativeToolSessionScope, contextEpoch: number): Promise<NativeToolLedgerRound[]> {
    this.assertOpen();
    return [...this.backend.rounds.values()]
      .filter((round) => scopeKey(round.scope) === scopeKey(scope) && round.contextEpoch === contextEpoch)
      .sort((left, right) => left.turnSeq - right.turnSeq
        || left.round - right.round
        || left.ledgerId.localeCompare(right.ledgerId))
      .map((round) => structuredClone(round));
  }

  async recordUserPrompt(scope: NativeToolSessionScope): Promise<NativeToolUserTurn> {
    this.assertOpen();
    const context = this.context(scope);
    const turn: NativeToolUserTurn = {
      turnSeq: context.currentTurnSeq + 1,
      turnToken: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.backend.events.push({
      eventId: randomUUID(),
      scope: structuredClone(scope),
      type: "user_prompt",
      ...turn,
    });
    return structuredClone(turn);
  }

  async findTurnByToken(scope: NativeToolSessionScope, token: string): Promise<NativeToolUserTurn | null> {
    this.assertOpen();
    const event = this.eventsFor(scope).find((candidate) => (
      candidate.type === "user_prompt" && candidate.turnToken === token
    ));
    if (!event || event.turnSeq === undefined || !event.turnToken) return null;
    return { turnSeq: event.turnSeq, turnToken: event.turnToken, createdAt: event.createdAt };
  }

  async getSessionContext(scope: NativeToolSessionScope): Promise<NativeToolSessionContext> {
    this.assertOpen();
    return this.context(scope);
  }

  async beginCompact(
    scope: NativeToolSessionScope,
    trigger: "manual" | "auto",
  ): Promise<{ changed: boolean; targetEpoch: number }> {
    this.assertOpen();
    const context = this.context(scope);
    if (context.pendingCompactEpoch !== null) {
      return { changed: false, targetEpoch: context.pendingCompactEpoch };
    }
    const targetEpoch = context.currentEpoch + 1;
    this.backend.events.push({
      eventId: randomUUID(),
      scope: structuredClone(scope),
      type: "compact_pending",
      targetEpoch,
      trigger,
      createdAt: new Date().toISOString(),
    });
    return { changed: true, targetEpoch };
  }

  async completeCompact(
    scope: NativeToolSessionScope,
    trigger: "manual" | "auto",
  ): Promise<{ changed: boolean; currentEpoch: number; error?: "post_without_pending" }> {
    this.assertOpen();
    const context = this.context(scope);
    if (context.pendingCompactEpoch === null) {
      this.backend.events.push({
        eventId: randomUUID(),
        scope: structuredClone(scope),
        type: "compact_error",
        trigger,
        createdAt: new Date().toISOString(),
      });
      return { changed: false, currentEpoch: context.currentEpoch, error: "post_without_pending" };
    }
    this.backend.events.push({
      eventId: randomUUID(),
      scope: structuredClone(scope),
      type: "compact_completed",
      targetEpoch: context.pendingCompactEpoch,
      trigger,
      createdAt: new Date().toISOString(),
    });
    return { changed: true, currentEpoch: context.pendingCompactEpoch };
  }

  async close(): Promise<void> { this.closed = true; }

  private context(scope: NativeToolSessionScope): NativeToolSessionContext {
    const events = this.eventsFor(scope);
    const currentTurnSeq = events.reduce((max, event) => (
      event.type === "user_prompt" ? Math.max(max, event.turnSeq ?? 0) : max
    ), 0);
    const currentEpoch = events.reduce((max, event) => (
      event.type === "compact_completed" ? Math.max(max, event.targetEpoch ?? 0) : max
    ), 0);
    const pendingTargets = events
      .filter((event) => event.type === "compact_pending" && (event.targetEpoch ?? 0) > currentEpoch)
      .map((event) => event.targetEpoch as number);
    return {
      currentTurnSeq,
      currentEpoch,
      pendingCompactEpoch: pendingTargets.length > 0 ? Math.min(...pendingTargets) : null,
      compactStateError: events.some((event) => event.type === "compact_error"),
    };
  }

  private eventsFor(scope: NativeToolSessionScope): NativeToolContextEvent[] {
    return this.backend.events.filter((event) => scopeKey(event.scope) === scopeKey(scope));
  }

  private assertOpen(): void {
    if (this.closed) throw new NativeToolLedgerStorageError("Native Tool ledger storage is closed");
  }
}
