import type {
  AnthropicSseFrame,
  AnthropicStreamSnapshot,
} from "../injection/adapters/anthropic-stream.js";
import type { JsonValue, ToolCallSlot } from "./types.js";

export interface AnthropicAssistantMessage {
  role: "assistant";
  content: JsonValue[];
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
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
  return joinBytes(output);
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
      .map((slot) => ({
        type: "tool_result",
        tool_use_id: slot.callId,
        content: JSON.stringify(slot.result ?? null),
        ...(slot.isError ? { is_error: true as const } : {}),
      })),
  };
}
