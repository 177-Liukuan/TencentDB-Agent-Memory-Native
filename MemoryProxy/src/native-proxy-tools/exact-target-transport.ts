import { createHash } from "node:crypto";

import { joinUrl } from "../guard-adapter.js";
import type { ProxyConfig } from "../types.js";
import type {
  NativeReentryRequest,
  UpstreamRound,
} from "./tool-loop-coordinator.js";
import type {
  JsonValue,
  PersistedForwardTarget,
  PersistedToolObservationIntent,
  NativeToolProtocol,
  UpstreamRequestSnapshot,
} from "./types.js";

const REQUEST_PARAMETER_ALLOWLIST = new Set([
  "model",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "stream",
  "thinking",
  "tool_choice",
  "metadata",
  "service_tier",
  "frequency_penalty",
  "presence_penalty",
  "parallel_tool_calls",
  "response_format",
  "seed",
  "stream_options",
  "max_output_tokens",
  "reasoning",
  "text",
  "include",
  "truncation",
  "previous_response_id",
  "conversation",
  "store",
  "background",
]);

const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "x-tdai-user-key",
]);

const SKIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "connection",
]);

export class NativeToolTargetUnavailableError extends Error {
  constructor() {
    super("The persisted Native Proxy Tool upstream target is unavailable");
    this.name = "NativeToolTargetUnavailableError";
  }
}

export interface BuildUpstreamRequestSnapshotInput {
  protocol?: UpstreamRequestSnapshot["protocol"];
  body: Record<string, unknown>;
  url: string;
  model: string;
  authSource: PersistedForwardTarget["authSource"];
  requestFingerprint?: string;
  observationIntent?: PersistedToolObservationIntent;
  logicalBaseMessages?: unknown[];
  clientProtocol?: NativeToolProtocol;
  previousClientToolCallId?: string | null;
}

export interface ExactTargetTransportOptions {
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  beforeFetch?(model: string): Promise<void>;
}

export interface RetainedExactTargetTransportOptions extends ExactTargetTransportOptions {
  capturedSnapshot: UpstreamRequestSnapshot;
  headers: Record<string, string>;
}

export interface RestartExactTargetTransportOptions extends ExactTargetTransportOptions {
  config: ProxyConfig;
  currentModel: string;
  agentSource: string;
  requestPath: string;
  sessionId: string;
  currentRequestHeaders: Record<string, string>;
}

function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

function asJsonValue(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Value is not JSON serializable");
  return JSON.parse(encoded) as JsonValue;
}

function asJsonArray(value: unknown, field: string): JsonValue[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return asJsonValue(value) as JsonValue[];
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((name) => (
    `${JSON.stringify(name)}:${canonicalJson(value[name])}`
  )).join(",")}}`;
}

/** Digest the complete client-visible logical request before hidden Tool injection. */
export function fingerprintAnthropicLogicalRequest(body: Record<string, unknown>): string {
  const normalized = asJsonValue(body);
  return `sha256:${createHash("sha256").update(canonicalJson(normalized)).digest("hex")}`;
}

export function createPersistedForwardTarget(input: {
  url: string;
  model: string;
  authSource: PersistedForwardTarget["authSource"];
}): PersistedForwardTarget {
  const identity = JSON.stringify([input.url, input.model, input.authSource]);
  return {
    id: `sha256:${createHash("sha256").update(identity).digest("hex")}`,
    url: input.url,
    model: input.model,
    authSource: input.authSource,
  };
}

export function buildUpstreamRequestSnapshot(
  input: BuildUpstreamRequestSnapshotInput,
): UpstreamRequestSnapshot {
  const requestParameters: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(input.body)) {
    if (!REQUEST_PARAMETER_ALLOWLIST.has(name) || value === undefined) continue;
    requestParameters[name] = asJsonValue(value);
  }

  const inputField = input.protocol === "responses" ? "input" : "messages";
  const rawBase = input.body[inputField];
  const baseMessages = Array.isArray(rawBase)
    ? asJsonArray(rawBase, inputField)
    : input.protocol === "responses" && typeof rawBase === "string"
      ? [asJsonValue({ role: "user", content: rawBase })]
      : asJsonArray(rawBase, inputField);
  const logicalBaseMessages = input.logicalBaseMessages === undefined
    ? baseMessages
    : asJsonArray(input.logicalBaseMessages, "logicalBaseMessages");
  return {
    protocol: input.protocol ?? "anthropic",
    ...(input.clientProtocol ? { clientProtocol: input.clientProtocol } : {}),
    baseMessages,
    logicalBaseMessages: cloneJson(logicalBaseMessages),
    ...(input.previousClientToolCallId !== undefined
      ? { previousClientToolCallId: input.previousClientToolCallId }
      : {}),
    ...(input.requestFingerprint !== undefined
      ? { requestFingerprint: input.requestFingerprint }
      : {}),
    ...(input.observationIntent !== undefined
      ? { observationIntent: structuredClone(input.observationIntent) }
      : {}),
    ...(input.body.system !== undefined
      ? { system: asJsonValue(input.body.system) }
      : {}),
    ...(input.body.instructions !== undefined
      ? { instructions: asJsonValue(input.body.instructions) }
      : {}),
    ...(input.body.tools !== undefined
      ? { tools: asJsonArray(input.body.tools, "tools") }
      : {}),
    requestParameters,
    target: createPersistedForwardTarget({
      url: input.url,
      model: input.model,
      authSource: input.authSource,
    }),
  };
}

function validateSnapshot(snapshot: UpstreamRequestSnapshot): void {
  if (!["anthropic", "openai", "responses"].includes(snapshot.protocol)) throw new NativeToolTargetUnavailableError();
  if (
    snapshot.requestParameters.model !== snapshot.target.model
    || snapshot.requestParameters.stream !== true
  ) {
    throw new NativeToolTargetUnavailableError();
  }
  const expected = createPersistedForwardTarget(snapshot.target);
  if (expected.id !== snapshot.target.id) throw new NativeToolTargetUnavailableError();
  let parsed: URL;
  try {
    parsed = new URL(snapshot.target.url);
  } catch {
    throw new NativeToolTargetUnavailableError();
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new NativeToolTargetUnavailableError();
  }
}

function sameTarget(
  left: PersistedForwardTarget,
  right: PersistedForwardTarget,
): boolean {
  return left.id === right.id
    && left.url === right.url
    && left.model === right.model
    && left.authSource === right.authSource;
}

function buildReentryBody(
  snapshot: UpstreamRequestSnapshot,
  messages: JsonValue[],
): Record<string, JsonValue> {
  const shared = {
    ...cloneJson(snapshot.requestParameters),
    ...(snapshot.system !== undefined ? { system: cloneJson(snapshot.system) } : {}),
    ...(snapshot.instructions !== undefined ? { instructions: cloneJson(snapshot.instructions) } : {}),
    ...(snapshot.tools !== undefined ? { tools: cloneJson(snapshot.tools) } : {}),
  };
  return snapshot.protocol === "responses"
    ? { ...shared, input: cloneJson(messages) }
    : { ...shared, messages: cloneJson(messages) };
}

function sanitizeRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!SKIP_REQUEST_HEADERS.has(name.toLowerCase())) sanitized[name] = value;
  }
  sanitized["content-type"] = "application/json";
  return sanitized;
}

function sanitizeResponseHeaders(headers: Headers): Headers {
  const sanitized = new Headers();
  for (const [name, value] of headers.entries()) {
    if (!SKIP_RESPONSE_HEADERS.has(name.toLowerCase())) sanitized.set(name, value);
  }
  return sanitized;
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

async function sendExactRound(
  request: NativeReentryRequest,
  headers: Record<string, string>,
  options: ExactTargetTransportOptions,
): Promise<UpstreamRound> {
  validateSnapshot(request.upstreamSnapshot);
  request.signal?.throwIfAborted();
  await options.beforeFetch?.(request.upstreamSnapshot.target.model);
  request.signal?.throwIfAborted();
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(request.upstreamSnapshot.target.url, {
      method: "POST",
      headers,
      body: JSON.stringify(buildReentryBody(request.upstreamSnapshot, request.messages)),
      signal: request.signal
        ? AbortSignal.any([request.signal, AbortSignal.timeout(options.timeoutMs)])
        : AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    throw new Error("Native Proxy Tool upstream re-entry failed");
  }
  return {
    stream: response.body ?? emptyStream(),
    status: response.status,
    headers: sanitizeResponseHeaders(response.headers),
  };
}

export function createRetainedExactTargetTransport(
  options: RetainedExactTargetTransportOptions,
): (request: NativeReentryRequest) => Promise<UpstreamRound> {
  validateSnapshot(options.capturedSnapshot);
  const capturedTarget = structuredClone(options.capturedSnapshot.target);
  const headers = sanitizeRequestHeaders(options.headers);
  return async (request) => {
    validateSnapshot(request.upstreamSnapshot);
    if (!sameTarget(request.upstreamSnapshot.target, capturedTarget)) {
      throw new NativeToolTargetUnavailableError();
    }
    return sendExactRound(request, headers, options);
  };
}

interface RestartCandidate {
  url: string;
  authSource: "client" | "global" | "agent";
  apiKey: string;
}

function restartCandidates(options: RestartExactTargetTransportOptions): RestartCandidate[] {
  const candidates: RestartCandidate[] = [];
  const agent = options.config.upstream.agents[options.agentSource];
  const endpoints = [
    options.config.costGuard.anthropicUpstream?.url,
    options.config.upstream.url,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  // A protocol-only agent inherits the global endpoint and credential. Only
  // build agent-auth candidates when the entry actually overrides routing or
  // auth; calling joinUrl(undefined, ...) would also break restart recovery.
  if (agent && (agent.url !== undefined || agent.apiKey !== undefined)) {
    const agentAuthSource = agent.apiKey ? "agent" : "client";
    if (agent.url) {
      candidates.push({
        url: joinUrl(agent.url, options.requestPath),
        authSource: agentAuthSource,
        apiKey: agent.apiKey ?? "",
      });
    }
    // A routed request can retry on either configured default endpoint while
    // deliberately keeping the per-agent/client credential selected for the
    // first attempt. Persisted target identity, not endpoint class, decides.
    for (const endpoint of endpoints) {
      candidates.push({
        url: joinUrl(endpoint, options.requestPath),
        authSource: agentAuthSource,
        apiKey: agent.apiKey ?? "",
      });
    }
  }

  const globalAuthSource = options.config.upstream.apiKey ? "global" : "client";
  const globalApiKey = options.config.upstream.apiKey;
  for (const endpoint of endpoints) {
    candidates.push({
      url: joinUrl(endpoint, options.requestPath),
      authSource: globalAuthSource,
      apiKey: globalApiKey,
    });
  }
  return candidates.filter((candidate, index) => candidates.findIndex((entry) => (
    entry.url === candidate.url && entry.authSource === candidate.authSource
  )) === index);
}

function restartHeaders(
  candidate: RestartCandidate,
  options: RestartExactTargetTransportOptions,
  protocol: UpstreamRequestSnapshot["protocol"],
): Record<string, string> {
  const headers = sanitizeRequestHeaders(options.currentRequestHeaders);
  if (candidate.authSource !== "client") {
    if (!candidate.apiKey) throw new NativeToolTargetUnavailableError();
    if (protocol === "openai" || protocol === "responses") {
      headers.authorization = `Bearer ${candidate.apiKey}`;
      delete headers["x-api-key"];
    } else {
      headers["x-api-key"] = candidate.apiKey;
      delete headers.authorization;
      delete headers.Authorization;
    }
  }
  headers["x-vertex-ai-session-id"] = options.sessionId;
  return headers;
}

export function createRestartExactTargetTransport(
  options: RestartExactTargetTransportOptions,
): (request: NativeReentryRequest) => Promise<UpstreamRound> {
  const candidates = restartCandidates(options);
  return async (request) => {
    const snapshot = request.upstreamSnapshot;
    validateSnapshot(snapshot);
    if (
      snapshot.target.authSource === "extension"
      || snapshot.target.model !== options.currentModel
    ) {
      throw new NativeToolTargetUnavailableError();
    }
    const candidate = candidates.find((entry) => (
      entry.url === snapshot.target.url
      && entry.authSource === snapshot.target.authSource
    ));
    if (!candidate) throw new NativeToolTargetUnavailableError();
    return sendExactRound(request, restartHeaders(candidate, options, snapshot.protocol), options);
  };
}
