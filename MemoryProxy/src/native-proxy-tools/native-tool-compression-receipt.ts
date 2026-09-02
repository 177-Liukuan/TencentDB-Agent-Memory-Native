import { createHash } from "node:crypto";

import type { NativeToolHistoryStorageAdapter } from "../db/native-tool-history-storage-adapter.js";
import { canonicalHistoryJson, createHistoryAnchor } from "./history-anchor.js";
import type {
  JsonValue,
  NativeToolCompressionReceipt,
  NativeToolHistoryScope,
} from "./types.js";

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalHistoryJson(value)).digest("hex");
}

export async function beginNativeToolCompression(input: {
  scope: NativeToolHistoryScope;
  sourceItems: readonly JsonValue[];
  historyIds: readonly string[];
  storage: NativeToolHistoryStorageAdapter;
  now?: () => Date;
}): Promise<NativeToolCompressionReceipt | null> {
  if (input.historyIds.length === 0) return null;
  const sourceRootDigest = createHistoryAnchor(input.sourceItems).prefixDigest;
  const historyIds = [...new Set(input.historyIds)].sort();
  const receiptId = digest({ scope: input.scope, sourceRootDigest, historyIds });
  const receipt: NativeToolCompressionReceipt = {
    receiptId,
    scope: structuredClone(input.scope),
    sourceRootDigest,
    historyIds,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
  };
  await input.storage.saveCompressionReceipt(receipt);
  return receipt;
}

export async function completeNativeToolCompression(input: {
  receipt: NativeToolCompressionReceipt;
  responseBody: string;
  storage: NativeToolHistoryStorageAdapter;
}): Promise<void> {
  await input.storage.saveCompressionReceipt({
    ...structuredClone(input.receipt),
    summaryDigest: digest(input.responseBody),
  });
}

export function responseCompletedForCompression(body: string): boolean {
  if (body.includes("response.completed")) return true;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return parsed.status === "completed" || parsed.type === "response.compaction";
  } catch {
    return false;
  }
}

export function looksLikeAnthropicCompressionRequest(items: readonly JsonValue[]): boolean {
  const last = items.at(-1);
  if (!last || typeof last !== "object" || Array.isArray(last)) return false;
  const message = last as Record<string, JsonValue>;
  if (message.role !== "user") return false;
  const text = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.flatMap((block) => {
        if (!block || typeof block !== "object" || Array.isArray(block)) return [];
        const value = block as Record<string, JsonValue>;
        return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
      }).join("\n")
      : "";
  return /(?:detailed\s+summary|summari[sz]e\s+(?:the|our)\s+(?:conversation|discussion)|context\s+compact|conversation\s+so\s+far)/i.test(text);
}

export function anthropicResponseCompletedForCompression(body: string): boolean {
  if (body.includes("event: message_stop")) return true;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return parsed.type === "message" && parsed.role === "assistant";
  } catch {
    return false;
  }
}

export function openAIChatResponseCompletedForCompression(body: string): boolean {
  if (body.includes("data: [DONE]")) return true;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return Array.isArray(parsed.choices);
  } catch {
    return false;
  }
}

export function trackNativeToolCompressionResponse(input: {
  response: Response;
  receipt: NativeToolCompressionReceipt | null;
  storage: NativeToolHistoryStorageAdapter;
  isComplete?: (body: string) => boolean;
}): Response {
  if (!input.receipt || !input.response.ok || !input.response.body) return input.response;
  const decoder = new TextDecoder();
  let responseBody = "";
  const tracked = input.response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      responseBody += decoder.decode(chunk, { stream: true });
      controller.enqueue(chunk);
    },
    async flush() {
      responseBody += decoder.decode();
      if ((input.isComplete ?? responseCompletedForCompression)(responseBody)) {
        await completeNativeToolCompression({ receipt: input.receipt!, responseBody, storage: input.storage });
      }
    },
  }));
  return new Response(tracked, {
    status: input.response.status,
    statusText: input.response.statusText,
    headers: input.response.headers,
  });
}

/**
 * Confirmation is bookkeeping only: stable anchors, rather than this marker,
 * decide which branch receives old history. Therefore an old branch remains
 * restorable even after a compacted branch has been confirmed.
 */
export async function confirmPendingNativeToolCompressions(input: {
  scope: NativeToolHistoryScope;
  currentItems: readonly JsonValue[];
  storage: NativeToolHistoryStorageAdapter;
}): Promise<void> {
  const currentRoot = createHistoryAnchor(input.currentItems).prefixDigest;
  const pending = await input.storage.findPendingCompressionReceipts(input.scope);
  for (const receipt of pending) {
    if (receipt.summaryDigest && receipt.sourceRootDigest !== currentRoot) {
      await input.storage.confirmCompression(receipt.receiptId, currentRoot);
    }
  }
}
