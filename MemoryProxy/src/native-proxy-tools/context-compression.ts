import { randomUUID } from "node:crypto";

import type { ToolExecutionStorageAdapter } from "../db/tool-execution-storage-adapter.js";
import { buildToolResultMessage } from "./anthropic-response-rebuilder.js";
import type {
  JsonValue, ToolExecutionContext, ToolExecutionScope, ToolExecutionStateKey,
} from "./types.js";

export interface ContextCompressionPreparation {
  body: Record<string, unknown>;
  checkpointId: string;
  coveredStates: Array<{ key: ToolExecutionStateKey; revision: number }>;
}

function terminal(context: ToolExecutionContext): boolean {
  return context.responseStreamStatus === "completed"
    && context.upstreamSnapshot.compressionCheckpoint === undefined
    && context.slots.some((slot) => slot.owner === "proxy")
    && context.slots.every((slot) => slot.status === "succeeded" || slot.status === "failed");
}

function hiddenMessages(context: ToolExecutionContext): JsonValue[] {
  if (context.protocol === "responses") {
    return [
      ...structuredClone(context.assistantSkeleton),
      ...[...context.slots].sort((left, right) => left.slotIndex - right.slotIndex).map((slot) => ({
        type: "function_call_output",
        call_id: slot.callId,
        output: typeof slot.result === "string" ? slot.result : JSON.stringify(slot.result ?? null),
      })),
    ];
  }
  if (context.protocol === "openai") {
    return [
      { role: "assistant", content: null, tool_calls: structuredClone(context.assistantSkeleton) },
      ...[...context.slots]
        .sort((left, right) => left.slotIndex - right.slotIndex)
        .map((slot) => ({
          role: "tool",
          tool_call_id: slot.callId,
          content: typeof slot.result === "string" ? slot.result : JSON.stringify(slot.result ?? null),
        })),
    ];
  }
  return [
    { role: "assistant", content: structuredClone(context.assistantSkeleton) },
    buildToolResultMessage(context.slots) as unknown as JsonValue,
  ];
}

/** Rehydrate only successful, not-yet-covered hidden Tool batches. */
export async function prepareContextCompression(input: {
  body: Record<string, unknown>;
  scope: ToolExecutionScope;
  storage: ToolExecutionStorageAdapter;
  createId?: () => string;
}): Promise<ContextCompressionPreparation | null> {
  const contexts = (await input.storage.findActiveBySession(input.scope))
    .filter(terminal)
    .sort((left, right) => left.turnSeq - right.turnSeq || left.round - right.round);
  if (contexts.length === 0) return null;
  const field = contexts.every((context) => context.protocol === "responses") ? "input" : "messages";
  const messages = Array.isArray(input.body[field])
    ? structuredClone(input.body[field]) as unknown[]
    : [];
  const insertAt = Math.max(0, messages.length - 1);
  messages.splice(insertAt, 0, ...contexts.flatMap(hiddenMessages));
  return {
    body: { ...structuredClone(input.body), [field]: messages },
    checkpointId: (input.createId ?? randomUUID)(),
    coveredStates: contexts.map((context) => ({ key: structuredClone(context.key), revision: context.revision })),
  };
}

/** Persist coverage only after the compression upstream has completed successfully. */
export async function commitContextCompressionCheckpoint(input: {
  preparation: ContextCompressionPreparation;
  storage: ToolExecutionStorageAdapter;
  now?: () => Date;
  maxAttempts?: number;
}): Promise<void> {
  const coveredAt = (input.now ?? (() => new Date()))().toISOString();
  for (const state of input.preparation.coveredStates) {
    let revision = state.revision;
    let saved = false;
    for (let attempt = 0; attempt < (input.maxAttempts ?? 8); attempt++) {
      saved = await input.storage.compareAndSetCompressionCheckpoint({
        key: state.key,
        expectedRevision: revision,
        checkpointId: input.preparation.checkpointId,
        coveredAt,
      });
      if (saved) break;
      const current = await input.storage.get(state.key);
      if (!current) break;
      if (current.upstreamSnapshot.compressionCheckpoint) {
        saved = true;
        break;
      }
      revision = current.revision;
    }
    if (!saved) throw new Error("Context Compression checkpoint could not be persisted");
  }
}
