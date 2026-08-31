import type { NativeProxyToolRegistry } from "../../native-proxy-tools/tool-registry.js";
import type { JsonValue } from "../../native-proxy-tools/types.js";
import type { ProtocolStreamEvent, ProtocolStreamParser, ProtocolStreamSnapshot, UnifiedToolCall } from "./interface.js";

type Raw = Record<string, unknown>;

interface PendingCall {
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
  outputIndex: number;
  completed: boolean;
}

export interface ResponsesStreamSnapshot extends ProtocolStreamSnapshot {
  toolCalls: UnifiedToolCall[];
  outputItems: JsonValue[];
  stopReason?: string;
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  const value = new Uint8Array(left.byteLength + right.byteLength);
  value.set(left); value.set(right, left.byteLength);
  return value;
}

function boundary(text: string): { index: number; length: number } | null {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(text);
  return match ? { index: match.index, length: match[0].length } : null;
}

/** Incremental parser for the OpenAI Responses SSE event model. */
export class ResponsesStreamParser implements ProtocolStreamParser {
  private readonly decoder = new TextDecoder();
  private rawBytes: Uint8Array = new Uint8Array();
  private pendingText = "";
  private readonly calls = new Map<string, PendingCall>();
  private readonly items = new Map<number, JsonValue>();
  private toolCalls: UnifiedToolCall[] = [];
  private messageCompleted = false;
  private terminal = false;
  private stopReason?: string;

  constructor(private readonly registry: NativeProxyToolRegistry) {}

  push(chunk: Uint8Array): ProtocolStreamEvent[] {
    this.rawBytes = appendBytes(this.rawBytes, chunk);
    this.pendingText += this.decoder.decode(chunk, { stream: true });
    const events: ProtocolStreamEvent[] = [];
    while (true) {
      const found = boundary(this.pendingText);
      if (!found) break;
      const frame = this.pendingText.slice(0, found.index);
      this.pendingText = this.pendingText.slice(found.index + found.length);
      events.push(...this.processFrame(frame));
    }
    return events;
  }

  finish(): ProtocolStreamEvent[] {
    this.pendingText += this.decoder.decode();
    const events = this.pendingText.trim() ? this.processFrame(this.pendingText) : [];
    this.pendingText = "";
    if (!this.terminal) events.push({ type: "protocol_error", code: "unexpected_eof", message: "Responses stream ended before response.completed" });
    return events;
  }

  snapshot(): ResponsesStreamSnapshot {
    return {
      rawBytes: this.rawBytes.slice(),
      messageCompleted: this.messageCompleted,
      toolCalls: structuredClone(this.toolCalls),
      outputItems: [...this.items.entries()].sort(([a], [b]) => a - b).map(([, item]) => structuredClone(item)),
      ...(this.stopReason ? { stopReason: this.stopReason } : {}),
    };
  }

  private processFrame(frame: string): ProtocolStreamEvent[] {
    const lines = frame.split(/\r?\n|\r/);
    const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = lines.filter((line) => line.startsWith("data:")), payloadText = data.map((line) => line.slice(5).trimStart()).join("\n");
    if (!payloadText || payloadText === "[DONE]") return [];
    let payload: Raw;
    try { payload = JSON.parse(payloadText) as Raw; }
    catch { return [{ type: "protocol_error", code: "invalid_sse_json", message: "Responses SSE data is not valid JSON" }]; }
    const type = typeof payload.type === "string" ? payload.type : eventName;
    if (!type) return [];
    if (type === "response.output_item.added" || type === "response.output_item.done") return this.onOutputItem(type, payload);
    if (type === "response.function_call_arguments.delta") return this.onArgumentsDelta(payload);
    if (type === "response.function_call_arguments.done") return this.onArgumentsDone(payload);
    if (type === "response.completed") {
      this.terminal = true; this.messageCompleted = true; this.stopReason = "completed";
      const response = payload.response as Raw | undefined;
      if (Array.isArray(response?.output)) response.output.forEach((item, index) => this.items.set(index, item as JsonValue));
      const events: ProtocolStreamEvent[] = [];
      if (response?.usage && typeof response.usage === "object") events.push({ type: "usage_updated", usage: response.usage as JsonValue });
      events.push({ type: "message_completed", stopReason: "completed" });
      return events;
    }
    if (["response.failed", "response.incomplete", "response.cancelled"].includes(type)) {
      this.terminal = true; this.stopReason = type.slice("response.".length);
      return [{ type: "protocol_error", code: type.replace(".", "_"), message: `Responses stream terminated with ${type}` }];
    }
    return [];
  }

  private onOutputItem(type: string, payload: Raw): ProtocolStreamEvent[] {
    if (!Number.isInteger(payload.output_index) || !payload.item || typeof payload.item !== "object") return [];
    const outputIndex = payload.output_index as number;
    const item = payload.item as Raw;
    if (type === "response.output_item.done") this.items.set(outputIndex, structuredClone(item) as JsonValue);
    if (item.type !== "function_call") return [];
    const itemId = typeof item.id === "string" ? item.id : `output:${outputIndex}`;
    const current = this.calls.get(itemId) ?? {
      itemId, callId: "", name: "", arguments: "", outputIndex, completed: false,
    };
    if (typeof item.call_id === "string") current.callId = item.call_id;
    if (typeof item.name === "string") current.name = item.name;
    if (typeof item.arguments === "string") current.arguments = item.arguments;
    this.calls.set(itemId, current);
    return type === "response.output_item.done" ? this.completeCall(current) : [];
  }

  private onArgumentsDelta(payload: Raw): ProtocolStreamEvent[] {
    const call = this.findCall(payload);
    if (call && typeof payload.delta === "string") call.arguments += payload.delta;
    return [];
  }

  private onArgumentsDone(payload: Raw): ProtocolStreamEvent[] {
    const call = this.findCall(payload);
    if (!call) return [];
    if (typeof payload.arguments === "string") call.arguments = payload.arguments;
    return this.completeCall(call);
  }

  private findCall(payload: Raw): PendingCall | undefined {
    if (typeof payload.item_id === "string") return this.calls.get(payload.item_id);
    if (Number.isInteger(payload.output_index)) return [...this.calls.values()].find((call) => call.outputIndex === payload.output_index);
    return undefined;
  }

  private completeCall(call: PendingCall): ProtocolStreamEvent[] {
    if (call.completed) return [];
    call.completed = true;
    const base = {
      callId: call.callId, toolName: call.name,
      owner: this.registry.owns(call.name) ? "proxy" as const : "client" as const,
      slotIndex: this.toolCalls.length, contentBlockIndex: call.outputIndex, argumentsComplete: true as const,
    };
    let unified: UnifiedToolCall;
    if (!call.callId || !call.name) unified = { ...base, parseError: { code: "invalid_tool_call", message: "Tool call is missing a call_id or function name" } };
    else {
      try { unified = { ...base, input: JSON.parse(call.arguments || "{}") as JsonValue }; }
      catch { unified = { ...base, parseError: { code: "invalid_tool_input_json", message: "Tool input is not valid JSON" } }; }
    }
    this.toolCalls.push(unified);
    if (!this.items.has(call.outputIndex)) {
      this.items.set(call.outputIndex, {
        type: "function_call",
        id: call.itemId,
        call_id: call.callId,
        name: call.name,
        arguments: call.arguments,
      });
    }
    return [{ type: "tool_call_completed", call: unified }];
  }
}
