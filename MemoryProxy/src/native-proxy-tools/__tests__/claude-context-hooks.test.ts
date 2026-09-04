import { describe, expect, it } from "vitest";

import { InMemoryNativeToolLedgerStorageAdapter } from "../../db/in-memory-native-tool-ledger-storage-adapter.js";
import { applyClaudeContextHook } from "../claude-context-hooks.js";
import { extractClaudeTurnMarkers } from "../turn-marker.js";
import type { NativeToolSessionScope } from "../types.js";

const scope: NativeToolSessionScope = {
  spaceId: "space-1",
  userId: "user-1",
  agentSource: "claude-code",
  sessionId: "session-1",
};

describe("Claude Code context hooks", () => {
  it("creates one real turn and returns a marker through additionalContext", async () => {
    const storage = new InMemoryNativeToolLedgerStorageAdapter();

    const result = await applyClaudeContextHook({
      scope,
      storage,
      payload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        prompt: "检查项目",
      },
    });

    expect(result.status).toBe(200);
    const additionalContext = result.body?.hookSpecificOutput?.additionalContext;
    expect(typeof additionalContext).toBe("string");
    const marker = extractClaudeTurnMarkers([{ role: "user", content: additionalContext }]).markers[0];
    expect(marker).toBeDefined();
    await expect(storage.findTurnByToken(scope, marker!.token)).resolves.toMatchObject({ turnSeq: 1 });
  });

  it("does not create a user turn for the built-in compact command", async () => {
    const storage = new InMemoryNativeToolLedgerStorageAdapter();

    const result = await applyClaudeContextHook({
      scope,
      storage,
      payload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        prompt: "/compact keep database details",
      },
    });

    expect(result).toEqual({ status: 204 });
    await expect(storage.getSessionContext(scope)).resolves.toMatchObject({ currentTurnSeq: 0 });
  });

  it("keeps the old epoch at PreCompact and changes it at PostCompact", async () => {
    const storage = new InMemoryNativeToolLedgerStorageAdapter();

    await expect(applyClaudeContextHook({
      scope,
      storage,
      payload: { hook_event_name: "PreCompact", session_id: "session-1", trigger: "auto" },
    })).resolves.toEqual({ status: 204 });
    await expect(storage.getSessionContext(scope)).resolves.toMatchObject({
      currentEpoch: 0,
      pendingCompactEpoch: 1,
    });

    await expect(applyClaudeContextHook({
      scope,
      storage,
      payload: {
        hook_event_name: "PostCompact",
        session_id: "session-1",
        trigger: "auto",
        compact_summary: "summary",
      },
    })).resolves.toEqual({ status: 204 });
    await expect(storage.getSessionContext(scope)).resolves.toMatchObject({ currentEpoch: 1 });
  });

  it("rejects a hook whose body belongs to another session", async () => {
    const storage = new InMemoryNativeToolLedgerStorageAdapter();

    await expect(applyClaudeContextHook({
      scope,
      storage,
      payload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "other-session",
        prompt: "hello",
      },
    })).resolves.toEqual({
      status: 400,
      body: { error: "hook_session_mismatch" },
    });
  });
});
