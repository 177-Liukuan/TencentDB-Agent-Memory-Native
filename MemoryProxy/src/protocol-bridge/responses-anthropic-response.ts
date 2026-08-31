type Raw = Record<string, unknown>;

interface BlockState {
  outputIndex: number;
  blockIndex: number;
  kind: "text" | "thinking" | "tool_use";
  itemId: string;
  callId?: string;
  name?: string;
  started: boolean;
  stopped: boolean;
  emittedArguments: string;
}

export interface ResponsesAnthropicBridgeOptions {
  model?: string;
}

export class ResponsesAnthropicStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponsesAnthropicStreamError";
  }
}

function isRecord(value: unknown): value is Raw {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asInteger(value: unknown, fallback = 0): number {
  return Number.isInteger(value) ? value as number : fallback;
}

function anthropicUsage(value: unknown, includeInput: boolean): Raw {
  const usage = isRecord(value) ? value : {};
  const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
  return {
    ...(includeInput ? { input_tokens: asInteger(usage.input_tokens) } : {}),
    output_tokens: asInteger(usage.output_tokens),
    ...(includeInput && asInteger(details.cached_tokens) > 0
      ? { cache_read_input_tokens: asInteger(details.cached_tokens) }
      : {}),
  };
}

function sse(type: string, payload: Raw): Uint8Array {
  return new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function frameBoundary(text: string): { index: number; length: number } | null {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(text);
  return match ? { index: match.index, length: match[0].length } : null;
}

function parseFrame(frame: string): { type?: string; payload?: Raw } {
  const lines = frame.split(/\r?\n|\r/);
  const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
  const data = lines.filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart()).join("\n");
  if (!data || data === "[DONE]") return { type: event };
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new ResponsesAnthropicStreamError("Responses SSE data is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new ResponsesAnthropicStreamError("Responses SSE data must be an object");
  }
  return { type: typeof parsed.type === "string" ? parsed.type : event, payload: parsed };
}

class ResponsesAnthropicSseConverter {
  private readonly decoder = new TextDecoder();
  private pending = "";
  private readonly blocks = new Map<number, BlockState>();
  private nextBlockIndex = 0;
  private started = false;
  private terminal = false;
  private sawToolUse = false;
  private responseId = "response";
  private model: string;

  constructor(options: ResponsesAnthropicBridgeOptions = {}) {
    this.model = options.model ?? "unknown";
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (this.terminal) return [];
    this.pending += this.decoder.decode(chunk, { stream: true });
    return this.consumeFrames();
  }

  finish(): Uint8Array[] {
    this.pending += this.decoder.decode();
    const chunks = this.consumeFrames();
    if (this.pending.trim()) {
      const frame = this.pending;
      this.pending = "";
      chunks.push(...this.consumeFrame(frame));
    }
    if (!this.terminal) {
      throw new ResponsesAnthropicStreamError("Responses stream ended before a terminal response event");
    }
    return chunks;
  }

  private consumeFrames(): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    while (true) {
      const boundary = frameBoundary(this.pending);
      if (!boundary) break;
      const frame = this.pending.slice(0, boundary.index);
      this.pending = this.pending.slice(boundary.index + boundary.length);
      chunks.push(...this.consumeFrame(frame));
    }
    return chunks;
  }

  private consumeFrame(frame: string): Uint8Array[] {
    const { type, payload } = parseFrame(frame);
    if (!type || !payload) return [];
    switch (type) {
      case "response.created":
      case "response.in_progress":
        return this.start(payload.response);
      case "response.output_item.added":
        return this.outputItem(payload, false);
      case "response.output_item.done":
        return this.outputItem(payload, true);
      case "response.output_text.delta":
        return this.textDelta(payload, "text");
      case "response.reasoning_text.delta":
        return this.textDelta(payload, "thinking");
      case "response.output_text.done":
      case "response.reasoning_text.done":
        return this.stopByOutputIndex(payload);
      case "response.function_call_arguments.delta":
        return this.argumentsDelta(payload);
      case "response.function_call_arguments.done":
        return this.argumentsDone(payload);
      case "response.completed":
        return this.complete(payload.response, "completed");
      case "response.incomplete":
        return this.complete(payload.response, "incomplete");
      case "response.failed":
      case "response.cancelled":
        return this.fail(payload.response, type);
      case "error":
        return this.fail(payload, type);
      default:
        return [];
    }
  }

  private start(value: unknown): Uint8Array[] {
    if (this.started) return [];
    const response = isRecord(value) ? value : {};
    if (typeof response.id === "string") this.responseId = response.id;
    if (typeof response.model === "string") this.model = response.model;
    this.started = true;
    return [sse("message_start", {
      type: "message_start",
      message: {
        id: this.responseId,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: anthropicUsage(response.usage, true),
      },
    })];
  }

  private ensureStart(response?: unknown): Uint8Array[] {
    return this.started ? [] : this.start(response);
  }

  private outputItem(payload: Raw, done: boolean): Uint8Array[] {
    const outputIndex = asInteger(payload.output_index, -1);
    if (outputIndex < 0 || !isRecord(payload.item)) return [];
    const item = payload.item;
    const type = item.type;
    if (type === "function_call") {
      const state = this.block(outputIndex, "tool_use", item);
      const chunks = [...this.ensureStart(), ...this.startBlock(state)];
      if (done && typeof item.arguments === "string") {
        chunks.push(...this.emitRemainingArguments(state, item.arguments));
        chunks.push(...this.stopBlock(state));
      }
      return chunks;
    }
    if (type === "reasoning") {
      const state = this.block(outputIndex, "thinking", item);
      const chunks = this.ensureStart();
      if (done) {
        chunks.push(...this.emitItemContent(state, item));
        chunks.push(...this.stopBlock(state));
      }
      return chunks;
    }
    if (type === "message") {
      const state = this.block(outputIndex, "text", item);
      const chunks = this.ensureStart();
      if (done) {
        chunks.push(...this.emitItemContent(state, item));
        chunks.push(...this.stopBlock(state));
      }
      return chunks;
    }
    throw new ResponsesAnthropicStreamError(
      `Responses output item '${String(type)}' cannot be represented in Anthropic Messages`,
    );
  }

  private block(outputIndex: number, kind: BlockState["kind"], item: Raw = {}): BlockState {
    const existing = this.blocks.get(outputIndex);
    if (existing) return existing;
    const state: BlockState = {
      outputIndex,
      blockIndex: this.nextBlockIndex++,
      kind,
      itemId: typeof item.id === "string" ? item.id : `output_${outputIndex}`,
      ...(typeof item.call_id === "string" ? { callId: item.call_id } : {}),
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      started: false,
      stopped: false,
      emittedArguments: "",
    };
    this.blocks.set(outputIndex, state);
    return state;
  }

  private startBlock(state: BlockState): Uint8Array[] {
    if (state.started) return [];
    state.started = true;
    let contentBlock: Raw;
    if (state.kind === "text") contentBlock = { type: "text", text: "" };
    else if (state.kind === "thinking") {
      contentBlock = { type: "thinking", thinking: "", signature: state.itemId };
    } else {
      if (!state.callId || !state.name) {
        throw new ResponsesAnthropicStreamError("Responses function_call is missing call_id or name");
      }
      this.sawToolUse = true;
      contentBlock = { type: "tool_use", id: state.callId, name: state.name, input: {} };
    }
    return [sse("content_block_start", {
      type: "content_block_start",
      index: state.blockIndex,
      content_block: contentBlock,
    })];
  }

  private textDelta(payload: Raw, kind: "text" | "thinking"): Uint8Array[] {
    const outputIndex = asInteger(payload.output_index, -1);
    if (outputIndex < 0 || typeof payload.delta !== "string") return [];
    const state = this.block(outputIndex, kind, {
      id: typeof payload.item_id === "string" ? payload.item_id : undefined,
    });
    return [
      ...this.ensureStart(),
      ...this.startBlock(state),
      sse("content_block_delta", {
        type: "content_block_delta",
        index: state.blockIndex,
        delta: kind === "text"
          ? { type: "text_delta", text: payload.delta }
          : { type: "thinking_delta", thinking: payload.delta },
      }),
    ];
  }

  private argumentsDelta(payload: Raw): Uint8Array[] {
    const outputIndex = asInteger(payload.output_index, -1);
    if (outputIndex < 0 || typeof payload.delta !== "string") return [];
    const state = this.block(outputIndex, "tool_use", {
      id: payload.item_id,
      call_id: payload.call_id,
      name: payload.name,
    });
    state.emittedArguments += payload.delta;
    return [
      ...this.ensureStart(),
      ...this.startBlock(state),
      sse("content_block_delta", {
        type: "content_block_delta",
        index: state.blockIndex,
        delta: { type: "input_json_delta", partial_json: payload.delta },
      }),
    ];
  }

  private argumentsDone(payload: Raw): Uint8Array[] {
    const outputIndex = asInteger(payload.output_index, -1);
    const state = this.blocks.get(outputIndex);
    if (!state || state.kind !== "tool_use") return [];
    const chunks = this.emitRemainingArguments(
      state,
      typeof payload.arguments === "string" ? payload.arguments : state.emittedArguments,
    );
    chunks.push(...this.stopBlock(state));
    return chunks;
  }

  private emitRemainingArguments(state: BlockState, complete: string): Uint8Array[] {
    if (complete === state.emittedArguments) return [];
    if (!complete.startsWith(state.emittedArguments)) {
      throw new ResponsesAnthropicStreamError("Responses function arguments changed after streaming deltas");
    }
    const delta = complete.slice(state.emittedArguments.length);
    state.emittedArguments = complete;
    return delta.length === 0 ? [] : [sse("content_block_delta", {
      type: "content_block_delta",
      index: state.blockIndex,
      delta: { type: "input_json_delta", partial_json: delta },
    })];
  }

  private emitItemContent(state: BlockState, item: Raw): Uint8Array[] {
    if (state.started || !Array.isArray(item.content)) return [];
    const chunks = this.startBlock(state);
    for (const part of item.content) {
      if (!isRecord(part)) continue;
      const text = typeof part.text === "string" ? part.text : "";
      if (!text) continue;
      chunks.push(sse("content_block_delta", {
        type: "content_block_delta",
        index: state.blockIndex,
        delta: state.kind === "thinking"
          ? { type: "thinking_delta", thinking: text }
          : { type: "text_delta", text },
      }));
    }
    return chunks;
  }

  private stopByOutputIndex(payload: Raw): Uint8Array[] {
    const state = this.blocks.get(asInteger(payload.output_index, -1));
    return state ? this.stopBlock(state) : [];
  }

  private stopBlock(state: BlockState): Uint8Array[] {
    if (state.stopped) return [];
    const chunks = this.startBlock(state);
    state.stopped = true;
    chunks.push(sse("content_block_stop", {
      type: "content_block_stop",
      index: state.blockIndex,
    }));
    return chunks;
  }

  private complete(value: unknown, status: "completed" | "incomplete"): Uint8Array[] {
    const response = isRecord(value) ? value : {};
    const chunks = this.ensureStart(response);
    for (const state of [...this.blocks.values()].sort((a, b) => a.blockIndex - b.blockIndex)) {
      chunks.push(...this.stopBlock(state));
    }
    const details = isRecord(response.incomplete_details) ? response.incomplete_details : {};
    const stopReason = this.sawToolUse
      ? "tool_use"
      : status === "incomplete" && details.reason === "max_output_tokens"
        ? "max_tokens"
        : "end_turn";
    chunks.push(sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: anthropicUsage(response.usage, false),
    }));
    chunks.push(sse("message_stop", { type: "message_stop" }));
    this.terminal = true;
    return chunks;
  }

  private fail(value: unknown, type: string): Uint8Array[] {
    const response = isRecord(value) ? value : {};
    const error = isRecord(response.error) ? response.error : response;
    const message = typeof error.message === "string"
      ? error.message
      : `Responses upstream terminated with ${type}`;
    this.terminal = true;
    return [sse("error", {
      type: "error",
      error: { type: "api_error", message },
    })];
  }
}

export function createResponsesToAnthropicSseTransform(
  options: ResponsesAnthropicBridgeOptions = {},
): TransformStream<Uint8Array, Uint8Array> {
  const converter = new ResponsesAnthropicSseConverter(options);
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (const output of converter.push(chunk)) controller.enqueue(output);
    },
    flush(controller) {
      for (const output of converter.finish()) controller.enqueue(output);
    },
  });
}

/** Buffered conversion used by the durable Tool Loop before client replay. */
export function convertResponsesSseBytesToAnthropic(
  chunks: readonly Uint8Array[],
  options: ResponsesAnthropicBridgeOptions = {},
): Uint8Array {
  const converter = new ResponsesAnthropicSseConverter(options);
  const output: Uint8Array[] = [];
  for (const chunk of chunks) output.push(...converter.push(chunk));
  output.push(...converter.finish());
  return concatBytes(output);
}

function responseTextParts(item: Raw): string[] {
  if (!Array.isArray(item.content)) return [];
  return item.content.filter(isRecord)
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean);
}

/** Convert a non-streaming Responses object into an Anthropic Message object. */
export function convertResponsesJsonToAnthropic(value: unknown): Raw {
  if (!isRecord(value)) {
    throw new ResponsesAnthropicStreamError("Responses JSON body must be an object");
  }
  if (value.error) {
    const error = isRecord(value.error) ? value.error : {};
    return {
      type: "error",
      error: {
        type: "api_error",
        message: typeof error.message === "string" ? error.message : "Responses upstream failed",
      },
    };
  }
  if (!Array.isArray(value.output)) {
    throw new ResponsesAnthropicStreamError("Responses JSON body is missing output items");
  }
  const content: Raw[] = [];
  let sawToolUse = false;
  for (const item of value.output) {
    if (!isRecord(item)) continue;
    if (item.type === "reasoning") {
      const thinking = responseTextParts(item).join("");
      if (thinking) content.push({
        type: "thinking",
        thinking,
        signature: typeof item.id === "string" ? item.id : "",
      });
      continue;
    }
    if (item.type === "message") {
      for (const text of responseTextParts(item)) content.push({ type: "text", text });
      continue;
    }
    if (item.type === "function_call") {
      const callId = typeof item.call_id === "string" ? item.call_id : "";
      const name = typeof item.name === "string" ? item.name : "";
      if (!callId || !name) {
        throw new ResponsesAnthropicStreamError("Responses function_call is missing call_id or name");
      }
      let input: unknown;
      try {
        input = JSON.parse(typeof item.arguments === "string" ? item.arguments : "{}");
      } catch {
        throw new ResponsesAnthropicStreamError("Responses function_call arguments are not valid JSON");
      }
      sawToolUse = true;
      content.push({ type: "tool_use", id: callId, name, input });
      continue;
    }
    if (typeof item.type === "string") {
      throw new ResponsesAnthropicStreamError(`Responses Provider Tool '${item.type}' cannot be represented in Anthropic Messages`);
    }
  }
  return {
    id: typeof value.id === "string" ? value.id : "response",
    type: "message",
    role: "assistant",
    model: typeof value.model === "string" ? value.model : "unknown",
    content,
    stop_reason: sawToolUse
      ? "tool_use"
      : value.status === "incomplete" && isRecord(value.incomplete_details)
        && value.incomplete_details.reason === "max_output_tokens"
        ? "max_tokens"
        : "end_turn",
    stop_sequence: null,
    usage: anthropicUsage(value.usage, true),
  };
}
