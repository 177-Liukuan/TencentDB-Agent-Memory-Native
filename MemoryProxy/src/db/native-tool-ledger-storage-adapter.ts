import type {
  NativeToolLedgerRound,
  NativeToolSessionContext,
  NativeToolSessionScope,
  NativeToolUserTurn,
} from "../native-proxy-tools/types.js";

/**
 * 已完成 Native Tool 历史及 Claude Hook 事件的长期存储接口。
 * 这里不管理工具是否正在执行；该职责属于 ToolExecutionStorageAdapter。
 */
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
