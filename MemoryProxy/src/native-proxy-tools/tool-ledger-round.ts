import type {
  JsonValue,
  NativeToolLedgerBlock,
  NativeToolLedgerRound,
  ToolCallSlot,
  ToolExecutionContext,
} from "./types.js";

function epochFromContextVersion(value: string): number {
  const matched = /^epoch:(\d+)$/.exec(value);
  if (matched) return Number(matched[1]);
  // 兼容升级前仍在 1800 秒执行表中的记录；新请求一律写 epoch:N。
  if (value === "v1") return 0;
  throw new Error(`Unsupported Native Tool context version: ${value}`);
}

function ledgerId(context: ToolExecutionContext): string {
  const key = context.key;
  return [key.spaceId, key.userId, key.agentSource, key.sessionId, key.contextVersion, key.toolBatchId]
    .map(encodeURIComponent)
    .join("/");
}

function responsesToAnthropic(items: readonly JsonValue[], slots: readonly ToolCallSlot[]): JsonValue[] {
  const slotById = new Map(slots.map((slot) => [slot.callId, slot]));
  const blocks: JsonValue[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const value = item as Record<string, JsonValue>;
    if (value.type === "function_call" && typeof value.call_id === "string" && typeof value.name === "string") {
      const slot = slotById.get(value.call_id);
      blocks.push({ type: "tool_use", id: value.call_id, name: value.name, input: structuredClone(slot?.input ?? {}) });
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

/** 把短期执行状态收敛为 Claude Code 后续恢复所需的最少长期记录。 */
export function buildNativeToolLedgerRound(context: ToolExecutionContext): NativeToolLedgerRound {
  if (context.responseStreamStatus !== "completed"
    || context.slots.some((slot) => !["succeeded", "failed"].includes(slot.status))) {
    throw new Error("Native Tool ledger requires a complete tool-call round");
  }
  const proxySlots = context.slots.filter((slot) => slot.owner === "proxy");
  if (proxySlots.length === 0) throw new Error("Native Tool ledger requires a Native Tool call");
  const clientProtocol = context.upstreamSnapshot.clientProtocol ?? context.protocol;
  if (clientProtocol !== "anthropic") {
    throw new Error("Hook-driven Native Tool ledger currently supports Claude Code only");
  }
  const skeleton = context.protocol === "responses"
    ? responsesToAnthropic(context.assistantSkeleton, context.slots)
    : context.assistantSkeleton;
  const byBlock = new Map(context.slots.map((slot) => [slot.contentBlockIndex, slot]));
  const mixed = context.slots.some((slot) => slot.owner === "client");
  const blocks: NativeToolLedgerBlock[] = [];
  for (const [blockIndex, value] of skeleton.entries()) {
    const slot = byBlock.get(blockIndex);
    if (slot?.owner === "proxy") {
      blocks.push({ kind: "native_tool", blockIndex, callId: slot.callId, toolName: slot.toolName, input: structuredClone(slot.input ?? {}) });
    } else if (slot?.owner === "client") {
      blocks.push({ kind: "client_tool_ref", blockIndex, callId: slot.callId, toolName: slot.toolName });
    } else if (!mixed) {
      // 纯 Native 轮次完全不会发给 Claude Code，因此文本和 thinking 也要保存。
      blocks.push({ kind: "hidden_content", blockIndex, value: structuredClone(value) });
    }
  }
  return {
    ledgerId: ledgerId(context),
    scope: {
      spaceId: context.key.spaceId,
      userId: context.key.userId,
      agentSource: context.key.agentSource,
      sessionId: context.key.sessionId,
    },
    contextEpoch: epochFromContextVersion(context.key.contextVersion),
    turnSeq: context.turnSeq,
    round: context.round,
    clientProtocol,
    blocks,
    nativeResults: proxySlots.sort((left, right) => left.slotIndex - right.slotIndex).map((slot) => ({
      callId: slot.callId,
      // Anthropic tool_result 实际发送的是序列化后的受限结果，长期记录必须与模型当时看到的内容一致。
      value: JSON.stringify(slot.result ?? null),
      isError: slot.isError === true,
    })),
    createdAt: context.createdAt,
  };
}
