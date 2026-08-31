import type { NativeProxyToolRegistry } from "../../native-proxy-tools/tool-registry.js";
import type { JsonValue } from "../../native-proxy-tools/types.js";
import type {
  ProtocolStreamEvent,
  ProtocolStreamParser,
  UnifiedToolCall,
} from "./interface.js";

export interface AnthropicSseFrame {
  sequence: number;
  raw: Uint8Array;
  text: string;
  event?: string;
  data?: string;
  json?: JsonValue;
  contentBlockIndex?: number;
}

export interface AnthropicBlockSnapshot {
  index: number;
  block: JsonValue;
  completed: boolean;
  opaqueDeltas: JsonValue[];
  startFrameSequence: number;
  deltaFrameSequences: number[];
  stopFrameSequence?: number;
}

export interface AnthropicStreamSnapshot {
  rawBytes: Uint8Array;
  frames: AnthropicSseFrame[];
  events: ProtocolStreamEvent[];
  message?: JsonValue;
  blocks: AnthropicBlockSnapshot[];
  toolCalls: UnifiedToolCall[];
  usage?: JsonValue;
  stopReason?: string;
  messageCompleted: boolean;
}

interface MutableBlock {
  index: number;
  block: Record<string, JsonValue>;
  completed: boolean;
  inputJsonFragments: string[];
  opaqueDeltas: JsonValue[];
  startFrameSequence: number;
  deltaFrameSequences: number[];
  stopFrameSequence?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  if (right.byteLength === 0) return left;
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left, 0);
  output.set(right, left.byteLength);
  return output;
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

/** Return the byte length through the first SSE blank line, or -1. */
function findFrameBoundary(bytes: Uint8Array): number {
  let lineStart = 0;
  for (let index = 0; index < bytes.byteLength; index++) {
    const byte = bytes[index];
    if (byte !== 0x0a && byte !== 0x0d) continue;
    const terminatorEnd = byte === 0x0d && bytes[index + 1] === 0x0a
      ? index + 2
      : index + 1;
    if (index === lineStart) return terminatorEnd;
    lineStart = terminatorEnd;
    index = terminatorEnd - 1;
  }
  return -1;
}

function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function parseSseFields(text: string): { event?: string; data?: string } {
  let event: string | undefined;
  const dataLines: string[] = [];
  const lines = text.split(/\r\n|\n|\r/);
  for (const line of lines) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    if (field === "data") dataLines.push(value);
  }
  return {
    ...(event !== undefined ? { event } : {}),
    ...(dataLines.length > 0 ? { data: dataLines.join("\n") } : {}),
  };
}

export class AnthropicStreamParser implements ProtocolStreamParser {
  private readonly rawChunks: Uint8Array[] = [];
  private readonly frames: AnthropicSseFrame[] = [];
  private readonly allEvents: ProtocolStreamEvent[] = [];
  private readonly blocks = new Map<number, MutableBlock>();
  private readonly blockOrder: number[] = [];
  private readonly toolCalls: UnifiedToolCall[] = [];
  private pendingBytes: Uint8Array = new Uint8Array();
  private message?: JsonValue;
  private usage?: JsonValue;
  private stopReason?: string;
  private messageCompleted = false;
  private finished = false;
  private nextToolSlotIndex = 0;

  constructor(private readonly registry: NativeProxyToolRegistry) {}

  push(chunk: Uint8Array): ProtocolStreamEvent[] {
    if (this.finished) throw new Error("Cannot push after Anthropic stream parser finish");
    if (chunk.byteLength === 0) return [];

    const copy = chunk.slice();
    this.rawChunks.push(copy);
    this.pendingBytes = appendBytes(this.pendingBytes, copy);
    const emitted: ProtocolStreamEvent[] = [];

    while (true) {
      const boundary = findFrameBoundary(this.pendingBytes);
      if (boundary < 0) break;
      const rawFrame = this.pendingBytes.slice(0, boundary);
      this.pendingBytes = this.pendingBytes.slice(boundary);
      emitted.push(...this.consumeFrame(rawFrame));
    }
    return emitted;
  }

  finish(): ProtocolStreamEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const emitted: ProtocolStreamEvent[] = [];
    if (this.pendingBytes.byteLength > 0) {
      emitted.push(...this.consumeFrame(this.pendingBytes));
      this.pendingBytes = new Uint8Array();
    }
    if (!this.messageCompleted) {
      emitted.push(...this.record([{
        type: "protocol_error",
        code: "unexpected_eof",
        message: "Anthropic stream ended before message_stop",
      }]));
    }
    return emitted;
  }

  snapshot(): AnthropicStreamSnapshot {
    return {
      rawBytes: joinBytes(this.rawChunks),
      frames: this.frames.map((frame) => ({
        ...frame,
        raw: frame.raw.slice(),
        ...(frame.json !== undefined ? { json: cloneJson(frame.json) } : {}),
      })),
      events: structuredClone(this.allEvents),
      ...(this.message !== undefined ? { message: cloneJson(this.message) } : {}),
      blocks: this.blockOrder.map((index) => {
        const state = this.blocks.get(index)!;
        return {
          index: state.index,
          block: cloneJson(state.block),
          completed: state.completed,
          opaqueDeltas: state.opaqueDeltas.map(cloneJson),
          startFrameSequence: state.startFrameSequence,
          deltaFrameSequences: [...state.deltaFrameSequences],
          ...(state.stopFrameSequence !== undefined
            ? { stopFrameSequence: state.stopFrameSequence }
            : {}),
        };
      }),
      toolCalls: structuredClone(this.toolCalls),
      ...(this.usage !== undefined ? { usage: cloneJson(this.usage) } : {}),
      ...(this.stopReason !== undefined ? { stopReason: this.stopReason } : {}),
      messageCompleted: this.messageCompleted,
    };
  }

  private consumeFrame(raw: Uint8Array): ProtocolStreamEvent[] {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      const frame: AnthropicSseFrame = {
        sequence: this.frames.length,
        raw: raw.slice(),
        text: "",
      };
      this.frames.push(frame);
      return this.record([{
        type: "protocol_error",
        code: "invalid_utf8",
        message: "Anthropic SSE contains invalid UTF-8",
      }]);
    }

    const fields = parseSseFields(text);
    const frame: AnthropicSseFrame = {
      sequence: this.frames.length,
      raw: raw.slice(),
      text,
      ...fields,
    };
    this.frames.push(frame);
    if (fields.data === undefined) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(fields.data);
    } catch {
      return this.record([{
        type: "protocol_error",
        code: "malformed_sse_json",
        message: "Anthropic SSE data is not valid JSON",
      }]);
    }
    if (!isRecord(parsed)) {
      return this.record([{
        type: "protocol_error",
        code: "malformed_sse_event",
        message: "Anthropic SSE data must be a JSON object",
      }]);
    }

    frame.json = asJsonValue(parsed);
    if (Number.isInteger(parsed.index)) frame.contentBlockIndex = parsed.index as number;
    return this.handlePayload(parsed, frame);
  }

  private handlePayload(
    payload: Record<string, unknown>,
    frame: AnthropicSseFrame,
  ): ProtocolStreamEvent[] {
    const type = typeof payload.type === "string" ? payload.type : frame.event;
    switch (type) {
      case "message_start": {
        if (payload.message === undefined) {
          return this.record([this.error("invalid_message_start", "message_start is missing message")]);
        }
        this.message = asJsonValue(payload.message);
        const events: ProtocolStreamEvent[] = [
          { type: "message_started", message: cloneJson(this.message) },
        ];
        if (isRecord(payload.message) && payload.message.usage !== undefined) {
          this.mergeUsage(payload.message.usage);
          events.push({ type: "usage_updated", usage: cloneJson(this.usage!) });
        }
        return this.record(events);
      }
      case "content_block_start":
        return this.handleBlockStart(payload, frame);
      case "content_block_delta":
        return this.handleBlockDelta(payload, frame);
      case "content_block_stop":
        return this.handleBlockStop(payload, frame);
      case "message_delta": {
        const events: ProtocolStreamEvent[] = [];
        if (isRecord(payload.delta) && typeof payload.delta.stop_reason === "string") {
          this.stopReason = payload.delta.stop_reason;
        }
        if (payload.usage !== undefined) {
          this.mergeUsage(payload.usage);
          events.push({ type: "usage_updated", usage: cloneJson(this.usage!) });
        }
        return this.record(events);
      }
      case "message_stop": {
        this.messageCompleted = true;
        const openBlocks = this.blockOrder.filter((index) => !this.blocks.get(index)!.completed);
        const events: ProtocolStreamEvent[] = [];
        if (openBlocks.length > 0) {
          events.push(this.error(
            "incomplete_content_block",
            `Anthropic message_stop arrived with open content blocks: ${openBlocks.join(",")}`,
          ));
        }
        events.push({
          type: "message_completed",
          ...(this.stopReason !== undefined ? { stopReason: this.stopReason } : {}),
        });
        return this.record(events);
      }
      case "error": {
        const upstream = isRecord(payload.error) ? payload.error : {};
        const message = typeof upstream.message === "string"
          ? upstream.message
          : "Anthropic upstream returned an error event";
        return this.record([this.error("upstream_error", message)]);
      }
      default:
        // Unknown top-level events are retained as raw frames for forward
        // compatibility. Unknown content block deltas are retained separately.
        return [];
    }
  }

  private handleBlockStart(
    payload: Record<string, unknown>,
    frame: AnthropicSseFrame,
  ): ProtocolStreamEvent[] {
    if (!Number.isInteger(payload.index) || !isRecord(payload.content_block)) {
      return this.record([this.error(
        "invalid_content_block_start",
        "content_block_start requires an integer index and object block",
      )]);
    }
    const index = payload.index as number;
    if (this.blocks.has(index)) {
      return this.record([this.error(
        "duplicate_content_block_start",
        `content block ${index} started more than once`,
      )]);
    }
    const block = cloneJson(asJsonValue(payload.content_block)) as Record<string, JsonValue>;
    this.blocks.set(index, {
      index,
      block,
      completed: false,
      inputJsonFragments: [],
      opaqueDeltas: [],
      startFrameSequence: frame.sequence,
      deltaFrameSequences: [],
    });
    this.blockOrder.push(index);
    return this.record([{
      type: "content_block_started",
      index,
      block: cloneJson(block),
    }]);
  }

  private handleBlockDelta(
    payload: Record<string, unknown>,
    frame: AnthropicSseFrame,
  ): ProtocolStreamEvent[] {
    if (!Number.isInteger(payload.index) || !isRecord(payload.delta)) {
      return this.record([this.error(
        "invalid_content_block_delta",
        "content_block_delta requires an integer index and object delta",
      )]);
    }
    const index = payload.index as number;
    const state = this.blocks.get(index);
    if (!state || state.completed) {
      return this.record([this.error(
        "unknown_content_block",
        `content block ${index} is not open`,
      )]);
    }

    const delta = cloneJson(asJsonValue(payload.delta)) as Record<string, JsonValue>;
    state.deltaFrameSequences.push(frame.sequence);
    switch (delta.type) {
      case "text_delta":
        if (typeof delta.text === "string") {
          const current = typeof state.block.text === "string" ? state.block.text : "";
          state.block.text = current + delta.text;
        }
        break;
      case "thinking_delta":
        if (typeof delta.thinking === "string") {
          const current = typeof state.block.thinking === "string" ? state.block.thinking : "";
          state.block.thinking = current + delta.thinking;
        }
        break;
      case "signature_delta":
        if (typeof delta.signature === "string") {
          const current = typeof state.block.signature === "string" ? state.block.signature : "";
          state.block.signature = current + delta.signature;
        }
        break;
      case "input_json_delta":
        if (typeof delta.partial_json === "string") {
          state.inputJsonFragments.push(delta.partial_json);
        }
        break;
      default:
        state.opaqueDeltas.push(cloneJson(delta));
    }

    return this.record([{
      type: "content_block_delta",
      index,
      delta: cloneJson(delta),
    }]);
  }

  private handleBlockStop(
    payload: Record<string, unknown>,
    frame: AnthropicSseFrame,
  ): ProtocolStreamEvent[] {
    if (!Number.isInteger(payload.index)) {
      return this.record([this.error(
        "invalid_content_block_stop",
        "content_block_stop requires an integer index",
      )]);
    }
    const index = payload.index as number;
    const state = this.blocks.get(index);
    if (!state || state.completed) {
      return this.record([this.error(
        "unknown_content_block",
        `content block ${index} is not open`,
      )]);
    }
    state.completed = true;
    state.stopFrameSequence = frame.sequence;

    const events: ProtocolStreamEvent[] = [];
    if (state.block.type === "tool_use") {
      const toolName = typeof state.block.name === "string" ? state.block.name : "";
      const callId = typeof state.block.id === "string" ? state.block.id : "";
      let input: JsonValue | undefined;
      let parseError: UnifiedToolCall["parseError"];
      if (!callId || !toolName) {
        parseError = {
          code: "invalid_tool_call",
          message: "Tool call is missing id or name",
        };
      } else if (state.inputJsonFragments.length > 0) {
        try {
          input = asJsonValue(JSON.parse(state.inputJsonFragments.join("")));
          state.block.input = cloneJson(input);
        } catch {
          parseError = {
            code: "invalid_tool_input_json",
            message: "Tool input is not valid JSON",
          };
        }
      } else {
        input = state.block.input === undefined ? {} : cloneJson(state.block.input);
      }

      const call: UnifiedToolCall = {
        callId,
        toolName,
        owner: this.registry.owns(toolName) ? "proxy" : "client",
        slotIndex: this.nextToolSlotIndex++,
        contentBlockIndex: index,
        argumentsComplete: true,
        ...(input !== undefined ? { input } : {}),
        ...(parseError !== undefined ? { parseError } : {}),
      };
      this.toolCalls.push(structuredClone(call));
      events.push({ type: "tool_call_completed", call });
    }

    events.unshift({
      type: "content_block_completed",
      index,
      block: cloneJson(state.block),
    });
    return this.record(events);
  }

  private error(code: string, message: string): ProtocolStreamEvent {
    return { type: "protocol_error", code, message };
  }

  private mergeUsage(update: unknown): void {
    if (isRecord(this.usage) && isRecord(update)) {
      this.usage = asJsonValue({ ...this.usage, ...update });
      return;
    }
    this.usage = asJsonValue(update);
  }

  private record(events: ProtocolStreamEvent[]): ProtocolStreamEvent[] {
    this.allEvents.push(...structuredClone(events));
    return events;
  }
}
