import type {
  AnthropicSseFrame,
  AnthropicStreamSnapshot,
} from "../injection/adapters/anthropic-stream.js";
import type {
  JsonValue,
  NativeToolLeakMarker,
  PersistedNativeToolLeakMarker,
  ToolCallSlot,
} from "./types.js";
import type { NativeProxyToolRegistry } from "./tool-registry.js";

export type { NativeToolLeakMarker } from "./types.js";

function cloneJsonValue(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Native Proxy Tool schema is not JSON serializable");
  return JSON.parse(encoded) as JsonValue;
}

/** Build sentinels for definitions injected by the Proxy, even if no call was emitted. */
export function buildNativeRegistryLeakMarkers(
  registry: NativeProxyToolRegistry,
): NativeToolLeakMarker[] {
  return registry.list().map((definition) => ({
    callId: "",
    toolName: definition.name,
    input: cloneJsonValue(definition.inputSchema),
    additionalSentinels: [
      definition.description,
      JSON.stringify({
        name: definition.name,
        description: definition.description,
        input_schema: definition.inputSchema,
      }),
    ],
  }));
}

export interface AnthropicAssistantMessage {
  role: "assistant";
  content: JsonValue[];
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: JsonValue;
  is_error?: true;
}

export interface AnthropicUserToolResultMessage {
  role: "user";
  content: AnthropicToolResultBlock[];
}

function assertComplete(snapshot: AnthropicStreamSnapshot): void {
  if (!snapshot.messageCompleted) {
    throw new Error("Cannot rebuild Anthropic response before message_stop");
  }
  const protocolError = snapshot.events.find((event) => event.type === "protocol_error");
  if (protocolError?.type === "protocol_error") {
    throw new Error(`Cannot rebuild invalid Anthropic response: ${protocolError.code}`);
  }
  const incomplete = snapshot.blocks.find((block) => !block.completed);
  if (incomplete) {
    throw new Error(`Cannot rebuild incomplete Anthropic content block ${incomplete.index}`);
  }
}

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function mergeNativeToolLeakMarkers(
  ...groups: ReadonlyArray<readonly NativeToolLeakMarker[]>
): PersistedNativeToolLeakMarker[] {
  const seen = new Set<string>();
  const merged: PersistedNativeToolLeakMarker[] = [];
  for (const group of groups) {
    for (const marker of group) {
      const signature = `${marker.callId}\u0000${marker.toolName}\u0000${
        marker.input === undefined ? "undefined" : JSON.stringify(marker.input)
      }`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      merged.push({
        callId: marker.callId,
        toolName: marker.toolName,
        ...(marker.input !== undefined ? { input: structuredClone(marker.input) } : {}),
      });
    }
  }
  return merged;
}

export function assertNoNativeToolLeak(
  bytes: Uint8Array,
  calls: readonly NativeToolLeakMarker[],
): void {
  const text = new TextDecoder().decode(bytes);
  for (const call of calls) {
    const sentinels = [call.callId, call.toolName, ...(call.additionalSentinels ?? [])];
    // Result content is intentionally available to the model and may be used
    // verbatim in its answer. Only protocol identity and hidden input payloads
    // are forbidden in the client-visible transport.
    for (const value of [call.input]) {
      if (value === undefined) continue;
      const serialized = JSON.stringify(value);
      sentinels.push(serialized, JSON.stringify(serialized).slice(1, -1));
    }
    for (const value of call.additionalSentinels ?? []) {
      sentinels.push(JSON.stringify(value).slice(1, -1));
    }
    if (sentinels.some((sentinel) => sentinel.length > 0 && text.includes(sentinel))) {
      throw new Error("Client-visible Anthropic response contains hidden Native Tool data");
    }
  }
}

/** Find and replace only a top-level JSON object's integer `index` value. */
function rewriteTopLevelIndex(data: string, nextIndex: number): string {
  let depth = 0;
  for (let cursor = 0; cursor < data.length; cursor++) {
    const char = data[cursor];
    if (char === "{") {
      depth++;
      continue;
    }
    if (char === "}") {
      depth--;
      continue;
    }
    if (char !== "\"") continue;

    const start = cursor;
    cursor++;
    let escaped = false;
    for (; cursor < data.length; cursor++) {
      const current = data[cursor];
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === "\"") {
        break;
      }
    }
    if (depth !== 1) continue;

    let key: unknown;
    try {
      key = JSON.parse(data.slice(start, cursor + 1));
    } catch {
      continue;
    }
    if (key !== "index") continue;

    let valueStart = cursor + 1;
    while (/\s/.test(data[valueStart] ?? "")) valueStart++;
    if (data[valueStart] !== ":") continue;
    valueStart++;
    while (/\s/.test(data[valueStart] ?? "")) valueStart++;
    const match = data.slice(valueStart).match(/^-?\d+/);
    if (!match) continue;
    return `${data.slice(0, valueStart)}${nextIndex}${data.slice(valueStart + match[0].length)}`;
  }
  throw new Error("Anthropic content block frame is missing a top-level index");
}

/** Preserve event/comment fields and line endings while changing SSE data. */
function rewriteFrameData(frame: AnthropicSseFrame, data: string): Uint8Array {
  const values = data.split("\n");
  let valueIndex = 0;
  const parts = frame.text.split(/(\r\n|\n|\r)/);
  for (let index = 0; index < parts.length; index += 2) {
    const match = parts[index].match(/^(data:(?: )?)(.*)$/);
    if (!match) continue;
    if (valueIndex >= values.length) {
      throw new Error("Anthropic SSE data line count changed during index rewrite");
    }
    parts[index] = `${match[1]}${values[valueIndex++]}`;
  }
  if (valueIndex !== values.length) {
    throw new Error("Anthropic SSE data line count changed during index rewrite");
  }
  return new TextEncoder().encode(parts.join(""));
}

function rewriteVisibleFrame(
  frame: AnthropicSseFrame,
  nextIndex: number,
): Uint8Array {
  if (frame.contentBlockIndex === nextIndex) return frame.raw.slice();
  if (frame.data === undefined) {
    throw new Error("Anthropic content block frame has no SSE data field");
  }
  return rewriteFrameData(frame, rewriteTopLevelIndex(frame.data, nextIndex));
}

export function replayAnthropicBytes(snapshot: AnthropicStreamSnapshot): Uint8Array {
  assertComplete(snapshot);
  return snapshot.rawBytes.slice();
}

/**
 * Remove Proxy-owned block lifecycles by parsed index and compact every
 * remaining block index. No name/text matching is used, so identical tool
 * names and opaque Provider frames cannot be misclassified.
 */
export function buildClientVisibleAnthropicSse(
  snapshot: AnthropicStreamSnapshot,
  nativeIndexes: ReadonlySet<number>,
): Uint8Array {
  assertComplete(snapshot);
  const knownIndexes = new Set(snapshot.blocks.map((block) => block.index));
  for (const index of nativeIndexes) {
    if (!knownIndexes.has(index)) {
      throw new Error(`Native content block index ${index} is not present in the snapshot`);
    }
  }

  const visibleIndexMap = new Map<number, number>();
  for (const block of [...snapshot.blocks].sort((left, right) => left.index - right.index)) {
    if (!nativeIndexes.has(block.index)) {
      visibleIndexMap.set(block.index, visibleIndexMap.size);
    }
  }

  const output: Uint8Array[] = [];
  for (const frame of snapshot.frames) {
    const blockIndex = frame.contentBlockIndex;
    if (blockIndex === undefined) {
      output.push(frame.raw.slice());
      continue;
    }
    if (nativeIndexes.has(blockIndex)) continue;
    const nextIndex = visibleIndexMap.get(blockIndex);
    if (nextIndex === undefined) {
      throw new Error(`Anthropic frame references unknown content block ${blockIndex}`);
    }
    output.push(rewriteVisibleFrame(frame, nextIndex));
  }
  const visible = joinBytes(output);
  assertNoNativeToolLeak(
    visible,
    snapshot.toolCalls.filter((call) => nativeIndexes.has(call.contentBlockIndex)),
  );
  return visible;
}

export function buildFullAssistantMessage(
  snapshot: AnthropicStreamSnapshot,
): AnthropicAssistantMessage {
  assertComplete(snapshot);
  return {
    role: "assistant",
    content: [...snapshot.blocks]
      .sort((left, right) => left.index - right.index)
      .map((entry) => structuredClone(entry.block)),
  };
}

export function buildToolResultMessage(
  slots: readonly ToolCallSlot[],
): AnthropicUserToolResultMessage {
  return {
    role: "user",
    content: [...slots]
      .sort((left, right) => left.slotIndex - right.slotIndex)
      .map((slot) => {
        const result = slot.result ?? null;
        const preserveClientWireShape = slot.owner === "client"
          && (typeof result === "string" || Array.isArray(result));
        return {
          type: "tool_result",
          tool_use_id: slot.callId,
          content: preserveClientWireShape
            ? structuredClone(result)
            : JSON.stringify(result),
          ...(slot.isError ? { is_error: true as const } : {}),
        };
      }),
  };
}
