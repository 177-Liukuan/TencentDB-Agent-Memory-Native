import { createHash } from "node:crypto";

import { createHistoryAnchor, createLogicalTurnId } from "./history-anchor.js";
import { historyCodec } from "./history-protocol-codecs.js";
import type {
  JsonValue,
  NativeToolHistoryRecord,
  NativeToolHistoryScope,
  ToolCallSlot,
  ToolExecutionContext,
} from "./types.js";

function historyId(context: ToolExecutionContext): string {
  return createHash("sha256").update(JSON.stringify(context.key)).digest("hex");
}

function responsesToAnthropicSkeleton(items: readonly JsonValue[], slots: readonly ToolCallSlot[]): JsonValue[] {
  const slotById = new Map(slots.map((slot) => [slot.callId, slot]));
  const blocks: JsonValue[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const value = item as Record<string, JsonValue>;
    if (value.type === "function_call" && typeof value.call_id === "string" && typeof value.name === "string") {
      const slot = slotById.get(value.call_id);
      let parsed: JsonValue = slot?.input ?? {};
      if (!slot && typeof value.arguments === "string") parsed = JSON.parse(value.arguments) as JsonValue;
      blocks.push({ type: "tool_use", id: value.call_id, name: value.name, input: structuredClone(parsed) });
    } else if (value.type === "reasoning" && Array.isArray(value.content)) {
      const thinking = value.content.flatMap((part) => {
        const record = part && typeof part === "object" && !Array.isArray(part) ? part as Record<string, JsonValue> : {};
        return typeof record.text === "string" ? [record.text] : [];
      }).join("");
      if (thinking) blocks.push({ type: "thinking", thinking });
    } else if (value.type === "message" && Array.isArray(value.content)) {
      for (const part of value.content) {
        const record = part && typeof part === "object" && !Array.isArray(part) ? part as Record<string, JsonValue> : {};
        if (typeof record.text === "string") blocks.push({ type: "text", text: record.text });
      }
    }
  }
  return blocks;
}

export function buildNativeToolHistoryRecord(context: ToolExecutionContext): NativeToolHistoryRecord {
  if (context.responseStreamStatus !== "completed"
    || context.slots.some((slot) => !["succeeded", "failed"].includes(slot.status))) {
    throw new Error("Native Tool history requires a complete tool-call batch");
  }
  const scope: NativeToolHistoryScope = {
    spaceId: context.key.spaceId,
    userId: context.key.userId,
    agentSource: context.key.agentSource,
    sessionId: context.key.sessionId,
  };
  const clientProtocol = context.upstreamSnapshot.clientProtocol ?? context.protocol;
  const logicalMessages = context.upstreamSnapshot.logicalBaseMessages ?? context.upstreamSnapshot.baseMessages;
  const anchor = context.upstreamSnapshot.historyAnchor ?? createHistoryAnchor(logicalMessages);
  const logicalTurnId = context.upstreamSnapshot.logicalTurnId ?? createLogicalTurnId({
    scope,
    clientProtocol,
    anchor,
    requestFingerprint: context.upstreamSnapshot.requestFingerprint ?? anchor.prefixDigest,
  });
  const codec = historyCodec(clientProtocol);
  const clientSkeleton = clientProtocol === "anthropic" && context.protocol === "responses"
    ? responsesToAnthropicSkeleton(context.assistantSkeleton, context.slots)
    : context.assistantSkeleton;
  const fullSegment = codec.buildFullSegment(clientSkeleton, context.slots);
  return {
    historyId: historyId(context),
    logicalTurnId,
    scope,
    clientProtocol,
    upstreamProtocol: context.protocol,
    anchor,
    round: context.round,
    fullSegment,
    clientProjection: codec.buildClientProjection(fullSegment, context.slots),
    proxyCallIds: context.slots.filter((slot) => slot.owner === "proxy").sort((a, b) => a.slotIndex - b.slotIndex).map((slot) => slot.callId),
    clientCallIds: context.slots.filter((slot) => slot.owner === "client").sort((a, b) => a.slotIndex - b.slotIndex).map((slot) => slot.callId),
    createdAt: context.createdAt,
  };
}
