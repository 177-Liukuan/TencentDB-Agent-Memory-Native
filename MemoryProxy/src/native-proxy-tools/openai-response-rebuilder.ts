import type { JsonValue, ToolCallSlot } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ASSISTANT_META_KEY = "__tdai_native_assistant_meta";

export function buildOpenAIAssistantSkeleton(input: {
  calls: readonly { callId: string; toolName: string; input?: JsonValue; slotIndex: number }[];
  content?: string | null;
  extras?: Record<string, JsonValue>;
}): JsonValue[] {
  const calls = [...input.calls].sort((left, right) => left.slotIndex - right.slotIndex).map((call) => ({
    id: call.callId,
    type: "function",
    function: { name: call.toolName, arguments: JSON.stringify(call.input ?? {}) },
  }));
  return [...calls, {
    [ASSISTANT_META_KEY]: {
      content: input.content ?? null,
      extras: structuredClone(input.extras ?? {}),
    },
  }];
}

export function openAIAssistantMessageFromSkeleton(skeleton: readonly JsonValue[]): JsonValue {
  const toolCalls: JsonValue[] = [];
  let content: JsonValue = null;
  let extras: Record<string, JsonValue> = {};
  for (const item of skeleton) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const value = item as Record<string, JsonValue>;
    const meta = value[ASSISTANT_META_KEY];
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      const record = meta as Record<string, JsonValue>;
      content = record.content ?? null;
      if (record.extras && typeof record.extras === "object" && !Array.isArray(record.extras)) {
        extras = structuredClone(record.extras as Record<string, JsonValue>);
      }
    } else if (value.type === "function") {
      toolCalls.push(structuredClone(item));
    }
  }
  return { role: "assistant", content, ...extras, tool_calls: toolCalls };
}

function stringifyResult(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? null);
}

/** Build the hidden assistant Tool Call turn and its ordered Tool messages. */
export function buildOpenAIToolMessages(
  slots: readonly ToolCallSlot[],
  assistantSkeleton?: readonly JsonValue[],
): JsonValue[] {
  const ordered = [...slots].sort((left, right) => left.slotIndex - right.slotIndex);
  return [
    assistantSkeleton ? openAIAssistantMessageFromSkeleton(assistantSkeleton) : {
      role: "assistant",
      content: null,
      tool_calls: ordered.map((slot) => ({
        id: slot.callId,
        type: "function",
        function: {
          name: slot.toolName,
          arguments: JSON.stringify(slot.input ?? {}),
        },
      })),
    },
    ...ordered.map((slot) => ({
      role: "tool",
      tool_call_id: slot.callId,
      content: stringifyResult(slot.result),
    })),
  ];
}

/**
 * Remove Proxy-owned function-call deltas while retaining all unknown fields,
 * including Provider Server Tool status/result blocks.
 */
export function buildClientVisibleOpenAISse(
  rawBytes: Uint8Array,
  proxyToolIndexes: ReadonlySet<number>,
): Uint8Array {
  const source = decoder.decode(rawBytes);
  const segments = source.split(/(\r\n\r\n|\n\n|\r\r)/);
  const visibleIndexes = new Map<number, number>();
  let nextVisibleIndex = 0;
  const output: string[] = [];

  for (let index = 0; index < segments.length; index += 2) {
    const frame = segments[index] ?? "";
    const delimiter = segments[index + 1] ?? "";
    if (!frame.trim()) {
      output.push(frame, delimiter);
      continue;
    }
    const lines = frame.split(/\r\n|\n|\r/);
    const dataLine = lines.findIndex((line) => line.startsWith("data:"));
    if (dataLine < 0) {
      output.push(frame, delimiter);
      continue;
    }
    const data = lines[dataLine].slice(5).trimStart();
    if (!data || data === "[DONE]") {
      output.push(frame, delimiter);
      continue;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data) as Record<string, unknown>;
    } catch {
      output.push(frame, delimiter);
      continue;
    }
    if (Array.isArray(payload.choices)) {
      for (const rawChoice of payload.choices) {
        if (!rawChoice || typeof rawChoice !== "object") continue;
        const choice = rawChoice as Record<string, unknown>;
        if (!choice.delta || typeof choice.delta !== "object") continue;
        const delta = choice.delta as Record<string, unknown>;
        if (!Array.isArray(delta.tool_calls)) continue;
        const visible = delta.tool_calls.flatMap((rawCall) => {
          if (!rawCall || typeof rawCall !== "object") return [rawCall];
          const call = rawCall as Record<string, unknown>;
          if (!Number.isInteger(call.index)) return [rawCall];
          const original = call.index as number;
          if (proxyToolIndexes.has(original)) return [];
          let mapped = visibleIndexes.get(original);
          if (mapped === undefined) {
            mapped = nextVisibleIndex++;
            visibleIndexes.set(original, mapped);
          }
          return [{ ...call, index: mapped }];
        });
        if (visible.length > 0) delta.tool_calls = visible;
        else delete delta.tool_calls;
      }
    }
    lines[dataLine] = `data: ${JSON.stringify(payload)}`;
    output.push(lines.join("\n"), delimiter);
  }
  return encoder.encode(output.join(""));
}
