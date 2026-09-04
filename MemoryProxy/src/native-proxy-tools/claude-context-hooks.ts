import type { NativeToolLedgerStorageAdapter } from "../db/native-tool-ledger-storage-adapter.js";
import { createClaudeTurnMarker } from "./turn-marker.js";
import type { JsonValue, NativeToolSessionScope } from "./types.js";

export interface ClaudeContextHookResult {
  status: number;
  body?: {
    error?: string;
    hookSpecificOutput?: {
      hookEventName: "UserPromptSubmit";
      additionalContext: string;
    };
  };
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function compactTrigger(payload: Record<string, unknown>): "manual" | "auto" | null {
  return payload.trigger === "manual" || payload.trigger === "auto" ? payload.trigger : null;
}

/** 内置 /compact 是压缩命令，不是交给模型回答的新问题。 */
function isCompactCommand(prompt: string): boolean {
  return /^\/compact(?:\s|$)/.test(prompt);
}

export async function applyClaudeContextHook(input: {
  scope: NativeToolSessionScope;
  payload: Record<string, unknown>;
  storage: NativeToolLedgerStorageAdapter;
}): Promise<ClaudeContextHookResult> {
  const sessionId = stringField(input.payload, "session_id");
  if (!sessionId || sessionId !== input.scope.sessionId) {
    return { status: 400, body: { error: "hook_session_mismatch" } };
  }

  const eventName = stringField(input.payload, "hook_event_name");
  if (eventName === "UserPromptSubmit") {
    const prompt = stringField(input.payload, "prompt");
    if (!prompt) return { status: 400, body: { error: "hook_prompt_missing" } };
    if (isCompactCommand(prompt)) return { status: 204 };

    // 先可靠保存，再把位置标记交给 Claude Code；不能先返回后落库。
    const turn = await input.storage.recordUserPrompt(input.scope);
    return {
      status: 200,
      body: {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: createClaudeTurnMarker(turn.turnToken),
        },
      },
    };
  }

  if (eventName === "PreCompact") {
    const trigger = compactTrigger(input.payload);
    if (!trigger) return { status: 400, body: { error: "hook_trigger_invalid" } };
    await input.storage.beginCompact(input.scope, trigger);
    return { status: 204 };
  }

  if (eventName === "PostCompact") {
    const trigger = compactTrigger(input.payload);
    if (!trigger) return { status: 400, body: { error: "hook_trigger_invalid" } };
    const result = await input.storage.completeCompact(input.scope, trigger);
    if (result.error) return { status: 409, body: { error: result.error } };
    return { status: 204 };
  }

  return { status: 400, body: { error: "hook_event_unsupported" } };
}

// 保持 Hook 结果可以直接交给 Hono JSON 响应，不携带 undefined 等非 JSON 值。
export function hookResultBody(result: ClaudeContextHookResult): JsonValue | undefined {
  return result.body as JsonValue | undefined;
}
