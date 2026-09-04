import type {
  NativeToolLedgerRound,
  NativeToolSessionContext,
  NativeToolSessionScope,
  NativeToolUserTurn,
} from "../native-proxy-tools/types.js";

export interface NativeToolLedgerStorageAdapter {
  initializeAndProbe(): Promise<void>;
  appendRound(round: NativeToolLedgerRound): Promise<void>;
  findRounds(scope: NativeToolSessionScope, contextEpoch: number): Promise<NativeToolLedgerRound[]>;
  recordUserPrompt(scope: NativeToolSessionScope): Promise<NativeToolUserTurn>;
  findTurnByToken(scope: NativeToolSessionScope, token: string): Promise<NativeToolUserTurn | null>;
  getSessionContext(scope: NativeToolSessionScope): Promise<NativeToolSessionContext>;
  beginCompact(
    scope: NativeToolSessionScope,
    trigger: "manual" | "auto",
  ): Promise<{ changed: boolean; targetEpoch: number }>;
  completeCompact(
    scope: NativeToolSessionScope,
    trigger: "manual" | "auto",
  ): Promise<{ changed: boolean; currentEpoch: number; error?: "post_without_pending" }>;
  close(): Promise<void>;
}

export class NativeToolLedgerStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeToolLedgerStorageError";
  }
}

export class NativeToolLedgerStorageConflictError extends NativeToolLedgerStorageError {
  constructor(message: string) {
    super(message);
    this.name = "NativeToolLedgerStorageConflictError";
  }
}
