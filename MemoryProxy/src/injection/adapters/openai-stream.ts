import type { NativeProxyToolRegistry } from "../../native-proxy-tools/tool-registry.js";
import type { JsonValue } from "../../native-proxy-tools/types.js";
import type {
  ProtocolStreamEvent,
  ProtocolStreamParser,
  ProtocolStreamSnapshot,
  UnifiedToolCall,
} from "./interface.js";

interface PendingFunctionCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

export interface OpenAIStreamSnapshot extends ProtocolStreamSnapshot {
  toolCalls: UnifiedToolCall[];
  stopReason?: string;
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
}

function frameBoundary(value: string): { index: number; length: number } | null {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(value);
  return match ? { index: match.index, length: match[0].length } : null;
}

/** Incremental parser for OpenAI-compatible Chat Completions SSE. */
export class OpenAIStreamParser implements ProtocolStreamParser {
  private readonly decoder = new TextDecoder();
  private rawBytes: Uint8Array = new Uint8Array();
  private pendingText = "";
  private readonly pendingCalls = new Map<number, PendingFunctionCall>();
  private completedCalls: UnifiedToolCall[] = [];
  private completed = false;
  private stopReason?: string;

  constructor(private readonly registry: NativeProxyToolRegistry) {}

  push(chunk: Uint8Array): ProtocolStreamEvent[] {
    this.rawBytes = appendBytes(this.rawBytes, chunk);
    this.pendingText += this.decoder.decode(chunk, { stream: true });
    const events: ProtocolStreamEvent[] = [];
    while (true) {
      const boundary = frameBoundary(this.pendingText);
      if (!boundary) break;
      const frame = this.pendingText.slice(0, boundary.index);
      this.pendingText = this.pendingText.slice(boundary.index + boundary.length);
      events.push(...this.processFrame(frame));
    }
    return events;
  }

  finish(): ProtocolStreamEvent[] {
    this.pendingText += this.decoder.decode();
    const events: ProtocolStreamEvent[] = [];
    if (this.pendingText.trim().length > 0) {
      events.push(...this.processFrame(this.pendingText));
      this.pendingText = "";
    }
    if (!this.completed) {
      events.push(...this.complete("stream_end"));
    }
    return events;
  }

  snapshot(): OpenAIStreamSnapshot {
    return {
      rawBytes: this.rawBytes.slice(),
      messageCompleted: this.completed,
      toolCalls: structuredClone(this.completedCalls),
      ...(this.stopReason ? { stopReason: this.stopReason } : {}),
    };
  }

  private processFrame(frame: string): ProtocolStreamEvent[] {
    const data = frame
      .split(/\r?\n|\r/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return [];
    if (data.trim() === "[DONE]") return this.completed ? [] : this.complete("stream_end");

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return [{ type: "protocol_error", code: "invalid_sse_json", message: "OpenAI SSE data is not valid JSON" }];
    }
    const events: ProtocolStreamEvent[] = [];
    if (payload.usage && typeof payload.usage === "object") {
      events.push({ type: "usage_updated", usage: payload.usage as JsonValue });
    }
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    for (const rawChoice of choices) {
      if (!rawChoice || typeof rawChoice !== "object") continue;
      const choice = rawChoice as Record<string, unknown>;
      const delta = choice.delta;
      if (delta && typeof delta === "object") this.collectDelta(delta as Record<string, unknown>);
      if (typeof choice.finish_reason === "string" && !this.completed) {
        events.push(...this.complete(choice.finish_reason));
      }
    }
    return events;
  }

  private collectDelta(delta: Record<string, unknown>): void {
    if (!Array.isArray(delta.tool_calls)) return;
    for (const rawCall of delta.tool_calls) {
      if (!rawCall || typeof rawCall !== "object") continue;
      const call = rawCall as Record<string, unknown>;
      // Provider/server tools use protocol-specific blocks. Only ordinary
      // Chat Completions function calls participate in Proxy/Client slots.
      if (call.type !== undefined && call.type !== "function") continue;
      if (!Number.isInteger(call.index)) continue;
      const index = call.index as number;
      const current = this.pendingCalls.get(index) ?? { index, id: "", name: "", arguments: "" };
      if (typeof call.id === "string") current.id += call.id;
      const fn = call.function;
      if (fn && typeof fn === "object") {
        const value = fn as Record<string, unknown>;
        if (typeof value.name === "string") current.name += value.name;
        if (typeof value.arguments === "string") current.arguments += value.arguments;
      }
      this.pendingCalls.set(index, current);
    }
  }

  private complete(stopReason: string): ProtocolStreamEvent[] {
    if (this.completed) return [];
    this.completed = true;
    this.stopReason = stopReason;
    this.completedCalls = [...this.pendingCalls.values()]
      .sort((left, right) => left.index - right.index)
      .map((pending, slotIndex) => this.toUnifiedCall(pending, slotIndex));
    return [
      ...this.completedCalls.map((call): ProtocolStreamEvent => ({ type: "tool_call_completed", call })),
      { type: "message_completed", stopReason },
    ];
  }

  private toUnifiedCall(pending: PendingFunctionCall, slotIndex: number): UnifiedToolCall {
    const base = {
      callId: pending.id,
      toolName: pending.name,
      owner: this.registry.owns(pending.name) ? "proxy" as const : "client" as const,
      slotIndex,
      contentBlockIndex: pending.index,
      argumentsComplete: true as const,
    };
    if (!pending.id || !pending.name) {
      return { ...base, parseError: { code: "invalid_tool_call", message: "Tool call is missing an id or function name" } };
    }
    try {
      return { ...base, input: JSON.parse(pending.arguments || "{}") as JsonValue };
    } catch {
      return { ...base, parseError: { code: "invalid_tool_input_json", message: "Tool input is not valid JSON" } };
    }
  }
}
