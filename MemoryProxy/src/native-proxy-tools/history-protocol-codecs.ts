import type { JsonValue, NativeToolProtocol, ToolCallSlot } from "./types.js";
import { openAIAssistantMessageFromSkeleton } from "./openai-response-rebuilder.js";

export interface HistoryProtocolCodec {
  readonly protocol: NativeToolProtocol;
  buildFullSegment(assistantSkeleton: readonly JsonValue[], slots: readonly ToolCallSlot[]): JsonValue[];
  buildClientProjection(fullSegment: readonly JsonValue[], slots: readonly ToolCallSlot[]): JsonValue[];
}

function resultText(slot: ToolCallSlot): string {
  return typeof slot.result === "string" ? slot.result : JSON.stringify(slot.result ?? null);
}

function ordered(slots: readonly ToolCallSlot[]): ToolCallSlot[] {
  return [...slots].sort((left, right) => left.slotIndex - right.slotIndex);
}

function asRecord(value: JsonValue): Record<string, JsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null;
}

function projectionOrEmpty(
  fullAssistant: JsonValue,
  clientAssistant: JsonValue,
  clientResults: JsonValue[],
  slots: readonly ToolCallSlot[],
): JsonValue[] {
  return slots.some((slot) => slot.owner === "client")
    ? [clientAssistant, ...clientResults]
    : [];
}

export class AnthropicHistoryCodec implements HistoryProtocolCodec {
  readonly protocol = "anthropic" as const;

  buildFullSegment(assistantSkeleton: readonly JsonValue[], slots: readonly ToolCallSlot[]): JsonValue[] {
    return [
      { role: "assistant", content: structuredClone([...assistantSkeleton]) },
      { role: "user", content: ordered(slots).map((slot) => ({
        type: "tool_result",
        tool_use_id: slot.callId,
        content: resultText(slot),
        ...(slot.isError ? { is_error: true } : {}),
      })) },
    ];
  }

  buildClientProjection(fullSegment: readonly JsonValue[], slots: readonly ToolCallSlot[]): JsonValue[] {
    const proxyIds = new Set(slots.filter((slot) => slot.owner === "proxy").map((slot) => slot.callId));
    const assistant = asRecord(fullSegment[0]);
    const result = asRecord(fullSegment[1]);
    const assistantContent = Array.isArray(assistant?.content)
      ? assistant.content.filter((value) => {
        const block = asRecord(value);
        return block?.type !== "tool_use" || typeof block.id !== "string" || !proxyIds.has(block.id);
      })
      : [];
    const resultContent = Array.isArray(result?.content)
      ? result.content.filter((value) => {
        const block = asRecord(value);
        return block?.type !== "tool_result" || typeof block.tool_use_id !== "string" || !proxyIds.has(block.tool_use_id);
      })
      : [];
    return projectionOrEmpty(
      fullSegment[0],
      { role: "assistant", content: assistantContent },
      [{ role: "user", content: resultContent }],
      slots,
    );
  }
}

export class OpenAIChatHistoryCodec implements HistoryProtocolCodec {
  readonly protocol = "openai" as const;
  buildFullSegment(assistantSkeleton: readonly JsonValue[], slots: readonly ToolCallSlot[]): JsonValue[] {
    return [
      openAIAssistantMessageFromSkeleton(assistantSkeleton),
      ...ordered(slots).map((slot): JsonValue => ({ role: "tool", tool_call_id: slot.callId, content: resultText(slot) })),
    ];
  }
  buildClientProjection(fullSegment: readonly JsonValue[], slots: readonly ToolCallSlot[]): JsonValue[] {
    const clientIds = new Set(slots.filter((slot) => slot.owner === "client").map((slot) => slot.callId));
    if (clientIds.size === 0) return [];
    const assistant = asRecord(fullSegment[0]);
    const calls = Array.isArray(assistant?.tool_calls)
      ? assistant.tool_calls.filter((call) => {
        const value = asRecord(call);
        return typeof value?.id === "string" && clientIds.has(value.id);
      })
      : [];
    return [
      { ...structuredClone(assistant ?? {}), tool_calls: calls },
      ...fullSegment.slice(1).filter((message) => {
        const value = asRecord(message);
        return typeof value?.tool_call_id === "string" && clientIds.has(value.tool_call_id);
      }),
    ];
  }
}

export class ResponsesHistoryCodec implements HistoryProtocolCodec {
  readonly protocol = "responses" as const;
  buildFullSegment(assistantSkeleton: readonly JsonValue[], slots: readonly ToolCallSlot[]): JsonValue[] {
    return [
      ...structuredClone([...assistantSkeleton]),
      ...ordered(slots).map((slot): JsonValue => ({ type: "function_call_output", call_id: slot.callId, output: resultText(slot) })),
    ];
  }
  buildClientProjection(fullSegment: readonly JsonValue[], slots: readonly ToolCallSlot[]): JsonValue[] {
    const clientIds = new Set(slots.filter((slot) => slot.owner === "client").map((slot) => slot.callId));
    if (clientIds.size === 0) return [];
    return fullSegment.filter((item) => {
      const value = asRecord(item);
      if (value?.type === "function_call" || value?.type === "function_call_output") {
        return typeof value.call_id === "string" && clientIds.has(value.call_id);
      }
      return true;
    });
  }
}

export function historyCodec(protocol: NativeToolProtocol): HistoryProtocolCodec {
  if (protocol === "anthropic") return new AnthropicHistoryCodec();
  if (protocol === "openai") return new OpenAIChatHistoryCodec();
  return new ResponsesHistoryCodec();
}
