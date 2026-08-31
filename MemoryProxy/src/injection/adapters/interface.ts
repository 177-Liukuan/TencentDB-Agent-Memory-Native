/**
 * ProtocolAdapter interface.
 * Responsible for converting protocol-specific request/response to/from AgentContext.
 */

import type { AgentContext, AgentContextMetadata, Protocol } from "../types.js";
import type { NativeProxyToolRegistry } from "../../native-proxy-tools/tool-registry.js";
import type { JsonValue } from "../../native-proxy-tools/types.js";

export interface UnifiedToolCallParseError {
  code: "invalid_tool_input_json" | "invalid_tool_call";
  message: string;
}

export interface UnifiedToolCall {
  callId: string;
  toolName: string;
  owner: "proxy" | "client";
  slotIndex: number;
  contentBlockIndex: number;
  argumentsComplete: true;
  input?: JsonValue;
  parseError?: UnifiedToolCallParseError;
}

export type ProtocolStreamEvent =
  | { type: "message_started"; message: JsonValue }
  | { type: "content_block_started"; index: number; block: JsonValue }
  | { type: "content_block_delta"; index: number; delta: JsonValue }
  | { type: "content_block_completed"; index: number; block: JsonValue }
  | { type: "tool_call_completed"; call: UnifiedToolCall }
  | { type: "usage_updated"; usage: JsonValue }
  | { type: "message_completed"; stopReason?: string }
  | { type: "protocol_error"; code: string; message: string };

export interface ProtocolStreamSnapshot {
  rawBytes: Uint8Array;
  messageCompleted: boolean;
}

export interface ProtocolStreamParser {
  push(chunk: Uint8Array): ProtocolStreamEvent[];
  finish(): ProtocolStreamEvent[];
  snapshot(): ProtocolStreamSnapshot;
}

/**
 * Protocol adapter: handles parse (raw body → AgentContext)
 * and serialize (AgentContext → raw body).
 */
export interface ProtocolAdapter {
  /** Protocol identifier. */
  readonly protocol: Protocol;

  /**
   * Parse a raw request body into an AgentContext.
   * @param body Raw request body (protocol-specific format)
   * @param metadata Request metadata (traceId, keyId, etc.)
   * @returns Parsed AgentContext
   */
  parse(body: Record<string, unknown>, metadata: AgentContextMetadata): AgentContext;

  /**
   * Serialize an AgentContext back into protocol-native request body format.
   * @param ctx The (possibly modified) AgentContext
   * @returns A body object that can be directly used with fetch()
   */
  serialize(ctx: AgentContext): Record<string, unknown>;

  /** Create an incremental response parser when the protocol supports it. */
  createStreamParser?(registry: NativeProxyToolRegistry): ProtocolStreamParser;
}
