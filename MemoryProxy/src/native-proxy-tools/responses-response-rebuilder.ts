import type { JsonValue, ToolCallSlot } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function output(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

/** Append durable tool results to the exact Responses output-item skeleton. */
export function buildResponsesToolInputItems(
  assistantSkeleton: readonly JsonValue[],
  slots: readonly ToolCallSlot[],
): JsonValue[] {
  return [
    ...structuredClone([...assistantSkeleton]),
    ...[...slots].sort((a, b) => a.slotIndex - b.slotIndex).map((slot): JsonValue => ({
      type: "function_call_output",
      call_id: slot.callId,
      output: output(slot.result),
    })),
  ];
}

interface Frame {
  source: string;
  delimiter: string;
  dataLine: number;
  lines: string[];
  payload?: Record<string, unknown>;
}

function parseFrames(bytes: Uint8Array): Frame[] {
  const segments = decoder.decode(bytes).split(/(\r\n\r\n|\n\n|\r\r)/);
  const frames: Frame[] = [];
  for (let index = 0; index < segments.length; index += 2) {
    const source = segments[index] ?? "";
    const delimiter = segments[index + 1] ?? "";
    const lines = source.split(/\r\n|\n|\r/);
    const dataLine = lines.findIndex((line) => line.startsWith("data:"));
    let payload: Record<string, unknown> | undefined;
    if (dataLine >= 0) {
      const data = lines[dataLine].slice(5).trimStart();
      if (data && data !== "[DONE]") {
        try { payload = JSON.parse(data) as Record<string, unknown>; } catch { /* preserve invalid input */ }
      }
    }
    frames.push({ source, delimiter, dataLine, lines, ...(payload ? { payload } : {}) });
  }
  return frames;
}

/**
 * Remove Proxy-owned Responses output lifecycles and compact every remaining
 * output_index. Unknown/provider events are retained with all unknown fields.
 */
export function buildClientVisibleResponsesSse(
  rawBytes: Uint8Array,
  proxyOutputIndexes: ReadonlySet<number>,
): Uint8Array {
  const frames = parseFrames(rawBytes);
  const known = new Set<number>();
  for (const frame of frames) {
    if (Number.isInteger(frame.payload?.output_index)) known.add(frame.payload?.output_index as number);
    const response = frame.payload?.response;
    if (response && typeof response === "object" && Array.isArray((response as Record<string, unknown>).output)) {
      ((response as Record<string, unknown>).output as unknown[]).forEach((_value, index) => known.add(index));
    }
  }
  const indexMap = new Map<number, number>();
  for (const original of [...known].sort((a, b) => a - b)) {
    if (!proxyOutputIndexes.has(original)) indexMap.set(original, indexMap.size);
  }

  const rendered: string[] = [];
  for (const frame of frames) {
    if (!frame.payload) { rendered.push(frame.source, frame.delimiter); continue; }
    const original = frame.payload.output_index;
    if (Number.isInteger(original) && proxyOutputIndexes.has(original as number)) continue;
    const payload = structuredClone(frame.payload);
    if (Number.isInteger(original)) payload.output_index = indexMap.get(original as number) ?? original;
    const response = payload.response;
    if (response && typeof response === "object" && !Array.isArray(response)) {
      const object = response as Record<string, unknown>;
      if (Array.isArray(object.output)) object.output = object.output.filter((_item, index) => !proxyOutputIndexes.has(index));
    }
    frame.lines[frame.dataLine] = `data: ${JSON.stringify(payload)}`;
    rendered.push(frame.lines.join("\n"), frame.delimiter);
  }
  return encoder.encode(rendered.join(""));
}
