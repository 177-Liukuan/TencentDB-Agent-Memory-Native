/**
 * Anthropic Messages API handler.
 * Supports /v1/messages endpoint with streaming (SSE) and non-streaming modes.
 * Integrates with routing module, Opik observability, and JSONL logging.
 *
 * This handler uses ForwardTarget opaquely — no routing semantics
 * leak into the handler. All routing logic is encapsulated in the private module.
 */

import type { Context } from "hono";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { writeLog, createPipeline } from "./logger.js";
import {
  apiKeyToKeyId,
  opikCreateLlmSpan,
  opikCreateTrace,
  uuidv7,
} from "./opik.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "./langfuse.js";
import { countHumanTurns } from "./turnSeq.js";
import type { ProxyConfig } from "./types.js";
import {
  resolveForwardTarget,
  resolveSessionKey,
  resolveLatestUserQuery,
  type ForwardTarget,
} from "./guard-adapter.js";
import { hasCostGuardMarker, matchWhitelistEndpoint } from "./routes/whitelist.js";
import { writeRequestLog } from "./requestLog.js";
import { prepareUpstreamRequest, notifyUpstreamResponse } from "./request-prepare-adapter.js";
import { tryReportCreditFromPath, extractSpaceIdFromPath } from "./credit-reporter.js";
import { resolveModelId, isModelInPricing } from "./pricing.js";
import { inspectAndRecord } from "./identity.js";
import { writeFailedReportRaw } from "./clickhouse.js";
import { verifyUserKey } from "./auth.js";
import { matchSystemUserByUserId, hasSystemUsers } from "./systemUser.js";
import { handleSystemUserPassthrough } from "./systemUserPassthrough.js";
import { TdaiClient } from "./tdai/client.js";
import { deriveTdaiIdentity } from "./tdai/identity.js";
import { extractLatestUserMessage, recordTdaiTurn } from "./tdai/recorder.js";
import { trackWrite, withL0Retry } from "./tdai/pending-writes.js";
import type { TdaiIdentity, TdaiMessage } from "./tdai/types.js";
import { triggerSkillExtractIfReady } from "./skill/handler-glue.js";
import { emitModelIntentTelemetry } from "./session/model-intent-telemetry.js";
import { isExtractionAllowed, logExtractionSkipped } from "./extraction-gate.js";
import {
  isClaudeCodeWebSearchSidequery,
  type CcRequestKind,
} from "./common/cc-request-classifier.js";
import { buildRequestDebugMetadata } from "./common/langfuse-debug.js";
import { resolveAgentAdapter } from "./agent-adapters/index.js";
import { stripSessionInitArtifacts } from "./session/claude-code/form.js";
import {
  enforceRateLimit,
  isRateLimitExceededError,
  recordInputTokenUsage,
} from "./rate-limit/guard.js";
import { describeNativeProxyToolInjectionFailure } from "./native-proxy-tools/native-proxy-tools-injector.js";
import { getNativeProxyToolRuntime } from "./native-proxy-tools/runtime.js";
import type { NativeProxyToolRegistry } from "./native-proxy-tools/tool-registry.js";
import { AnthropicToolLoopCoordinator, type ToolLoopDecision } from "./native-proxy-tools/tool-loop-coordinator.js";
import { AnthropicClientResponsesToolLoopCoordinator } from "./native-proxy-tools/anthropic-client-responses-tool-loop.js";
import type { OpenAIToolLoopDecision } from "./native-proxy-tools/openai-tool-loop-coordinator.js";
import {
  completeClientToolReentry,
  createPersistedClientReentryOutcome,
  renewClientToolReentry,
  resumeClientToolResults,
} from "./native-proxy-tools/client-tool-resume.js";
import {
  buildUpstreamRequestSnapshot,
  createRestartExactTargetTransport,
  createRetainedExactTargetTransport,
  fingerprintAnthropicLogicalRequest,
} from "./native-proxy-tools/exact-target-transport.js";
import type {
  PersistedForwardTarget,
  PersistedToolObservationIntent,
  JsonValue,
  ToolExecutionContext,
  ToolExecutionScope,
  ToolExecutionStateKey,
} from "./native-proxy-tools/types.js";
import { nativeToolLeaseDurationMs } from "./native-proxy-tools/types.js";
import { buildClientVisibleAnthropicSse } from "./native-proxy-tools/anthropic-response-rebuilder.js";
import { isLogicalFinalToolLoopDecision } from "./native-proxy-tools/observation-policy.js";
import {
  claimToolObservation,
  completeToolObservation,
  ToolObservationOutboxError,
} from "./native-proxy-tools/observation-outbox.js";
import { extractAnthropicLogicalResponse } from "./native-proxy-tools/anthropic-logical-response.js";
import type { ToolExecutionStorageAdapter } from "./db/tool-execution-storage-adapter.js";
import {
  AnthropicResponsesConversionError,
  convertAnthropicRequestToResponses,
} from "./protocol-bridge/anthropic-responses-request.js";
import {
  convertResponsesSseBytesToAnthropic,
  convertResponsesJsonToAnthropic,
  createResponsesToAnthropicSseTransform,
} from "./protocol-bridge/responses-anthropic-response.js";
import { buildClientVisibleResponsesSse } from "./native-proxy-tools/responses-response-rebuilder.js";
import {
  materializeClaudeToolLedgerHistory,
  NativeToolLedgerConflictError,
} from "./native-proxy-tools/tool-history-reconstructor.js";
import { extractClaudeTurnMarkers } from "./native-proxy-tools/turn-marker.js";

const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  // 内部身份头只给 proxy/session-init 使用，不能透传给上游模型服务。
  "x-tdai-user-key",
]);

const SKIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "connection",
]);

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice());
      controller.close();
    },
  });
}

function nativeToolErrorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return new Response(JSON.stringify({
    type: "error",
    error: {
      type: status >= 500 ? "api_error" : "invalid_request_error",
      code,
      message,
    },
  }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function nativeToolScope(input: {
  spaceId: string;
  userId: string;
  agentSource: string;
  sessionKey: string;
  sessionInfo?: Record<string, unknown> | null;
  config: ProxyConfig;
}): ToolExecutionScope {
  const sessionSpaceId = typeof input.sessionInfo?.space_id === "string"
    ? input.sessionInfo.space_id
    : "";
  const sessionUserId = typeof input.sessionInfo?.user_id === "string"
    ? input.sessionInfo.user_id
    : "";
  return {
    spaceId: sessionSpaceId || input.spaceId || input.config.tdai.serviceId || input.config.coreSkill.serviceId,
    userId: sessionUserId || input.userId || "anonymous",
    agentSource: input.agentSource,
    sessionId: input.sessionKey,
    contextVersion: "v1",
  };
}

function nativeReentryLeaseWindowMs(config: ProxyConfig): number {
  const configuredForward = config.server.forwardTimeoutMs ?? 600_000;
  const forwardWindow = configuredForward > 0
    ? configuredForward
    : config.nativeProxyTools.stateTtlSeconds * 1_000;
  return forwardWindow + nativeToolLeaseDurationMs(config.nativeProxyTools.toolTimeoutMs);
}

function successfulAuthSource(input: {
  retried: boolean;
  target: ForwardTarget;
  effectiveApiKey: string;
  hasAgentEntry: boolean;
}): PersistedForwardTarget["authSource"] {
  if (!input.retried && input.target.authHeaders) return "extension";
  if (!input.effectiveApiKey) return "client";
  return input.hasAgentEntry ? "agent" : "global";
}

/**
 * Build a per-request TdaiClient. `spaceId` (extracted from the request path
 * `/{agent}/{spaceId}/...`) overrides `config.tdai.serviceId` so writes/recalls
 * land on the correct kernel tenant. Falls back to config when the request
 * carries no spaceId (older single-tenant deployments).
 */
function createTdaiClient(config: ProxyConfig, spaceId?: string): TdaiClient | null {
  if (!config.tdai.enabled || !config.tdai.memory.enabled || !config.tdai.endpoint) return null;
  return new TdaiClient({
    enabled: config.tdai.enabled && config.tdai.memory.enabled,
    endpoint: config.tdai.endpoint,
    apiKey: config.tdai.apiKey,
    serviceId: spaceId || config.tdai.serviceId,
    writeL0: config.tdai.memory.writeL0,
    recallL1: config.tdai.memory.recallL1,
    injectL2L3: config.tdai.memory.injectL2L3,
    l1Limit: config.tdai.memory.l1Limit,
    l2Limit: config.tdai.memory.l2Limit,
    timeoutMs: config.tdai.memory.timeoutMs,
  });
}

async function flushDurableNativeToolObservation(input: {
  storage: ToolExecutionStorageAdapter;
  stateKey: ToolExecutionStateKey;
  bytes?: Uint8Array;
  leaseMs: number;
  config: ProxyConfig;
}): Promise<void> {
  const persisted = await input.storage.get(input.stateKey);
  if (!persisted) {
    throw new ToolObservationOutboxError(
      "native_tool_observation_state_unavailable",
      "Native Tool observation state is unavailable",
    );
  }
  if (persisted.observationStatus === undefined
    || persisted.observationStatus === "none"
    || persisted.observationStatus === "completed") return;

  const intent = persisted.upstreamSnapshot.observationIntent;
  const outcome = persisted.observationOutcome;
  const logicalMessages = persisted.upstreamSnapshot.logicalBaseMessages;
  if (!intent || !outcome || !logicalMessages) {
    throw new ToolObservationOutboxError(
      "native_tool_observation_payload_unavailable",
      "Native Tool observation payload is unavailable",
    );
  }
  const responseBytes = new Uint8Array(Buffer.from(outcome.bodyBase64, "base64"));
  if (input.bytes && !Buffer.from(input.bytes).equals(Buffer.from(responseBytes))) {
    throw new ToolObservationOutboxError(
      "native_tool_observation_payload_mismatch",
      "Native Tool observation payload does not match persisted state",
    );
  }
  const response = extractAnthropicLogicalResponse(responseBytes);
  const sessionInfo: Record<string, unknown> = {
    space_id: intent.identity.spaceId,
    team_id: intent.identity.teamId,
    user_id: intent.identity.userId,
    agent_id: intent.identity.agentId,
    session_id: intent.identity.sessionId,
    ...(intent.identity.taskId ? { task_id: intent.identity.taskId } : {}),
  };
  const tdaiIdentity: TdaiIdentity = {
    teamId: intent.identity.teamId,
    userId: intent.identity.userId,
    agentId: intent.identity.agentId,
    sessionId: intent.identity.sessionId,
    ...(intent.identity.taskId ? { taskId: intent.identity.taskId } : {}),
  };
  const tdaiUserMessage = extractLatestUserMessage(logicalMessages);
  const tdaiClient = intent.effects.tdai
    ? createTdaiClient(input.config, intent.identity.spaceId)
    : null;
  if (intent.effects.tdai && (
    !tdaiClient
    || !tdaiUserMessage
    || !input.config.tdai.memory.writeL0
  )) {
    throw new ToolObservationOutboxError(
      "native_tool_observation_dependency_unavailable",
      "Native Tool memory writeback dependency is unavailable",
    );
  }
  if (intent.effects.skill && (
    !input.config.coreSkill?.endpoint
    || !input.config.coreSkill?.serviceToken
  )) {
    throw new ToolObservationOutboxError(
      "native_tool_observation_dependency_unavailable",
      "Native Tool skill writeback dependency is unavailable",
    );
  }

  const claim = await claimToolObservation({
    storage: input.storage,
    key: input.stateKey,
    leaseMs: input.leaseMs,
  });
  if (intent.effects.tdai) {
    await withL0Retry(() => recordTdaiTurn(
      tdaiClient!,
      tdaiIdentity,
      tdaiUserMessage,
      response.outputText || null,
      {
        idempotencyKey: claim.idempotencyKey,
        requireSuccess: true,
      },
    ));
  }

  if (intent.effects.skill) {
    await triggerSkillExtractIfReady({
      config: input.config,
      sessionKey: intent.identity.sessionId,
      agentSource: intent.agentSource,
      sessionInfo,
      inputMessages: logicalMessages,
      assistantMessage: response.outputText
        ? { role: "assistant", content: response.outputText }
        : null,
      protocol: "anthropic",
      toolCallCountOverride: response.toolUseCount,
      idempotencyKey: claim.idempotencyKey,
      throwOnError: true,
    });
  }
  await completeToolObservation(
    input.storage,
    input.stateKey,
    claim.leaseOwner,
  );
}

function buildPersistedToolObservationIntent(input: {
  config: ProxyConfig;
  scope: ToolExecutionScope;
  requestKind: CcRequestKind;
  tdaiIdentity: TdaiIdentity | null;
  logicalMessages: unknown[];
  assetCapabilities?: import("./injection/types.js").AssetCapabilityFlags;
}): PersistedToolObservationIntent | undefined {
  const identity = input.tdaiIdentity;
  if (!identity) return undefined;
  const isMain = input.requestKind === "main";
  const tdai = isMain
    && input.assetCapabilities?.chat_memory !== false
    && input.config.tdai.enabled
    && input.config.tdai.memory.enabled
    && input.config.tdai.memory.writeL0
    && Boolean(input.config.tdai.endpoint)
    && isExtractionAllowed(input.config, "tdai-memory")
    && extractLatestUserMessage(input.logicalMessages) !== null;
  const skill = isMain
    && input.assetCapabilities?.skill !== false
    && Boolean(input.config.coreSkill?.endpoint)
    && Boolean(input.config.coreSkill?.serviceToken)
    && isExtractionAllowed(input.config, "skill");
  return {
    version: 1,
    agentSource: input.scope.agentSource,
    identity: {
      spaceId: input.scope.spaceId,
      teamId: identity.teamId,
      userId: identity.userId,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      ...(identity.taskId ? { taskId: identity.taskId } : {}),
    },
    effects: { tdai, skill },
  };
}

async function findRecoverableNativeObservation(input: {
  storage: ToolExecutionStorageAdapter;
  scope: ToolExecutionScope;
  requestFingerprint: string;
}): Promise<ToolExecutionContext | null> {
  const contexts = await input.storage.findActiveBySession(input.scope);
  return contexts
    .filter((context) => (
      context.responseStreamStatus === "completed"
      && context.clientDispatchStatus === "none"
      && context.upstreamSnapshot.requestFingerprint === input.requestFingerprint
      && context.observationOutcome !== undefined
      && ["pending", "running", "completed"].includes(context.observationStatus ?? "none")
    ))
    .sort((left, right) => (
      right.turnSeq - left.turnSeq
      || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    ))[0] ?? null;
}

async function replayRecoverableNativeObservation(input: {
  storage: ToolExecutionStorageAdapter;
  scope: ToolExecutionScope;
  requestFingerprint: string;
  leaseMs: number;
  config: ProxyConfig;
  traceId: string;
}): Promise<Response | null> {
  let recoverable: ToolExecutionContext | null;
  try {
    recoverable = await findRecoverableNativeObservation(input);
  } catch {
    return nativeToolErrorResponse(
      503,
      "native_tool_observation_state_unavailable",
      "Native Tool observation state is unavailable",
    );
  }
  if (!recoverable?.observationOutcome) return null;
  const recoveryBytes = new Uint8Array(Buffer.from(
    recoverable.observationOutcome.bodyBase64,
    "base64",
  ));
  try {
    await flushDurableNativeToolObservation({
      storage: input.storage,
      stateKey: recoverable.key,
      bytes: recoveryBytes,
      leaseMs: input.leaseMs,
      config: input.config,
    });
  } catch (error) {
    const code = error instanceof ToolObservationOutboxError
      ? error.code
      : "native_tool_observation_failed";
    return nativeToolErrorResponse(
      503,
      code,
      "Native Tool logical-turn writeback is pending and must be retried",
    );
  }
  const recoveryHeaders = new Headers(recoverable.observationOutcome.headers);
  const recoveryPipe = createPipeline(
    input.config,
    input.traceId,
    recoverable.upstreamSnapshot.target.model,
  );
  const recoveryIsSse = recoveryHeaders.get("content-type")
    ?.toLowerCase().includes("text/event-stream");
  const recoveryOutput = recoveryIsSse
    ? streamFromBytes(recoveryBytes).pipeThrough(createSseThinkingFixStream(recoveryPipe))
    : streamFromBytes(recoveryBytes);
  return new Response(recoveryOutput, {
    status: recoverable.observationOutcome.status,
    headers: recoveryHeaders,
  });
}

/**
 * Normalize Anthropic top-level `system` field into a plain string for
 * observability. Anthropic accepts either a string or an array of content
 * blocks; here we join `text` blocks' text with "\n" and JSON-stringify
 * anything else. Returns "" when nothing textual is present.
 */
function stringifyAnthropicSystem(system: unknown): string {
  if (system === undefined || system === null) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    const parts: string[] = [];
    for (const block of system) {
      const b = block as Record<string, unknown>;
      if (b && b.type === "text" && typeof b.text === "string" && b.text) {
        parts.push(b.text);
      }
    }
    return parts.join("\n");
  }
  return JSON.stringify(system);
}

/**
 * Build the `input` payload for Langfuse / Opik. Two modes:
 *
 * - Normal mode (default): calls `flattenAnthropicMessagesForOpik` — content
 *   arrays are stringified for compact display. Loses `cache_control` markers,
 *   `thinking` blocks with signatures, native `tool_use`/`tool_result` shape.
 *
 * - Debug mode (`langfuse.debug=true`): reports the three model-input fields as
 *   `{system, messages, tools}`, preserving every native structure. Use when
 *   investigating cache markers, thinking-signature issues, injected tool
 *   schemas, or request classification. Costs 2-5x more upload bandwidth +
 *   Langfuse storage — leave off in production.
 */
export function buildLangfuseInput(
  messages: unknown[],
  system: unknown,
  debug: boolean,
  tools?: unknown,
): unknown {
  if (debug) {
    // Preserve the actual post-injection Anthropic request fields. Do not
    // normalize or clone here: the tracing SDK serializes the value, while the
    // upstream body keeps the exact same references and bytes as before.
    return { system, messages, tools: Array.isArray(tools) ? tools : [] };
  }
  return flattenAnthropicMessagesForOpik(messages, system);
}

/**
 * Flatten Anthropic messages for Opik / Langfuse display.
 *
 * Anthropic puts the system prompt on `body.system` (not inside `messages`),
 * so callers should pass it explicitly — otherwise the reported input omits
 * the system prompt entirely. When provided and non-empty, a synthetic
 * `{role:"system", content}` message is prepended to the result.
 */
export function flattenAnthropicMessagesForOpik(
  messages: unknown[],
  system?: unknown,
): unknown[] {
  const result: unknown[] = [];
  const systemText = stringifyAnthropicSystem(system);
  if (systemText) {
    result.push({ role: "system", content: systemText });
  }
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = m.role as string;
    const content = m.content;

    if (typeof content === "string") {
      result.push({ role, content });
      continue;
    }

    if (!Array.isArray(content)) {
      result.push({ role, content: JSON.stringify(content) });
      continue;
    }

    if (role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          textParts.push(b.text as string);
        } else if (b.type === "tool_use") {
          toolCalls.push(b);
        } else if (b.type === "thinking" && b.thinking) {
          textParts.push(`[thinking] ${(b.thinking as string).slice(0, 200)}`);
        }
      }
      if (textParts.length > 0) {
        result.push({ role: "assistant", content: textParts.join("\n") });
      }
      for (const tc of toolCalls) {
        const t = tc as Record<string, unknown>;
        const inputStr = typeof t.input === "string" ? t.input : JSON.stringify(t.input);
        result.push({
          role: "assistant",
          content: JSON.stringify({ tool_call_id: t.id, tool_name: t.name, input: inputStr }, null, 2),
        });
      }
    } else if (role === "user") {
      const textParts: string[] = [];
      const toolResults: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          textParts.push(b.text as string);
        } else if (b.type === "tool_result") {
          toolResults.push(b);
        } else {
          textParts.push(JSON.stringify(b));
        }
      }
      if (textParts.length > 0) {
        result.push({ role: "user", content: textParts.join("\n") });
      }
      for (const tr of toolResults) {
        const t = tr as Record<string, unknown>;
        let resultContent: string;
        if (typeof t.content === "string") {
          resultContent = t.content;
        } else if (Array.isArray(t.content)) {
          resultContent = (t.content as Record<string, unknown>[])
            .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
            .join("\n");
        } else {
          resultContent = JSON.stringify(t.content);
        }
        result.push({
          role: "tool",
          content: JSON.stringify({ tool_call_id: t.tool_use_id, is_error: t.is_error ?? false, result: resultContent }, null, 2),
        });
      }
    } else {
      const merged = content.map((b: unknown) => {
        const block = b as Record<string, unknown>;
        if (block.type === "text") return block.text as string;
        return JSON.stringify(block);
      }).join("\n");
      result.push({ role, content: merged });
    }
  }
  return result;
}

/** Extract Anthropic API key from request headers (x-api-key or Authorization Bearer). */
function extractApiKey(c: Context): string {
  const xApiKey = c.req.header("x-api-key");
  if (xApiKey) return xApiKey;

  const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return "";
}

/**
 * Preserve provider-owned `thinking` blocks across all assistant messages.
 *
 * Kept as a compatibility wrapper for existing callers. A transparent proxy
 * cannot infer the signature format used by every Anthropic-compatible
 * provider, so validation and rejection belong to the selected upstream.
 */
export function sanitizeThinkingBlocks(
  body: Record<string, unknown>,
): { body: Record<string, unknown>; removed: number } {
  return { body, removed: 0 };
}

function stripSessionInitArtifactsFromBody(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  const stripped = stripSessionInitArtifacts(body.messages as Record<string, unknown>[]);
  if (stripped.removed === 0) return body;
  return { ...body, messages: stripped.messages };
}

/**
 * Build upstream body from original body + cost guard overrides.
 */
export function buildUpstreamBody(
  body: Record<string, unknown>,
  target: ForwardTarget,
): { body: Record<string, unknown>; sanitizedCount: number } {
  let result = body;
  if (target.bodyOverrides) {
    result = { ...result, ...target.bodyOverrides };
  }
  const sanitized = sanitizeThinkingBlocks(result);
  return {
    body: stripSessionInitArtifactsFromBody(sanitized.body),
    sanitizedCount: sanitized.removed,
  };
}

export function buildRetryBody(body: Record<string, unknown>): Record<string, unknown> {
  return stripSessionInitArtifactsFromBody(sanitizeThinkingBlocks(body).body);
}

/**
 * Build upstream headers from request headers + cost guard auth overrides.
 */
function buildUpstreamHeaders(
  c: Context,
  _config: ProxyConfig,
  target: ForwardTarget,
  sessionKey?: string,
  effectiveApiKey?: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      headers[k] = v;
    }
  }
  headers["content-type"] = "application/json";

  // `effectiveApiKey` is pre-resolved by the caller according to the
  // per-agent fallback rule (see the resolveEffectiveApiKey call site).
  //   - non-empty string → inject as server-side key, drop client's own
  //   - empty/undefined  → passthrough: keep whatever the client sent
  // The cost-guard extension can still fully override via target.authHeaders.
  if (effectiveApiKey && !target.authHeaders) {
    headers["x-api-key"] = effectiveApiKey;
    delete headers["authorization"];
  }

  if (target.authHeaders) {
    for (const [k, v] of Object.entries(target.authHeaders)) {
      headers[k] = v;
      if (k === "x-api-key") delete headers["authorization"];
      if (k === "authorization") delete headers["x-api-key"];
    }
  }

  if (sessionKey) {
    headers["x-vertex-ai-session-id"] = sessionKey;
  }
  return headers;
}

/** Adapt Anthropic client authentication/SDK headers to a Responses upstream. */
function buildResponsesUpstreamHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      lower === "anthropic-version"
      || lower === "anthropic-beta"
      || lower.startsWith("x-stainless-")
    ) continue;
    result[lower] = value;
  }
  const apiKey = result["x-api-key"];
  if (apiKey) result.authorization = `Bearer ${apiKey}`;
  delete result["x-api-key"];
  return result;
}

/**
 * Forward request to upstream and handle retry if retryTarget is set.
 */
async function forwardWithRetry(
  target: ForwardTarget,
  upstreamHeaders: Record<string, string>,
  upstreamBody: Record<string, unknown>,
  originalBody: Record<string, unknown>,
  originalHeaders: Record<string, string>,
  pipe: ReturnType<typeof createPipeline>,
  forwardTimeoutMs: number,
  sessionKeyForDebug?: string,
  rateLimitContext?: { config: ProxyConfig; instanceId?: string },
): Promise<{ resp: Response; retried: boolean }> {
  let upstreamResp: Response | undefined;
  let forwardFailed = false;

  // ── Optional outbound body md5 debug log ───────────────────────────────
  // 用于长稳观测：Anthropic KV cache 命中的必要条件是"从 body 头 → cache_control
  // anchor 之前所有 bytes 完全一致"。所以要分开算三段 md5：
  //   1. sysFullMd5    — md5(JSON.stringify(body.system))  全 system 序列化
  //   2. sysStrMd5     — md5(body.system 拉平成字符串)    仅文本内容（对比用）
  //   3. msgsPrefixMd5 — 找到 messages 里最后一个带 cache_control 的位置 N，
  //                      md5(JSON.stringify(messages[0..N]))，即真正的 cache 前缀
  //   4. msgsAnchorIdx — 上面那个 N（帮助定位命中长度）
  //
  // 任何一个 md5 变了都意味着 Anthropic 会 cache miss。
  //
  // 开启：PROXY_DEBUG_DUMP_OUTBOUND_MD5=1 node ...
  if (process.env.PROXY_DEBUG_DUMP_OUTBOUND_MD5) {
    try {
      const sys = (upstreamBody as { system?: unknown }).system;
      // Anthropic system 通常是字符串（CC）或 blocks 数组（少数 SDK）
      const sysFullStr = sys === undefined ? "" : JSON.stringify(sys);
      const sysTextStr = typeof sys === "string"
        ? sys
        : Array.isArray(sys)
          ? sys.map((b) => (b as { text?: string }).text ?? "").join("\n")
          : "";

      const msgs = (upstreamBody as { messages?: Array<Record<string, unknown>> }).messages ?? [];
      // 找 messages 里最后一个"内容里带 cache_control"的位置
      let anchorIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const content = msgs[i]?.content;
        if (Array.isArray(content)) {
          const hasCache = content.some((b) => b && typeof b === "object" && "cache_control" in (b as object));
          if (hasCache) { anchorIdx = i; break; }
        }
      }
      // cache 前缀 = 从 body 头 → anchor（含）之前所有 messages 序列化后
      const prefixEnd = anchorIdx >= 0 ? anchorIdx + 1 : msgs.length;
      const msgsPrefixStr = JSON.stringify(msgs.slice(0, prefixEnd));

      const sysFullMd5 = createHash("md5").update(sysFullStr).digest("hex").slice(0, 12);
      const sysTextMd5 = createHash("md5").update(sysTextStr).digest("hex").slice(0, 12);
      const msgsPrefixMd5 = createHash("md5").update(msgsPrefixStr).digest("hex").slice(0, 12);

      // eslint-disable-next-line no-console
      console.log(
        `[outbound-md5] session=${sessionKeyForDebug ?? "?"} sysBytes=${sysFullStr.length} sysFullMd5=${sysFullMd5} sysTextMd5=${sysTextMd5} msgsCount=${msgs.length} msgsAnchorIdx=${anchorIdx} msgsPrefixBytes=${msgsPrefixStr.length} msgsPrefixMd5=${msgsPrefixMd5}`,
      );
    } catch (e) {
      // best-effort；不应因 debug 崩流程
      // eslint-disable-next-line no-console
      console.log(`[outbound-md5] session=${sessionKeyForDebug ?? "?"} <error: ${(e as Error).message}>`);
    }
  }

  if (rateLimitContext) {
    await enforceRateLimit({
      config: rateLimitContext.config,
      instanceId: rateLimitContext.instanceId,
      modelId: target.model,
      protocol: "anthropic",
    });
  }
  try {
    upstreamResp = await fetch(target.url, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(forwardTimeoutMs),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      pipe.error("FORWARD", `Timeout after ${forwardTimeoutMs / 1000}s`);
    } else {
      pipe.error("FORWARD", err);
    }
    forwardFailed = true;
  }

  if (upstreamResp) {
    pipe.forwardDone(upstreamResp.status);
  }

  const shouldRetry = target.retryTarget &&
    (forwardFailed || (upstreamResp && upstreamResp.status >= 400 && upstreamResp.status < 500));

  if (shouldRetry && target.retryTarget) {
    const reason = forwardFailed ? "timeout/error" : `${upstreamResp!.status}`;
    pipe.info("RETRY", `Routed model failed (${reason}), retrying with ${target.retryTarget.model}`);

    const retryHeaders: Record<string, string> = { ...originalHeaders };
    retryHeaders["content-type"] = "application/json";
    if (sessionKeyForDebug) {
      retryHeaders["x-vertex-ai-session-id"] = sessionKeyForDebug;
    }

    try {
      if (rateLimitContext) {
        await enforceRateLimit({
          config: rateLimitContext.config,
          instanceId: rateLimitContext.instanceId,
          modelId: target.retryTarget.model,
          protocol: "anthropic",
        });
      }
      upstreamResp = await fetch(target.retryTarget.url, {
        method: "POST",
        headers: retryHeaders,
        body: JSON.stringify(originalBody),
        signal: AbortSignal.timeout(forwardTimeoutMs),
      });
      if (upstreamResp.ok) {
        pipe.info("RETRY_SUCCESS", `Retry returned ${upstreamResp.status}`);
      } else {
        pipe.error("RETRY_FAILED", `Retry returned ${upstreamResp.status}`);
      }
      return { resp: upstreamResp, retried: true };
    } catch (retryErr: unknown) {
      if (isRateLimitExceededError(retryErr)) throw retryErr;
      if (retryErr instanceof DOMException && retryErr.name === "TimeoutError") {
        pipe.error("RETRY_FORWARD", `Timeout after ${forwardTimeoutMs / 1000}s`);
      } else {
        pipe.error("RETRY_FORWARD", retryErr);
      }
      throw new Error("Upstream request failed");
    }
  }

  if (forwardFailed && !shouldRetry) {
    throw new Error("Upstream request failed");
  }

  if (!upstreamResp) {
    throw new Error("No upstream response available");
  }

  return { resp: upstreamResp, retried: false };
}

/** Main handler for POST /v1/messages (Anthropic Messages API). */
export async function handleAnthropicMessages(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const startTime = new Date().toISOString();
  const traceId = uuidv7();

  // ── Early auth ──────────────────────────────────────────────────────────
  // Verify BEFORE parsing the body so a rejected caller never triggers body
  // parsing or the alias-gate. `earlyVerify.userId` is reused later for
  // both the systemUser short-circuit and the normal pipeline.
  const earlyApiKey = extractApiKey(c);
  const earlySpaceId = extractSpaceIdFromPath(c.req.path) ?? "";
  const earlyVerify = await verifyUserKey(earlyApiKey, earlySpaceId);
  if (earlyVerify.rejected) {
    return c.json({ type: "error", error: { type: "authentication_error", message: `Authentication failed: ${earlyVerify.rejectReason ?? "unknown"}` } }, 401);
  }

  // ── Parse body ──────────────────────────────────────────────────────────
  // Body is parsed BEFORE the systemUser short-circuit so the alias-gate and
  // `resolveModelId` fire uniformly for internal AND external callers. The
  // parsed object is later handed to `handleSystemUserPassthrough` (which
  // serialises it) so we never double-read `c.req`.
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Hook 标记只用于定位真实用户 Turn。业务链路和上游模型都不应看到它。
  const nativeMarkerMessages = config.nativeProxyTools.enabled && Array.isArray(body.messages)
    ? structuredClone(body.messages) as JsonValue[]
    : undefined;
  if (nativeMarkerMessages) {
    body = { ...body, messages: extractClaudeTurnMarkers(nativeMarkerMessages).messages };
  }

  // ── CC request classification (feature-gated, per-agent) ─────────────────
  // 通过 agentAdapter 分类请求 —— 每个客户端有自己的规则：
  //   - claude-code: 按 cache_control marker + tools/thinking 三分
  //   - codebuddy / unknown: 恒 main（未适配，等价现状）
  //
  // 关闭 ccRequestRouting.enabled 时强制视为 main，走完全等价现状的老链路。
  // 详见 docs/design/2026-07-30-cc-request-routing-plan.md
  const _pathPartsEarly = c.req.path.split("/").filter(Boolean);
  const _agentFromPathEarly = _pathPartsEarly[0]
    && !["v1", "proxy", "skill-bridge", "memory-bridge"].includes(_pathPartsEarly[0])
    ? _pathPartsEarly[0] : undefined;
  const agentAdapter = resolveAgentAdapter(_agentFromPathEarly ?? "claude-code");
  const ccRoutingEnabled = config.ccRequestRouting?.enabled === true;
  // WebSearch 的 Provider Tool 请求由 Claude Code 在客户端工具内部另发，
  // 即使整套 CC 请求分流未启用，它也不能被当成真实用户 Turn 处理。
  const isWebSearchSidequery = agentAdapter.agentKind === "claude-code"
    && isClaudeCodeWebSearchSidequery(body);
  const classifiedRequestKind = isWebSearchSidequery
    ? "sidequery"
    : ccRoutingEnabled ? agentAdapter.classifyRequest(body) : "main";
  const requestKind: CcRequestKind = classifiedRequestKind === "auxiliary"
    ? "sidequery"
    : classifiedRequestKind;

  // ── Model gate: reject requests whose `model` is not a registered display name ──
  // 价目表已配置时，客户端 `model` 必须匹配某条 entry 的 `modelName`（展示名，
  // 大小写不敏感）。真实 model_id 是内部细节，不作为客户端入口。未匹配则直接
  // 400，避免请求转发成功却因无定价而漏计费。价目表为空时跳过（向后兼容）。
  //
  // 内部/外部用户一视同仁 —— internal callers must also request by
  // `modelName`, ensuring upstream ids and billing/observability keys align
  // across all traffic.
  const requestedModel = typeof body.model === "string" ? body.model : "unknown";
  if (!isModelInPricing(config.creditPricing, requestedModel)) {
    return c.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `Model '${requestedModel}' is not a registered display name in the credit pricing table`,
        },
      },
      400,
    );
  }

  // ── Model alias: rewrite client-facing modelName → real model_id ──────────
  // Clients may put a human-readable name (e.g. "claude-opus-4.7") in `model`;
  // resolve it back to the real upstream model_id (e.g. "ep-pksklwtb") BEFORE
  // routing / logging / forwarding, so model_id stays the canonical identity
  // across the whole pipeline. No-op when `model` is already a real id/unknown.
  const modelId = resolveModelId(config.creditPricing, requestedModel);
  const modelAliasApplied = typeof body.model === "string" && modelId !== requestedModel;
  if (modelAliasApplied) body.model = modelId;

  const isStream = body.stream === true;
  const historyRuntime = config.nativeProxyTools.enabled
    ? getNativeProxyToolRuntime(config)
    : null;
  const nativeToolRuntime = isStream ? historyRuntime : null;
  // Capture the client-visible logical request before session/injection
  // mutations. This digest is the restart-replay key and must not depend on
  // mutable recovered session metadata.
  const nativeLogicalRequestFingerprint = historyRuntime
    ? fingerprintAnthropicLogicalRequest(body)
    : undefined;
  const nativeLogicalBaseMessages = historyRuntime && Array.isArray(body.messages)
    ? structuredClone(body.messages)
    : undefined;
  const reservedClientTool = Array.isArray(body.tools)
    ? body.tools.find((tool) => (
        tool !== null
        && typeof tool === "object"
        && typeof (tool as Record<string, unknown>).name === "string"
        && historyRuntime?.registry.owns((tool as Record<string, unknown>).name as string)
      )) as Record<string, unknown> | undefined
    : undefined;
  if (reservedClientTool) {
    return nativeToolErrorResponse(
      400,
      "reserved_native_proxy_tool_name",
      `Tool name '${String(reservedClientTool.name)}' is reserved by the proxy`,
    );
  }

  // ── System-user short-circuit ────────────────────────────────────────────
  // Internal service accounts (see `systemUsers` config) bypass the entire
  // pipeline: no session-init, no injection, no routing. Matching key is
  // the userId resolved by verifyUserKey — NOT the raw apiKey. Auth-disabled
  // requests (userId == "") never match, so the short-circuit is inert unless
  // auth is on.
  //
  // We hand the already-parsed+alias-resolved `body` to the passthrough so
  // upstream sees the canonical model_id, aligning internal traffic with
  // external.
  if (hasSystemUsers()) {
    const sysMatch = matchSystemUserByUserId(earlyVerify.userId);
    if (sysMatch) {
      return handleSystemUserPassthrough(c, config, sysMatch, body);
    }
  }

  let messages = Array.isArray(body.messages) ? body.messages : [];
  let hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  let nativeToolDefinitionInjected = false;
  if (historyRuntime) {
    try {
      await historyRuntime.ready();
    } catch {
      return nativeToolErrorResponse(
        503,
        "native_tool_state_unavailable",
        "Native Proxy Tool state storage is unavailable",
      );
    }
  }

  // ── Resolve agent source from URL path (e.g. /claude-code/v1/messages) ──
  const pathParts = c.req.path.split("/").filter(Boolean);
  const agentFromPath = pathParts[0] && !["v1", "proxy", "skill-bridge", "memory-bridge"].includes(pathParts[0])
    ? pathParts[0] : undefined;
  const agentSource = agentFromPath ?? "claude-code";
  const configuredUpstreamProtocol = config.upstream.agents?.[agentSource]?.protocol ?? "native";
  const usesResponsesUpstream = configuredUpstreamProtocol === "responses";

  // ── Identity inspection ──────────────────────────────────────────────────
  const reqHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    reqHeaders[k] = v;
  }
  inspectAndRecord("POST", c.req.path, reqHeaders, body as Record<string, unknown>, agentSource);

  // ── Resolve apiKey → project name ──────────────────────────────────────
  const apiKey = extractApiKey(c);
  let keyId = apiKey ? apiKeyToKeyId(apiKey) : "unknown";

  // ── Lowercased headers for agent profile detection + session key ──────────
  const lcHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    lcHeaders[k.toLowerCase()] = v;
  }

// ── Session key: prefer conversation header, fallback to agent profile ───────────
  const { resolveConversationId } = await import("./session/session-key.js");
  const conversationId = resolveConversationId(c);
  const sessionKey = conversationId ?? resolveSessionKey(config, lcHeaders, c.req.path, body, keyId);

  // ── Auth verification (user_key → user_id) ──────────────────────────────────────
  // Reuse the early verify result — it ran before body parse to decide the
  // system-user short-circuit; running verify again here would double the
  // network round-trip for every request.
  const spaceId = earlySpaceId;
  const userId = earlyVerify.userId
    || c.req.header("x-user-id")
    || c.req.header("x-cb-user-id")
    || c.req.header("x-tdai-user-token")
    || "";
  if (userId) keyId = userId;

  // sk-mem key（用于 TDAI ACL / MetadataClient 的 x-tdai-user-key）就是入口的 apiKey。
  const callerUserKey = apiKey || null;

  // Restart replay must run before session-init. If the session store is
  // temporarily missing or has changed, the original persisted observation
  // identity still owns writeback and the retry must not fall into a new form.
  const earlyNativeStorage = nativeToolRuntime?.storage;
  if (earlyNativeStorage && nativeLogicalRequestFingerprint) {
    const earlyObservationScope = nativeToolScope({
      spaceId,
      userId,
      agentSource,
      sessionKey,
      sessionInfo: undefined,
      config,
    });
    const recoveredResponse = await nativeToolRuntime.runOperation(() => (
      replayRecoverableNativeObservation({
        storage: earlyNativeStorage,
        scope: earlyObservationScope,
        requestFingerprint: nativeLogicalRequestFingerprint,
        leaseMs: nativeReentryLeaseWindowMs(config),
        config,
        traceId,
      })
    ));
    if (recoveredResponse) return recoveredResponse;
  }

  // Activate Redis storage early — must run BEFORE session init.
  if (config.redis?.enabled) {
    const { getInjectionPipeline } = await import("./injection/index.js");
    getInjectionPipeline(config);
  }

  // ── Session Init (before injection pipeline) ─────────────────────────────
  let sessionInfo: Record<string, unknown> | null | undefined;
  let assetCapabilities: import("./injection/types.js").AssetCapabilityFlags | undefined;
  let injectedSkipped = !conversationId;
  let sessionJustRegistered = false;
  console.log(`[injection-debug] conversationId=${conversationId} sessionKey=${sessionKey} userId=${userId} agentSource=${agentSource} sessionInitEnabled=${config.sessionInit?.enabled} injectionEnabled=${config.injection?.enabled} injectors=${JSON.stringify(config.injection?.injectors)} injectedSkipped=${injectedSkipped}`);
  // CC 分流：SIDEQUERY 完全跳过 session-init（独立小请求无对话概念）。
  //          FORK 允许走 L2b recovery 复用 MAIN 已建的 session，但不进 form 交互路径
  //          （借用 MAIN 的 sessionInfo，见下方的 kind === 'fork' 分支保护）。
  const skipSessionInit = requestKind === "sidequery";
  if (config.sessionInit?.enabled && conversationId && !skipSessionInit) {
    try {
      const { getSessionStore, handleSessionInit, parsePresetIdentity } = await import("./session/index.js");
      const { getMetadataClient } = await import("./meta/client.js");
      const store = getSessionStore();
      const metadataClient = getMetadataClient(config.coreSkill, spaceId, apiKey);
      const presetIdentity = parsePresetIdentity(config.sessionInit, lcHeaders);

      // ── Session Recovery: try L2b binding before falling into session-init form ──
      const compositeKey = `${agentSource}:${sessionKey}`;
      // Identity for repo/binding writes. userId 缺失时 fallback 到 `anonymous`
      // 复合键，保证 key path 分段合法（参见 §4.4 边界处理）。
      const identity = {
        userId: userId || "anonymous",
        agentSource,
        sessionId: sessionKey,
        spaceId,
      };
      const recovered = await store.getOrRecover(compositeKey, identity, {
        metadataClient,
        messages: body.messages as Array<Record<string, unknown>> ?? [],
      });

      let initResult: Awaited<ReturnType<typeof handleSessionInit>>;
      // Only treat the session as "recovered" when it's in a terminal state
      // (initialized or bypassed). Pending / mid-form states MUST fall through
      // to handleSessionInit so the state machine can advance to the next form.
      const isTerminalState = recovered?.status === "initialized";
      // 记录本 turn 是否真的走了 handleSessionInit state machine —— 用来精确判定
      // `sessionJustRegistered` 语义（"session init 状态机在本 turn 完成终态转换"）。
      // 覆盖两种终态：
      //   - 正常注册完成（justRegistered=true 由 completeRegistration 设置）
      //   - bypass（用户选"否"、maxRetries、no-agent 等分支，也带 justRegistered=true）
      // 这样 turn N 用户答 asset-confirm 时 mem-command 拦截块能通过 checkFirst
      // 兜底扒 first user message，把最开始那条 mem: 命令识别出来（此时 sessionInfo=null
      // → 走"未初始化"分支），而不是让它落到 LLM 透传里被幻觉回答。
      // 保护措施：Case 3 (state 已经稳定 initialized+bypassed) 的常规返回**不带**
      // justRegistered，所以后续 turn 不会重复扒第一条历史；L2b recovery 分支借用
      // justRegistered=true 只是为了触发下游 prewarm，与状态机无关，那里
      // wentThroughSessionInitStateMachine=false 会自然过滤掉。
      let wentThroughSessionInitStateMachine = false;
      if (recovered && isTerminalState) {
        // Recovery hit: keep original messages, only re-inject <session_context>
        // so this turn's system prompt carries agent/task context again.
        // 用户对话永远保留原样，包括 session_init form 交互 — 不做任何删除。
        // Anthropic protocol: system lives on body.system (not in messages),
        // so we hand systemAppend back through the initResult and let the
        // shared apply-block below merge it into body.system.
        const { buildSessionContextBlockWithToggles } = await import("./session/context-injector.js");
        const inMsgs = (body.messages as Array<Record<string, unknown>>) ?? [];
        const systemAppend = recovered.bypassed
          ? null
          : buildSessionContextBlockWithToggles(
              recovered.agentDetail ?? null,
              recovered.taskDetail ?? null,
              config.sessionInit,
              sessionKey,
            );
        initResult = {
          intercepted: false,
          messages: inMsgs as Record<string, unknown>[],
          systemAppend,
          sessionInfo: recovered.sessionInfo,
          agentDetail: recovered.agentDetail,
          taskDetail: recovered.taskDetail,
          bypassed: recovered.bypassed,
          justRegistered: true, // triggers prewarm to refill hook cache
        };
      } else if (requestKind === "fork") {
        // FORK 借用 MAIN 已建的 session。L2b 未命中说明 MAIN 尚未完成 init —— 罕见情况，
        // 保守起见让 fork 请求走 no-op（不 intercept、不改 messages），让上游收到原样请求。
        // 这样最坏结果 = MAIN 那次拿不到 sessionInfo（等效关掉 session-init），不会更糟。
        console.log(`[session-init:cc:fork] session=${compositeKey} L2b miss on fork request → passthrough`);
        initResult = { intercepted: false, messages: body.messages as Record<string, unknown>[] };
      } else {
        wentThroughSessionInitStateMachine = true;
        initResult = await handleSessionInit(
          sessionKey,
          userId || null,
          body.messages as Array<Record<string, unknown>> ?? [],
          config.sessionInit,
          store,
          { stream: isStream, modelId: modelId as string, protocol: "anthropic" },
          agentSource,
          metadataClient,
          apiKey,
          spaceId,
          presetIdentity,
        );
      }

      if (initResult.intercepted && initResult.response) {
        return initResult.response;
      }

      console.log(`[injection-debug] initResult session=${sessionKey} intercepted=${initResult.intercepted} bypassed=${initResult.bypassed} justRegistered=${initResult.justRegistered} hasSessionInfo=${!!initResult.sessionInfo} hasAgentDetail=${!!initResult.agentDetail}`);
      // sessionJustRegistered 用于 mem-command 的 checkFirst fallback（session init 最后
      // 一步"pending_task_select → initialized"那一 turn，把用户最开始的 mem: 命令补执行）。
      // **关键**：只在真正走 handleSessionInit state machine 的分支才继承 justRegistered；
      // L2b recovery 分支的 justRegistered=true 只是下游 prewarm 的重建信号，不是 session
      // init 过程，此时不设 sessionJustRegistered——否则 mem-command 会永久扒对话历史
      // 第一条 user，把用户最开始的 mem:help 当"未消化的命令"每 turn 重复执行。
      if (wentThroughSessionInitStateMachine && initResult.justRegistered) sessionJustRegistered = true;
      if (initResult.bypassed) {
        injectedSkipped = true;
        console.log(`[session-init] session=${sessionKey} bypassed → skipping all injection`);
      }

      if (!initResult.bypassed && initResult.sessionInfo) {
        try {
          const { fetchAssetCapabilities } = await import("./tdai/capabilities.js");
          assetCapabilities = await fetchAssetCapabilities({
            endpoint: config.tdai.endpoint,
            apiKey: config.tdai.apiKey,
            serviceId: config.tdai.serviceId,
            serviceIdOverride: spaceId,
            userId: (initResult.sessionInfo as { user_id?: string }).user_id,
            userKey: callerUserKey,
            timeoutMs: config.tdai.memory.timeoutMs,
          });
          console.log(`[asset-capability] user=${(initResult.sessionInfo as { user_id?: string }).user_id ?? "-"} flags=${JSON.stringify(assetCapabilities)}`);
        } catch (err) {
          console.warn(`[asset-capability] resolve failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Await prewarm so the first-turn pipeline always hits the cache.
      // A fire-and-forget void() here caused the bug where the pipeline
      // ran before the cache was populated, silently injecting zero
      // blocks for the entire first turn.
      if (
        !initResult.bypassed &&
        initResult.justRegistered &&
        initResult.sessionInfo &&
        ((config.injection?.enabled && (config.injection.injectors?.length ?? 0) > 0)
          || (config.nativeProxyTools.enabled
            && config.knowledge.enabled
            && config.knowledge.serviceToken.length > 0))
      ) {
        try {
          const mod = await import("./injection/index.js");
          await mod.prewarmFromConfig(config, {
            keyId: sessionKey,
            userId: userId || "anonymous",
            agentSource,
            sessionInfo: initResult.sessionInfo as import("./session/types.js").SessionInfo,
            agentDetail: initResult.agentDetail ?? null,
            taskDetail: initResult.taskDetail ?? null,
            assetCapabilities,
            // 透传 caller 的 sk-mem key，用于 prewarm 阶段 TDAI ACL 校验（x-tdai-user-key）
            callerUserKey: callerUserKey ?? undefined,
          });
        } catch (err) {
          console.warn(
            "[hook-cache] handler prewarm error (anthropic):",
            err instanceof Error ? err.message : String(err),
          );
          // Don't re-throw: the pipeline's resolveHookBlocks has its own
          // cache-miss → execute() fallback as a safety net (see pipeline.ts).
        }
      }

      if (initResult.messages) {
        body = { ...body, messages: initResult.messages };
        messages = initResult.messages as unknown[];
      }

      // Anthropic: apply the session-context block onto body.system. The init
      // module cannot see body.system (it's a handler-layer concern), so it
      // hands the pre-built block back through `systemAppend` and we merge it
      // here with the same append helper used by the direct-inject path.
      if (initResult.systemAppend) {
        const { appendBlockToAnthropicSystem } = await import("./session/context-injector.js");
        body = { ...body, system: appendBlockToAnthropicSystem(body.system, initResult.systemAppend) };
      }

      sessionInfo = initResult.sessionInfo as Record<string, unknown> | null | undefined;
      // Legacy sessions persisted before space_id was tracked will hydrate
      // with an empty space_id. Restore it from the URL each request so
      // downstream skill / knowledge / injection paths route to the correct
      // kernel tenant instead of falling back to `context-proxy` (500).
      if (sessionInfo && !sessionInfo.space_id && spaceId) {
        sessionInfo.space_id = spaceId;
      }
    } catch (err: unknown) {
      console.error("[session-init] Error in handleSessionInit (anthropic):", err instanceof Error ? err.message : String(err));
      sessionInfo = undefined;
      injectedSkipped = true;
    }
  }

  const toolExecutionScope = historyRuntime
    ? nativeToolScope({
        spaceId,
        userId,
        agentSource,
        sessionKey,
        sessionInfo,
        config,
      })
    : null;
  let hookTurnSeq: number | undefined;
  if (toolExecutionScope && historyRuntime?.ledgerStorage) {
    try {
      const sessionContext = await historyRuntime.ledgerStorage.getSessionContext(toolExecutionScope);
      toolExecutionScope.contextVersion = `epoch:${sessionContext.currentEpoch}`;
    } catch {
      return nativeToolErrorResponse(503, "native_tool_history_unavailable", "Native Proxy Tool history could not be read");
    }
  }

  // Client Tool Results for a persisted mixed batch resume before mem-command,
  // injection, request preparation, or routing. A known batch must re-enter
  // only its persisted successful target; an unrelated Client Tool loop falls
  // through to the ordinary request path.
  if (
    nativeToolRuntime?.storage
    && nativeToolRuntime.dispatcher
    && toolExecutionScope
  ) {
    const nativeStorage = nativeToolRuntime.storage;
    const nativeDispatcher = nativeToolRuntime.dispatcher;
    const restartReentry = createRestartExactTargetTransport({
      config,
      currentModel: modelId,
      agentSource,
      requestPath: usesResponsesUpstream ? "/responses" : "/messages",
      sessionId: sessionKey,
      currentRequestHeaders: reqHeaders,
      timeoutMs: config.server.forwardTimeoutMs ?? 600_000,
      beforeFetch: async (reentryModel) => {
        await enforceRateLimit({
          config,
          instanceId: spaceId || undefined,
          modelId: reentryModel,
          protocol: usesResponsesUpstream ? "openai" : "anthropic",
        });
      },
    });
    let selectedReentry: typeof restartReentry | undefined;
    const resumeExactReentry = (
      request: Parameters<typeof restartReentry>[0],
      stateKey: Parameters<typeof nativeToolRuntime.getRetainedExactTarget>[0],
    ) => {
      selectedReentry ??= nativeToolRuntime.getRetainedExactTarget(
        stateKey,
      ) ?? restartReentry;
      return selectedReentry(request);
    };
    const exactReentry: typeof restartReentry = (request) => (
      (selectedReentry ?? restartReentry)(request)
    );
    const reentryLeaseMs = nativeReentryLeaseWindowMs(config);

    // A pure-Native final response has no Client Tool Result request to drive
    // recovery. Locate its durable outbox by the immutable logical request
    // digest, flush it, and replay the exact persisted client-visible bytes.
    if (nativeLogicalRequestFingerprint) {
      const recoveredResponse = await nativeToolRuntime.runOperation(() => (
        replayRecoverableNativeObservation({
          storage: nativeStorage,
          scope: toolExecutionScope,
          requestFingerprint: nativeLogicalRequestFingerprint,
          leaseMs: reentryLeaseMs,
          config,
          traceId,
        })
      ));
      if (recoveredResponse) return recoveredResponse;
    }

    const resume = await nativeToolRuntime.runOperation(() => resumeClientToolResults({
      body,
      scope: toolExecutionScope,
      storage: nativeStorage,
      ledgerStorage: nativeToolRuntime.ledgerStorage ?? undefined,
      dispatcher: nativeDispatcher,
      limits: config.nativeProxyTools,
      reentryLeaseMs,
      reenter: resumeExactReentry,
    }));
    if (resume.kind === "error") {
      return nativeToolErrorResponse(resume.status, resume.code, resume.message);
    }
    if (resume.kind === "replay") {
      nativeToolRuntime.releaseExactTarget(resume.stateKey);
      if (isLogicalFinalToolLoopDecision(resume.outcomeKind)) {
        try {
          await nativeToolRuntime.runOperation(() => flushDurableNativeToolObservation({
            storage: nativeStorage,
            stateKey: resume.stateKey,
            bytes: resume.bytes,
            leaseMs: reentryLeaseMs,
            config,
          }));
        } catch (error) {
          const code = error instanceof ToolObservationOutboxError
            ? error.code
            : "native_tool_observation_failed";
          return nativeToolErrorResponse(
            503,
            code,
            "Native Tool logical-turn writeback is pending and must be retried",
          );
        }
      }
      const replayHeaders = new Headers(resume.headers);
      const replayPipe = createPipeline(config, traceId, modelId);
      const replayIsSse = replayHeaders.get("content-type")
        ?.toLowerCase().includes("text/event-stream");
      const replayOutput = replayIsSse
        ? streamFromBytes(resume.bytes).pipeThrough(createSseThinkingFixStream(replayPipe))
        : streamFromBytes(resume.bytes);
      return new Response(replayOutput, { status: resume.status, headers: replayHeaders });
    }
    if (resume.kind === "reentered") {
      const renewParentReentry = () => renewClientToolReentry(
        nativeStorage,
        resume.stateKey,
        resume.reentryLeaseOwner,
        reentryLeaseMs,
      );
      await nativeToolRuntime.runOperation(renewParentReentry);
      const resumePipe = createPipeline(config, traceId, resume.upstreamSnapshot.target.model);
      resumePipe.requestReceived(resume.messages.length, true);
      resumePipe.forwardStart();
      resumePipe.forwardDone(resume.upstreamRound.status);
      let parentContinuationCommitted = false;
      const coordinatorOptions = {
        registry: nativeToolRuntime.registry,
        storage: nativeStorage,
        ledgerStorage: nativeToolRuntime.ledgerStorage ?? undefined,
        dispatcher: nativeDispatcher,
        limits: config.nativeProxyTools,
        reenter: exactReentry,
        trackBackgroundOperation: (operation: () => Promise<void>) => nativeToolRuntime.trackBackgroundOperation(operation),
        beforeReenter: renewParentReentry,
        beforeClientDispatch: renewParentReentry,
        onClientDispatchPrepared: async (dispatch: {
          stateKey: ToolExecutionStateKey;
          bytes: Uint8Array;
          status: number;
          headers: Headers;
        }) => {
          await completeClientToolReentry(
            nativeStorage,
            resume.stateKey,
            resume.reentryLeaseOwner,
            createPersistedClientReentryOutcome({
              kind: "client_dispatch",
              status: dispatch.status,
              headers: dispatch.headers,
              bytes: dispatch.bytes,
              childStateKey: dispatch.stateKey,
            }),
          );
          parentContinuationCommitted = true;
        },
      };
      const resumedRoundInput = {
        ...resume.upstreamRound,
        scope: toolExecutionScope,
        turnSeq: resume.turnSeq,
        upstreamSnapshot: resume.upstreamSnapshot,
        round: resume.round,
        totalCalls: resume.totalCalls,
        parentStateKey: resume.stateKey,
        parentReentryAttempt: resume.reentryAttempt,
      };
      const decision: ToolLoopDecision | OpenAIToolLoopDecision = resume.upstreamSnapshot.protocol === "responses"
        ? await nativeToolRuntime.runOperation(() => new AnthropicClientResponsesToolLoopCoordinator({
            ...coordinatorOptions,
            model: resume.upstreamSnapshot.target.model,
          }).handleRound(resumedRoundInput))
        : await nativeToolRuntime.runOperation(() => new AnthropicToolLoopCoordinator(
            coordinatorOptions,
          ).handleRound(resumedRoundInput));
      if (parentContinuationCommitted && decision.kind !== "client_dispatch") {
        nativeToolRuntime.releaseExactTarget(resume.stateKey);
        return nativeToolErrorResponse(
          503,
          "native_tool_child_dispatch_incomplete",
          "Client Tool continuation was persisted and must be retried",
        );
      }
      if (decision.kind === "client_dispatch" && selectedReentry) {
        nativeToolRuntime.retainExactTarget(decision.stateKey, selectedReentry);
      }
      try {
        if (!parentContinuationCommitted) {
          await completeClientToolReentry(
            nativeStorage,
            resume.stateKey,
            resume.reentryLeaseOwner,
            createPersistedClientReentryOutcome({
              kind: decision.kind,
              status: decision.status,
              headers: decision.headers,
              bytes: decision.bytes,
              ...(decision.kind === "client_dispatch"
                ? { childStateKey: decision.stateKey }
                : {}),
            }),
          );
        }
      } catch (error) {
        if (decision.kind === "client_dispatch") {
          nativeToolRuntime.releaseExactTarget(decision.stateKey);
        }
        throw error;
      }
      nativeToolRuntime.releaseExactTarget(resume.stateKey);

      const resumeTags = [
        `agent_source:${agentSource}`,
        "protocol:anthropic",
        "stream",
        `session:${sessionKey}`,
        "native-tool-resume",
      ];
      const resumeObservationBody: Record<string, unknown> = {
        ...resume.upstreamSnapshot.requestParameters,
        messages: resume.logicalMessages,
        ...(resume.upstreamSnapshot.system !== undefined
          ? { system: resume.upstreamSnapshot.system }
          : {}),
      };
      const resumeLf: LangfuseTurnContext = {
        traceId: langfuseTurnTraceId(sessionKey, resume.turnSeq),
        turnSeq: resume.turnSeq,
        traceName: `${resume.upstreamSnapshot.target.model} / ${keyId}`,
        userId: keyId,
        sessionId: sessionKey,
        tags: resumeTags,
        routeTags: [],
        userQuery: resolveLatestUserQuery(
          config,
          lcHeaders,
          c.req.path,
          resumeObservationBody,
          resume.logicalMessages,
        ),
      };
      const resumeForkTraceId = opikCreateTrace(config, {
        traceId,
        projectName: keyId,
        name: resumeLf.traceName,
        startTime,
        input: {
          messages: flattenAnthropicMessagesForOpik(
            resume.logicalMessages,
            resume.upstreamSnapshot.system,
          ),
        },
        tags: resumeTags,
        forkProjectName: "request_log",
        forkMetadata: {
          keyId,
          modelId: resume.upstreamSnapshot.target.model,
          stream: true,
          upstreamUrl: resume.upstreamSnapshot.target.url,
          nativeToolResume: true,
        },
      });
      const resumeTdaiClient = assetCapabilities?.chat_memory === false
        ? null
        : createTdaiClient(config, spaceId);
      const resumeTdaiIdentity = deriveTdaiIdentity({
        sessionInfo,
        userId: userId || null,
        sessionKey,
        userKey: callerUserKey,
      });
      const resumeInputMessages = resume.logicalMessages;
      const resumeDebug = config.langfuse.debug === true;
      const resumeDebugMetadata = buildRequestDebugMetadata({
        debug: resumeDebug,
        body: resumeObservationBody,
        headers: reqHeaders,
        agentSource,
        requestKind,
        spaceId,
        turnSeq: resume.turnSeq,
        requestPath: c.req.path,
        protocol: "anthropic",
      });
      if (isLogicalFinalToolLoopDecision(decision.kind)) {
        try {
          await nativeToolRuntime.runOperation(() => flushDurableNativeToolObservation({
            storage: nativeStorage,
            stateKey: resume.stateKey,
            bytes: decision.bytes,
            leaseMs: reentryLeaseMs,
            config,
          }));
        } catch (error) {
          const code = error instanceof ToolObservationOutboxError
            ? error.code
            : "native_tool_observation_failed";
          return nativeToolErrorResponse(
            503,
            code,
            "Native Tool logical-turn writeback is pending and must be retried",
          );
        }
      }
      const resumeObservationContext: AnthropicTapContext = {
        config,
        modelId: resume.upstreamSnapshot.target.model,
        keyId,
        sessionKey,
        upstreamUrl: resume.upstreamSnapshot.target.url,
        requestPath: c.req.path,
        traceId,
        forkTraceId: resumeForkTraceId,
        startTime,
        inputMessages: resumeInputMessages,
        system: resume.upstreamSnapshot.system,
        tools: resume.upstreamSnapshot.tools,
        retried: false,
        logMeta: { nativeToolResume: true },
        routedFrom: "",
        pipe: resumePipe,
        sessionKeyForSkill: sessionKey,
        agentSource,
        sessionInfo,
        tdaiClient: resumeTdaiClient,
        tdaiIdentity: resumeTdaiIdentity,
        tdaiUserMessage: extractLatestUserMessage(resumeInputMessages),
        assetCapabilities,
        lf: resumeLf,
        spaceId,
        upstreamRequestId: decision.headers.get("x-request-id") ?? "",
        // Durable outbox above exclusively owns L0/Skill for resumed turns.
        requestKind: "fork",
        langfuseDebug: resumeDebug,
        debugMetadata: resumeDebugMetadata,
        preparedStats: null,
      };
      if (resume.upstreamSnapshot.protocol === "responses") {
        observeResponsesNativeToolDecision(decision as OpenAIToolLoopDecision, resumeObservationContext);
      } else {
        observeNativeToolDecision(decision as ToolLoopDecision, resumeObservationContext);
      }
      const decisionHeaders = new Headers(decision.headers);
      const isSse = decisionHeaders.get("content-type")?.toLowerCase().includes("text/event-stream");
      const output = isSse
        ? streamFromBytes(decision.bytes).pipeThrough(createSseThinkingFixStream(resumePipe))
        : streamFromBytes(decision.bytes);
      return new Response(output, { status: decision.status, headers: decisionHeaders });
    }
  }

  // ── mem: command intercept ────────────────────────────────────────────────
  // 在 session init 完成后、injection pipeline 之前检测。
  // 命中时：执行命令 → 写 L0 → 触发 skill extract → 伪造响应返回。
  // 跳过注入（不破坏 KV cache）和上游转发（零 token 消耗）。
  // 配置开关 memCommand.enabled 关闭时此段完全不执行，走原有链路。
  //
  // parseMemCommand 内部通过 agentAdapter.extractUserText 按客户端规则提取用户输入：
  //   - claude-code: 取最后一个 text block（跳过 <system-reminder> 前缀元数据）
  //   - codebuddy / unknown: 走保守的"拼接所有 text"逻辑
  //
  // CC 分流：FORK/SIDEQUERY 是 CC 客户端内部构造的请求，last_user 不会以 `mem:` 开头，
  //          且伪造响应会破坏 fork 请求依赖 MAIN 的 cache 假设。跳过拦截。
  if (config.memCommand?.enabled && requestKind === "main") {
    const { parseMemCommand, isMemCommandAllowed, executeMemCommand, buildMemResponse } = await import("./mem-command/index.js");
    // 常规检测：最后一条 user message
    let memCmd = parseMemCommand(body as Record<string, unknown>, agentSource);
    // session init 状态机在本 turn 完成终态（初始化 or bypass）时，最后一条
    // user message 是 init 交互回答（比如"否"），额外检查第一条 user message
    // —— 用户最初的原始意图。bypass 场景下 sessionInfo=null 会走"未初始化"
    // 分支返回文案，避免让首条 mem: 命令被吞进历史后落到 LLM 透传里。
    if (!memCmd && sessionJustRegistered) {
      memCmd = parseMemCommand(body as Record<string, unknown>, agentSource, { checkFirst: true });
    }
    if (memCmd && isMemCommandAllowed(config.memCommand, memCmd.command)) {
      // bypass 优化：会话未初始化时，命令不可用
      if (!sessionInfo || injectedSkipped) {
        const thinkingEnabled = !!(body as Record<string, unknown>).thinking;
        const errText = `⚠️ 会话未初始化，命令不可用。请先完成 session 初始化（选择 Team/Agent）后重试。`;
        const errResponse = buildMemResponse(errText, {
          protocol: "anthropic",
          stream: isStream,
          requestId: `mem-cmd-${Date.now()}`,
          thinking: thinkingEnabled,
        });
        console.log(`[mem-command] cmd=${memCmd.command} session=${sessionKey} blocked: session not initialized`);
        return errResponse;
      }
      // 检测请求是否开启了 extended thinking（Anthropic 协议）
      const thinkingEnabled = !!(body as Record<string, unknown>).thinking;
      const memResult = await executeMemCommand(memCmd, {
        sessionKey,
        agentSource,
        config,
        spaceId,
        userId,
        apiKey: apiKey || "",
        sessionInfo: sessionInfo as Record<string, unknown>,
        protocol: "anthropic",
        stream: isStream,
        args: memCmd.args,
        thinking: thinkingEnabled,
      });

      // Step 20: L0 写入 — 保证对话时间线完整。
      //   同步 await 保证 L0 落盘再返回，避免响应先返回后进程未 flush 就退出丢失。
      //   注意：只有 mem 命令时全网只有这一次落盘，跟主对话路径不同（那边有 SIGTERM
      //   trackWrite 兜底 + withL0Retry），这里必须显式等。
      const tdaiClientForMem = createTdaiClient(config, spaceId);
      const tdaiIdentityForMem = deriveTdaiIdentity({
        sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
        userId: userId || null,
        sessionKey,
        userKey: callerUserKey,
      });
      if (tdaiClientForMem && tdaiIdentityForMem && isExtractionAllowed(config, "tdai-memory")) {
        const userMsg = { role: "user" as const, content: memCmd.rawMessage };
        try {
          await recordTdaiTurn(tdaiClientForMem, tdaiIdentityForMem, userMsg, memResult.messageText);
        } catch (err: unknown) {
          console.error("[mem-command] L0 write error:", err);
        }
      }

      // Step 19: skill extract — 对话轮次计数正常累积
      //   Bug: 之前用 `config.extraction?.skill?.enabled` 访问路径错误
      //        (extraction 结构是 { enabled, extractors: [...] }, 没有 .skill),
      //        导致 mem 命令**从来**没写过 skill buffer。改用 isExtractionAllowed
      //        与主对话链路对齐。
      //   Bug: fire-and-forget 没 await 导致响应先返回、写入被中断。改成同步 await
      //        保证 buffer 落盘再返回响应。
      if (isExtractionAllowed(config, "skill")) {
        try {
          const assistantMsg = { role: "assistant", content: [{ type: "text", text: memResult.messageText }] };
          await triggerSkillExtractIfReady({
            config,
            sessionKey,
            agentSource,
            sessionInfo: sessionInfo as Record<string, unknown>,
            inputMessages: messages as unknown[],
            assistantMessage: assistantMsg,
            protocol: "anthropic",
            assetCapabilities,
          });
        } catch (err: unknown) {
          console.warn("[mem-command] skill extract trigger error:", err instanceof Error ? err.message : String(err));
        }
      }

      // Step 18: observability
      console.log(`[mem-command] cmd=${memCmd.command} session=${sessionKey} success=${memResult.success}`);

      // Step 17: Langfuse — 上报 mem-command 为一个 generation observation。
      //   mem 命令拦截在 Langfuse context 构造之前 (lf 在 L1088 才声明), 这里
      //   inline 计算 turnSeq → traceId, 保证该 turn 在 Langfuse 有完整 trace。
      const memTurnSeq = countHumanTurns(messages, "anthropic");
      const memTraceId = langfuseTurnTraceId(sessionKey, memTurnSeq);
      langfuseReportGeneration({
        traceId: memTraceId,
        name: "memory-proxy",
        model: "memory-proxy",
        startTime,
        endTime: new Date().toISOString(),
        input: memCmd.rawMessage,
        output: memResult.messageText,
        usage: { input_tokens: 0, output_tokens: 0 },
        traceName: `memory-proxy / ${keyId}`,
        userId: keyId,
        sessionId: sessionKey,
        tags: [
          `agent_source:${agentSource}`,
          "protocol:anthropic",
          isStream ? "stream" : "non-stream",
          `session:${sessionKey}`,
          "mem-command",
        ],
        traceInput: memCmd.rawMessage,
        traceOutput: memResult.messageText,
      });

      return memResult.response;
    }
  }

  const tdaiClient = assetCapabilities?.chat_memory === false ? null : createTdaiClient(config, spaceId);
  const tdaiIdentity = injectedSkipped
    ? null
    : deriveTdaiIdentity({
        sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
        userId: userId || null,
        sessionKey,
        userKey: callerUserKey,
      });
  const tdaiUserMessage = extractLatestUserMessage(messages);

  // ── Context injection (before cost guard) ────────────────────────────────
  // CC 分流：
  //   - SIDEQUERY: 完全跳过 injection（自带短 prompt，不共享 cache）
  //   - FORK: 走 pipeline 但 readOnly=true（miss 时不 self-heal 写 cache，避免破坏主对话 cache）
  //   - MAIN: 走完整 pipeline（含 self-heal）
  const skipInjection = requestKind === "sidequery";
  const legacyInjectionEnabled = config.injection?.enabled
    && config.injection.injectors.length > 0;
  const nativeToolInjectionEnabled = config.nativeProxyTools.enabled
    && isStream
    && requestKind === "main";
  if (!injectedSkipped && !skipInjection && (legacyInjectionEnabled || nativeToolInjectionEnabled)) {
    try {
      console.log(`[injection-debug] entering injection pipeline session=${sessionKey} turnSeq=${countHumanTurns(messages, "anthropic")} injectors=${config.injection.injectors} kind=${requestKind}`);
      const injectionTurnSeq = countHumanTurns(messages, "anthropic");
      const { getInjectionPipeline } = await import("./injection/index.js");
      const pipeline = getInjectionPipeline(config);
      const injectedBody = await pipeline.process(body, {
        protocol: "anthropic",
        traceId,
        keyId,
        modelId: modelId as string,
        stream: isStream,
        agentSource,
        userId: userId || "anonymous",
        spaceId,
        sessionKey,
        turnSeq: injectionTurnSeq,
        // 透传原始请求路径 —— AssetReflectionInjector 用它判断 `/analyse` marker。
        // 其它 injector 不依赖此字段。
        requestPath: c.req.path,
        custom: {
          ...(sessionInfo
            ? { session: sessionInfo, userKey: callerUserKey ?? undefined, assetCapabilities }
            : {}),
          nativeProxyEligible: requestKind === "main",
        },
        readOnly: requestKind === "fork",
      });
      body = injectedBody;
      messages = Array.isArray(injectedBody.messages) ? injectedBody.messages : messages;
      hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      nativeToolDefinitionInjected = requestKind === "main"
        && Array.isArray(body.tools)
        && body.tools.some((tool) => (
          tool !== null
          && typeof tool === "object"
          && typeof (tool as Record<string, unknown>).name === "string"
          && nativeToolRuntime?.registry.owns((tool as Record<string, unknown>).name as string)
        ));
    } catch (err: unknown) {
      console.error("[injection] anthropic pipeline error:", err instanceof Error ? err.message : String(err));
      const nativeFailure = describeNativeProxyToolInjectionFailure(err);
      if (nativeFailure) {
        return c.json({ type: "error", error: nativeFailure }, 400);
      }
    }
  } else if (skipInjection) {
    console.log(`[injection-debug] skipping injection for kind=sidequery session=${sessionKey}`);
  }

  // ── Cost guard: resolve forward target (opaque — no routing logic here) ──
  // upstream.agents[agent] is a single map keyed by agent name (URL path
  // prefix); both url and apiKey may be overridden per agent. When there's
  // no entry, we fall through to the Anthropic-specific global (costGuard
  // .anthropicUpstream) and finally to upstream.url — exactly as before.
  const agentUpstreamEntry = agentFromPath ? config.upstream.agents?.[agentFromPath] : undefined;
  const defaultUpstreamUrl =
    agentUpstreamEntry?.url ||
    config.costGuard.anthropicUpstream?.url ||
    config.upstream.url;
  // Normalize the request path to the canonical upstream endpoint so the
  // extension's URL joining matches the host whitelist behavior.
  const forwardEndpoint = usesResponsesUpstream
    ? "/responses"
    : matchWhitelistEndpoint(c.req.path)?.upstreamEndpoint ?? "/messages";
  // Isolation key is user-namespaced (`${user}:${session}`) so two users that
  // share the same client session id can't contaminate each other's state /
  // turn counting. ClickHouse keeps the raw session_key (it has its own
  // user_id column); this composite is internal to the extension only.
  const target: ForwardTarget = await resolveForwardTarget(config, {
    keyId: `${keyId}:${sessionKey}`,
    messages,
    protocol: usesResponsesUpstream ? "openai" : "anthropic",
    hasTools,
    body,
    modelId,
    defaultUpstreamUrl,
    requestPath: forwardEndpoint,
    headers: lcHeaders,
    traceId,
    startTime,
    spaceId,
    // markerOptIn=false (default/prod): every request goes through the router
    //   regardless of the URL (`/cost-guard` routes are 404 in this mode).
    // markerOptIn=true (test env): only requests with the `/cost-guard`
    //   segment activate the router; bare paths passthrough.
    useGuard: config.costGuard.markerOptIn ? hasCostGuardMarker(c.req.path) : true,
    agentName: agentFromPath,
  });

  // Claude Code 执行 WebSearch 时会另发 Provider Tool 辅助请求；它不是当前
  // 对话的一轮，也不会携带 UserPromptSubmit 标记，因此不参与 Native 历史恢复。
  if (requestKind !== "sidequery" && historyRuntime?.ledgerStorage && toolExecutionScope) {
    try {
      const restored = await historyRuntime.runOperation(() => materializeClaudeToolLedgerHistory({
        messages: nativeMarkerMessages
          ?? (messages as JsonValue[]),
        scope: toolExecutionScope,
        storage: historyRuntime.ledgerStorage!,
      }));
      hookTurnSeq = restored.turnSeq;
      toolExecutionScope.contextVersion = `epoch:${restored.currentEpoch}`;
      // 先在 Claude Code 原始消息上恢复工具历史，再执行 Anthropic 原有的
      // 边界规则：system 只允许放在顶层，不能留在 messages 中。
      const restoredMessages = restored.messages.filter((message) => (
        !message
        || typeof message !== "object"
        || Array.isArray(message)
        || (message as Record<string, JsonValue>).role !== "system"
      ));
      messages = restoredMessages;
      body = { ...body, messages: restoredMessages };
    } catch (error) {
      return nativeToolErrorResponse(
        error instanceof NativeToolLedgerConflictError ? 409 : 503,
        error instanceof NativeToolLedgerConflictError ? "native_tool_history_conflict" : "native_tool_history_unavailable",
        error instanceof NativeToolLedgerConflictError
          ? error.message
          : "Native Proxy Tool history could not be restored",
      );
    }
  }

  // ── Create pipeline logger ──────────────────────────────────────────────
  const pipe = createPipeline(config, traceId, target.model);
  pipe.requestReceived(messages.length, isStream);
  if (ccRoutingEnabled) {
    console.log(`[cc-routing] session=${sessionKey} kind=${requestKind} msgs=${messages.length}`);
  }



  // ── Trace-level tags ──
  // agent_source 标明客户端族群（codebuddy / claude-code / codex / …），供
  // Langfuse 上按客户端筛选 trace；protocol 只区分 wire 协议，同一 wire
  // 可对应多个客户端。
  const traceTags: string[] = [
    `agent_source:${agentSource}`,
    "protocol:anthropic",
    `upstream_protocol:${usesResponsesUpstream ? "responses" : "anthropic"}`,
    isStream ? "stream" : "non-stream",
    `session:${sessionKey}`,
  ];

  // ── Langfuse turn context: one trace = one turn (deterministic traceId) ──
  // Same (sessionKey, turnSeq) across a turn's tool-loop requests → same trace.
  // Prefer the extension's monotonic per-session turnSeq (survives context
  // compaction); fall back to the stateless count when it's not tracked
  // (extension disabled/unavailable, or no-tools auxiliary request).
  const turnSeq = hookTurnSeq && hookTurnSeq > 0
    ? hookTurnSeq
    : target.turnSeq > 0 ? target.turnSeq : countHumanTurns(messages, "anthropic");
  const lf: LangfuseTurnContext = {
    traceId: langfuseTurnTraceId(sessionKey, turnSeq),
    turnSeq,
    traceName: `${target.model} / ${keyId}`,
    userId: keyId,
    sessionId: sessionKey,
    tags: traceTags,
    routeTags: [],
    userQuery: resolveLatestUserQuery(config, lcHeaders, c.req.path, body, messages),
  };

  // ── Langfuse debug metadata (only when config.langfuse.debug=true) ────────
  // 抓 CB / CC 客户端指纹用；关闭时恒返回 {}，不污染线上 metadata。
  // 详见 common/langfuse-debug.ts。
  const langfuseDebug = config.langfuse.debug === true;
  const debugMetadata = buildRequestDebugMetadata({
    debug: langfuseDebug,
    body: body as Record<string, unknown>,
    ...(nativeToolRuntime
      ? { hiddenToolNames: nativeToolRuntime.registry.list().map((tool) => tool.name) }
      : {}),
    headers: reqHeaders,
    agentSource,
    requestKind,
    spaceId,
    turnSeq,
    requestPath: c.req.path,
    protocol: "anthropic",
  });

  // ── Opik: create trace ───────────────────────────────────────────────────
  const forkTraceId = opikCreateTrace(config, {
    traceId,
    projectName: keyId,
    name: `${target.model} / ${keyId}`,
    startTime,
    input: { messages: flattenAnthropicMessagesForOpik(messages, body.system) },
    tags: traceTags,
    forkProjectName: "request_log",
    forkMetadata: {
      keyId,
      modelId: target.model,
      stream: isStream,
      upstreamUrl: target.url,
    },
  });

  // ── Request debug log ────────────────────────────────────────────────────
  writeRequestLog(config, body);

  // ── Build upstream request ───────────────────────────────────────────────
  // Per-agent apiKey resolution — four cases:
  //   (a) no entry in agents map             → global upstream.apiKey
  //   (b) protocol-only entry                → global upstream.apiKey
  //   (c) routed entry, apiKey empty         → passthrough client key
  //   (d) routed entry, apiKey non-empty     → agent.apiKey
  // A protocol-only entry changes the wire format while retaining the global
  // URL/key. An entry that supplies a URL keeps the established semantics:
  // omitting apiKey means client-key passthrough for that independently routed
  // agent. This avoids copying the same secret just to switch wire protocols.
  const protocolOnlyAgentEntry = agentUpstreamEntry !== undefined
    && agentUpstreamEntry.url === undefined
    && agentUpstreamEntry.apiKey === undefined;
  const effectiveApiKey = agentUpstreamEntry && !protocolOnlyAgentEntry
    ? (agentUpstreamEntry.apiKey ?? "")
    : config.upstream.apiKey;
  let upstreamHeaders = buildUpstreamHeaders(c, config, target, sessionKey, effectiveApiKey);
  if (usesResponsesUpstream) upstreamHeaders = buildResponsesUpstreamHeaders(upstreamHeaders);

  // Optional private preparation stage. It rewrites `body` / `messages` in
  // place, so it has to land after every host-side mutation (injection, agent
  // overrides) and before the upstream body is assembled below. The host does
  // not interpret the returned stats — see request-prepare-adapter.ts.
  const preparedStats = await prepareUpstreamRequest({
    config,
    protocol: "anthropic",
    body,
    messages,
    sessionKey,
    pipe,
    upstreamCall: {
      upstreamUrl: target.url,
      headers: upstreamHeaders,
      model: target.model,
      tools: body.tools,
      system: body.system,
      bodyOverrides: target.bodyOverrides ?? undefined,
    },
    userQuery: lf.userQuery,
    spaceId,
    lf,
  });

  const { body: anthropicUpstreamBody, sanitizedCount } = buildUpstreamBody(body, target);
  if (sanitizedCount > 0) {
    pipe.info(
      "FORWARD",
      `stripped ${sanitizedCount} invalid thinking block(s) from history`,
    );
  }

  // Retry headers: preserve original client headers (x-request-id, user-agent,
  // etc.), then force the primary upstream's auth — retry always goes to the
  // default upstream (never the alternate route), so its apiKey must be applied
  // just like the first-attempt path. Without this, retry sends the
  // client's raw auth to tokenhub and gets 401.
  const originalHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      originalHeaders[k] = v;
    }
  }
  // Retry uses the same effective key as the primary path — same three
  // cases as above. When it resolves to "" (agent entry present but no
  // apiKey), retry also runs on the client's own key: preserves the
  // "passthrough on this agent" intent even across retries.
  if (effectiveApiKey) {
    originalHeaders["x-api-key"] = effectiveApiKey;
    delete originalHeaders["authorization"];
  }
  if (usesResponsesUpstream) {
    const convertedHeaders = buildResponsesUpstreamHeaders(originalHeaders);
    for (const name of Object.keys(originalHeaders)) delete originalHeaders[name];
    Object.assign(originalHeaders, convertedHeaders);
  }

  const anthropicRetryBody = buildRetryBody(body);
  let upstreamBody: Record<string, unknown>;
  let retryBody: Record<string, unknown>;
  try {
    upstreamBody = usesResponsesUpstream
      ? convertAnthropicRequestToResponses(anthropicUpstreamBody)
      : anthropicUpstreamBody;
    retryBody = usesResponsesUpstream
      ? convertAnthropicRequestToResponses(anthropicRetryBody)
      : anthropicRetryBody;
  } catch (error) {
    if (error instanceof AnthropicResponsesConversionError) {
      return c.json({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "anthropic_responses_conversion_failed",
          message: error.message,
        },
      }, 400);
    }
    throw error;
  }

  // ── Forward to upstream (with automatic retry if configured) ──────────────
  const forwardTimeoutMs = config.server.forwardTimeoutMs ?? 600_000;
  pipe.forwardStart();
  let upstreamResp: Response;
  let retried = false;

  try {
    const result = await forwardWithRetry(
      target, upstreamHeaders, upstreamBody,
      retryBody, originalHeaders,
      pipe, forwardTimeoutMs,
      sessionKey,
      { config, instanceId: spaceId || undefined },
    );
    upstreamResp = result.resp;
    retried = result.retried;
  } catch (err: unknown) {
    if (isRateLimitExceededError(err)) {
      pipe.info("RATE_LIMIT", "TPM/QPM exceeded");
      return err.response;
    }
    langfuseReportFailure({
      lf,
      model: target.model,
      startTime,
      endTime: new Date().toISOString(),
      input: buildLangfuseInput(messages, body.system, langfuseDebug, body.tools),
      statusMessage: err instanceof Error ? err.message : "Upstream request failed",
      extraTags: ["error"],
      observationMetadata: { stage: "forward", ...debugMetadata },
    });
    return c.json({ error: "Upstream request failed" }, 502);
  }

  // Build response headers
  const respHeaders = new Headers();
  for (const [k, v] of upstreamResp.headers.entries()) {
    if (!SKIP_RESPONSE_HEADERS.has(k.toLowerCase())) {
      respHeaders.set(k, v);
    }
  }

  // Upstream request id from response header (tokenhub / Anthropic set
  // `x-request-id`). Used for cross-system tracing/audit.
  const upstreamRequestId = upstreamResp.headers.get("x-request-id") ?? "";

  const effectiveModel = retried && target.retryTarget
    ? target.retryTarget.model
    : target.model;

  // A retry falls back to the model the client asked for, so the request ends
  // up costing what it would have cost unrouted — no saving to attribute.
  const routedFrom = retried ? "" : target.routedFrom;

  // ── Streaming response (Anthropic SSE) ──────────────────────────────────
  if (isStream) {
    if (!upstreamResp.body) {
      pipe.streamDone(null);
      return new Response(null, { status: upstreamResp.status, headers: respHeaders });
    }

    // Anthropic error responses are ordinary JSON, not SSE. Preserve every
    // non-2xx status/body exactly (including a retry result) before the Native
    // coordinator is allowed to acquire the sole successful-SSE consumer.
    if (upstreamResp.status < 200 || upstreamResp.status >= 300) {
      let errBytes = new Uint8Array(await upstreamResp.arrayBuffer());
      let errText = new TextDecoder().decode(errBytes);
      const sentErrorBody = retried ? retryBody : upstreamBody;
      const sentNativeToolDefinition = nativeToolDefinitionInjected
        && nativeToolRuntime !== null
        && Array.isArray(sentErrorBody.tools)
        && sentErrorBody.tools.some((tool) => (
          tool !== null
          && typeof tool === "object"
          && typeof (tool as Record<string, unknown>).name === "string"
          && nativeToolRuntime.registry.owns((tool as Record<string, unknown>).name as string)
        ));
      if (sentNativeToolDefinition) {
        errText = JSON.stringify({
          type: "error",
          error: { type: "api_error", message: "Upstream model request failed" },
        });
        errBytes = new TextEncoder().encode(errText);
      } else if (usesResponsesUpstream) {
        try {
          const converted = convertResponsesJsonToAnthropic(JSON.parse(errText));
          errText = JSON.stringify(converted);
          errBytes = new TextEncoder().encode(errText);
        } catch {
          errText = JSON.stringify({
            type: "error",
            error: { type: "api_error", message: "Responses upstream returned an error" },
          });
          errBytes = new TextEncoder().encode(errText);
        }
      }
      pipe.error("UPSTREAM_NON_2XX", `status=${upstreamResp.status} body=${errText.slice(0, 1000)}`);
      writeLog(config, {
        timestamp: new Date().toISOString(),
        event: "usage",
        modelId: target.model,
        keyId,
        sessionKey,
        upstreamUrl: target.url,
        stream: true,
        usage: { error: true, status: upstreamResp.status, body: errText.slice(0, 500) },
        routedFrom,
        spaceId,
        upstreamRequestId,
      });
      langfuseReportFailure({
        lf,
        model: effectiveModel,
        startTime,
        endTime: new Date().toISOString(),
        input: buildLangfuseInput(messages, body.system, langfuseDebug, body.tools),
        status: upstreamResp.status,
        statusMessage: errText.slice(0, 500),
        extraTags: ["error"],
        observationMetadata: { stage: "upstream", stream: true, ...debugMetadata },
      });
      pipe.streamDone(null);
      return new Response(errBytes, { status: upstreamResp.status, headers: respHeaders });
    }

    const successfulBody = retried ? retryBody : upstreamBody;
    const sentNativeToolDefinition = nativeToolDefinitionInjected
      && Array.isArray(successfulBody.tools)
      && successfulBody.tools.some((tool) => (
        tool !== null
        && typeof tool === "object"
        && typeof (tool as Record<string, unknown>).name === "string"
        && nativeToolRuntime?.registry.owns((tool as Record<string, unknown>).name as string)
      ));
    if (
      nativeToolRuntime
      && nativeToolRuntime.storage
      && nativeToolRuntime.dispatcher
      && toolExecutionScope
      && sentNativeToolDefinition
    ) {
      const nativeStream = upstreamResp.body;
      const successfulUrl = retried && target.retryTarget
        ? target.retryTarget.url
        : target.url;
      const successfulHeaders = retried
        ? {
            ...originalHeaders,
            "content-type": "application/json",
            ...(sessionKey ? { "x-vertex-ai-session-id": sessionKey } : {}),
          }
        : upstreamHeaders;
      const successfulModel = typeof successfulBody.model === "string"
        ? successfulBody.model
        : effectiveModel;
      let upstreamSnapshot;
      try {
        const logicalMessages = nativeLogicalBaseMessages ?? messages;
        upstreamSnapshot = buildUpstreamRequestSnapshot({
          protocol: usesResponsesUpstream ? "responses" : "anthropic",
          clientProtocol: "anthropic",
          body: successfulBody,
          url: successfulUrl,
          model: successfulModel,
          ...(nativeLogicalRequestFingerprint
            ? { requestFingerprint: nativeLogicalRequestFingerprint }
            : {}),
          logicalBaseMessages: logicalMessages,
          observationIntent: buildPersistedToolObservationIntent({
            config,
            scope: toolExecutionScope,
            requestKind,
            tdaiIdentity,
            logicalMessages,
            assetCapabilities,
          }),
          authSource: successfulAuthSource({
            retried,
            target,
            effectiveApiKey,
            hasAgentEntry: agentUpstreamEntry !== undefined,
          }),
        });
      } catch {
        pipe.streamDone(null);
        return nativeToolErrorResponse(
          500,
          "native_tool_snapshot_failed",
          "Native Proxy Tool request snapshot could not be created",
        );
      }
      const reenter = createRetainedExactTargetTransport({
        capturedSnapshot: upstreamSnapshot,
        headers: successfulHeaders,
        timeoutMs: forwardTimeoutMs,
        beforeFetch: async (model) => {
          await enforceRateLimit({
            config,
            instanceId: spaceId || undefined,
            modelId: model,
            protocol: "anthropic",
          });
        },
      });
      const coordinatorOptions = {
        registry: nativeToolRuntime.registry,
        storage: nativeToolRuntime.storage,
        ledgerStorage: nativeToolRuntime.ledgerStorage ?? undefined,
        dispatcher: nativeToolRuntime.dispatcher,
        limits: config.nativeProxyTools,
        reenter,
        trackBackgroundOperation: (operation: () => Promise<void>) => nativeToolRuntime.trackBackgroundOperation(operation),
      };
      const initialRoundInput = {
        stream: nativeStream,
        status: upstreamResp.status,
        headers: respHeaders,
        scope: toolExecutionScope,
        turnSeq,
        upstreamSnapshot,
        round: 1,
        totalCalls: 0,
      };
      const decision: ToolLoopDecision | OpenAIToolLoopDecision = usesResponsesUpstream
        ? await nativeToolRuntime.runOperation(() => new AnthropicClientResponsesToolLoopCoordinator({
            ...coordinatorOptions,
            model: successfulModel,
          }).handleRound(initialRoundInput))
        : await nativeToolRuntime.runOperation(() => new AnthropicToolLoopCoordinator(
            coordinatorOptions,
          ).handleRound(initialRoundInput));
      if (decision.kind === "client_dispatch") {
        nativeToolRuntime.retainExactTarget(decision.stateKey, reenter);
      }
      if (decision.kind === "final" && decision.observationStateKey) {
        const observationStateKey = decision.observationStateKey;
        const observationStorage = nativeToolRuntime.storage;
        try {
          await nativeToolRuntime.runOperation(() => flushDurableNativeToolObservation({
            storage: observationStorage,
            stateKey: observationStateKey,
            bytes: decision.bytes,
            leaseMs: nativeReentryLeaseWindowMs(config),
            config,
          }));
        } catch (error) {
          const code = error instanceof ToolObservationOutboxError
            ? error.code
            : "native_tool_observation_failed";
          return nativeToolErrorResponse(
            503,
            code,
            "Native Tool logical-turn writeback is pending and must be retried",
          );
        }
      }

      const nativeObservationContext: AnthropicTapContext = {
        config,
        modelId: successfulModel,
        keyId,
        sessionKey,
        upstreamUrl: successfulUrl,
        requestPath: c.req.path,
        traceId,
        forkTraceId,
        startTime,
        inputMessages: upstreamSnapshot.baseMessages,
        system: upstreamSnapshot.system,
        tools: upstreamSnapshot.tools,
        retried,
        logMeta: retried ? { retrySuccess: true } : {},
        routedFrom,
        pipe,
        sessionKeyForSkill: sessionKey,
        agentSource,
        sessionInfo,
        tdaiClient,
        tdaiIdentity,
        tdaiUserMessage,
        assetCapabilities,
        lf,
        spaceId,
        upstreamRequestId: decision.headers.get("x-request-id") ?? upstreamRequestId,
        requestKind: decision.kind === "final" && decision.observationStateKey
          ? "fork"
          : requestKind,
        langfuseDebug,
        debugMetadata,
        preparedStats,
      };
      if (usesResponsesUpstream) {
        observeResponsesNativeToolDecision(decision as OpenAIToolLoopDecision, nativeObservationContext);
      } else {
        observeNativeToolDecision(decision as ToolLoopDecision, nativeObservationContext);
      }

      const decisionHeaders = new Headers(decision.headers);
      const isSse = decisionHeaders.get("content-type")?.toLowerCase().includes("text/event-stream");
      const clientStream = isSse
        ? streamFromBytes(decision.bytes).pipeThrough(createSseThinkingFixStream(pipe))
        : streamFromBytes(decision.bytes);
      return new Response(clientStream, {
        status: decision.status,
        headers: decisionHeaders,
      });
    }

    const anthropicResponseStream = usesResponsesUpstream
      ? upstreamResp.body.pipeThrough(createResponsesToAnthropicSseTransform({ model: effectiveModel }))
      : upstreamResp.body;
    const [rawClientStream, tapStream] = anthropicResponseStream.tee();
    pipe.streamStart();

    // Background: consume tap stream for Anthropic SSE → extract usage
    consumeAnthropicStream(tapStream, {
      config,
      modelId: effectiveModel,
      keyId,
      sessionKey,
      upstreamUrl: target.url,
      requestPath: c.req.path,
      traceId,
      forkTraceId,
      startTime,
      inputMessages: messages,
      system: body.system,
      tools: body.tools,
      retried,
      logMeta: retried ? { retrySuccess: true } : {},
      routedFrom,
      pipe,
      sessionKeyForSkill: sessionKey,
      agentSource,
      sessionInfo,
      tdaiClient,
      tdaiIdentity,
      tdaiUserMessage,
      assetCapabilities,
      lf,
      spaceId,
      upstreamRequestId,
      requestKind,
      langfuseDebug,
      debugMetadata,
      preparedStats,
    });

    const clientStream = rawClientStream.pipeThrough(createSseThinkingFixStream(pipe));

    return new Response(clientStream, { status: upstreamResp.status, headers: respHeaders });
  }

  // ── Non-streaming response ───────────────────────────────────────────────
  let respText = await upstreamResp.text();
  if (usesResponsesUpstream) {
    try {
      respText = JSON.stringify(convertResponsesJsonToAnthropic(JSON.parse(respText)));
    } catch {
      respText = JSON.stringify({
        type: "error",
        error: { type: "api_error", message: "Responses upstream returned an invalid response" },
      });
    }
  }
  const endTime = new Date().toISOString();

  let usage: Record<string, unknown> | null = null;
  let outputContent: string | null = null;
  let assistantMessage: Record<string, unknown> | null = null;
  try {
    const respJson = JSON.parse(respText) as Record<string, unknown>;
    if (respJson.usage && typeof respJson.usage === "object") {
      usage = respJson.usage as Record<string, unknown>;
    }
    const content = respJson.content;
    if (Array.isArray(content)) {
      const textParts: string[] = [];
      let thinkingPatched = false;
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === "text") textParts.push(block.text as string);
        // Fix thinking blocks with missing/null `thinking` field.
        // Some models (e.g. DeepSeek) emit `type: "thinking"` blocks
        // without a valid `thinking` string, causing Claude Code to crash
        // with "undefined is not an object (evaluating 's.thinking.length')".
        if (block.type === "thinking") {
          if (block.thinking === undefined || block.thinking === null) {
            block.thinking = "";
            thinkingPatched = true;
          } else if (typeof block.thinking !== "string") {
            block.thinking = String(block.thinking);
            thinkingPatched = true;
          }
        }
      }
      if (thinkingPatched) {
        respText = JSON.stringify(respJson);
        pipe.info("NONSTREAM_THINKING_FIX", "patched thinking block(s) with missing 'thinking' field");
      }
      outputContent = textParts.join("\n");
      // Preserve full content array (incl. tool_use blocks) for skill trigger.
      assistantMessage = { role: "assistant", content };

      // Report the completed response to the extension (same signal the
      // streaming path emits). Fire-and-forget.
      void notifyUpstreamResponse(
        config,
        {
          protocol: "anthropic",
          sessionKey,
          model: effectiveModel,
          stream: false,
          turnSeq: lf.turnSeq,
          text: outputContent,
          toolCalls: (content as Record<string, unknown>[])
            .filter((b) => b?.type === "tool_use")
            .map((b) => ({
              id: (b.id as string) ?? "",
              name: (b.name as string) ?? "",
              arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? ""),
            }))
            .filter((tc) => tc.id && tc.arguments),
          usage: usage ?? {},
        },
        pipe,
      );

      // 内部使用埋点：非流式响应 tool_use 块逐个记 model_intent。
      try {
        const intents = (content as Record<string, unknown>[])
          .filter((b) => b?.type === "tool_use")
          .map((b) => {
            const name = (b.name as string) ?? "";
            const input = b.input;
            const argsStr = typeof input === "string" ? input : JSON.stringify(input ?? "");
            return { name, arguments: argsStr };
          })
          .filter((i) => i.name);
        if (intents.length > 0) {
          emitModelIntentTelemetry({
            // 与 session_init_logs 对齐 compositeKey 形态
            sessionKey: `${agentSource}:${sessionKey}`,
            turnSeq: lf.turnSeq,
            spaceId,
            userId: keyId,
            agentSource,
            intents,
          });
        }
      } catch {
        // 埋点绝不阻塞业务
      }
    }
  } catch {
    // non-JSON response
  }

  const logMeta = retried ? { retrySuccess: true } : {};

  if (usage) {
    await recordInputTokenUsage({
      config,
      instanceId: spaceId || undefined,
      modelId: effectiveModel,
      usage,
      protocol: "anthropic",
    });
    writeLog(config, {
      timestamp: endTime,
      event: "usage",
      modelId: effectiveModel,
      keyId,
      sessionKey,
      turnSeq: lf.turnSeq,
      userInput: lf.userQuery || undefined,
      upstreamUrl: target.url,
      stream: false,
      usage,
      extensionStats: preparedStats ?? undefined,
      routedFrom,
      spaceId,
      upstreamRequestId,
      ...logMeta,
    });

    opikCreateLlmSpan(config, {
      traceId,
      projectName: keyId,
      name: effectiveModel,
      startTime,
      endTime,
      inputMessages: flattenAnthropicMessagesForOpik(messages, body.system),
      outputMessage: outputContent ? { role: "assistant", content: outputContent } : null,
      model: effectiveModel,
      usage,
      tags: retried ? ["retry"] : undefined,
      forkProjectName: "request_log",
      forkTraceId,
      forkMetadata: {
        keyId,
        modelId: effectiveModel,
        stream: false,
        upstreamUrl: target.url,
      },
    });

    // Langfuse: report this LLM call as a generation under the turn trace
    // debug=true 时 output 用 assistantMessage 原生数组（含 tool_use / thinking /
    // 原生 stop_reason），非 debug 走原有 text 拼接节省存储。
    const langfuseOutput = langfuseDebug && assistantMessage
      ? assistantMessage
      : outputContent
      ? { role: "assistant", content: outputContent }
      : undefined;
    langfuseReportGeneration({
      traceId: lf.traceId,
      name: effectiveModel,
      model: effectiveModel,
      startTime,
      endTime,
      input: buildLangfuseInput(messages, body.system, langfuseDebug, body.tools),
      output: langfuseOutput,
      usage,
      traceName: lf.traceName,
      userId: lf.userId,
      sessionId: lf.sessionId,
      tags: lf.tags,
      traceInput: lf.userQuery || undefined,
      traceOutput: langfuseOutput,
      traceMetadata: { stream: false, retried, upstreamUrl: target.url, ...logMeta, ...debugMetadata },
      observationMetadata: { retried, ...logMeta, ...debugMetadata },
    });
  } else if (upstreamResp.status >= 400) {
    pipe.error("UPSTREAM_4xx", `status=${upstreamResp.status} body=${respText.slice(0, 1000)}`);
    langfuseReportFailure({
      lf,
      model: effectiveModel,
      startTime,
      endTime,
      input: buildLangfuseInput(messages, body.system, langfuseDebug, body.tools),
      status: upstreamResp.status,
      statusMessage: respText.slice(0, 500),
      extraTags: ["error"],
      observationMetadata: { stage: "upstream", stream: false, ...debugMetadata },
    });
  }

  pipe.responseDone(usage);

  // CC 分流：FORK/SIDEQUERY 是 CC 客户端后台自发调用，不是用户真实对话轮，
  //          跳过 skill/L0 副作用。Credit 仍上报（token 消耗真实）。
  const isMainDialog = requestKind === "main";

  // Skill extract trigger — count tool_use blocks + buffer conversation.
  // 同步 await：直到 store 落盘再继续，保证下一轮跨节点读到最新数据。
  if (isMainDialog && isExtractionAllowed(config, "skill")) {
    await triggerSkillExtractIfReady({
      config,
      sessionKey,
      agentSource,
      sessionInfo,
      inputMessages: messages,
      assistantMessage,
      protocol: "anthropic",
      assetCapabilities,
    });
  } else if (isMainDialog) {
    logExtractionSkipped(config, "skill", sessionKey);
  } else {
    console.log(`[cc-routing] skip skill buffer for kind=${requestKind} session=${sessionKey}`);
  }

  // TDAI L0 write (non-streaming).
  //
  // 与 stream 分支 (1476-1481) 对称：把 user_query + assistant 回复写入 L0
  // 短期记忆。**此前仅 stream=true 会写**，non-stream 请求（如工具/测试脚本
  // 常用的 stream:false）沉默丢失。缺失该调用意味着 CC non-stream 场景
  // 完全没有 L0 记忆写入。
  if (isMainDialog && tdaiClient && isExtractionAllowed(config, "tdai-memory")) {
    recordTdaiTurn(tdaiClient, tdaiIdentity, tdaiUserMessage, outputContent)
      .catch((err: unknown) => pipe.error("TDAI_L0", err));
  } else if (isMainDialog && tdaiClient) {
    logExtractionSkipped(config, "tdai-memory", sessionKey);
  } else if (!isMainDialog) {
    console.log(`[cc-routing] skip L0 write for kind=${requestKind} session=${sessionKey}`);
  }

  // Credit usage reporting (non-streaming). Failures are surfaced to the client
  // via the `x-credit-report-error` response header but never replace the
  // upstream LLM response body — the user-facing answer is preserved.
  const creditOutcome = await tryReportCreditFromPath(
    config.creditReport,
    c.req.path,
    usage,
    config.creditPricing,
    effectiveModel,
    target.url,
    "usage",
  );
  if (creditOutcome.attempted && !creditOutcome.ok) {
    pipe.error("CREDIT_REPORT", creditOutcome.errorMessage ?? "unknown");
    if (creditOutcome.errorHeader) {
      respHeaders.set("x-credit-report-error", creditOutcome.errorHeader);
    }
    // Persist the failed report as a raw record for auditing / retry pipelines.
    writeFailedReportRaw(
      {
        timestamp: new Date().toISOString(),
        event: "usage",
        modelId: effectiveModel,
        keyId,
        sessionKey,
        upstreamUrl: target.url,
        stream: false,
        usage: usage === null ? undefined : usage,
        routedFrom,
        upstreamRequestId,
        pricingConfig: config.creditPricing,
      },
      creditOutcome.errorMessage ?? "unknown",
    );
  }

  return new Response(respText, { status: upstreamResp.status, headers: respHeaders });
}


/**
 * Create a TransformStream that patches Anthropic SSE events in-band.
 */
function createSseThinkingFixStream(
  pipe: ReturnType<typeof createPipeline>,
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let sseBuf = "";
  let patchedCount = 0;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sseBuf += decoder.decode(chunk, { stream: true });

      const parts = sseBuf.split("\n\n");
      sseBuf = parts.pop() ?? "";

      for (const part of parts) {
        const lines = part.split("\n");
        let dataLine = "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            dataLine = line;
          }
        }

        if (!dataLine) {
          controller.enqueue(encoder.encode(part + "\n\n"));
          continue;
        }

        const dataStr = dataLine.slice(6);
        if (!dataStr || dataStr === "[DONE]") {
          controller.enqueue(encoder.encode(part + "\n\n"));
          continue;
        }

        try {
          const evt = JSON.parse(dataStr) as Record<string, unknown>;
          let patched = false;

          if (evt.type === "content_block_start") {
            const block = evt.content_block as Record<string, unknown> | undefined;
            if (block?.type === "thinking") {
              if (block.thinking === undefined || block.thinking === null) {
                block.thinking = "";
                patched = true;
              } else if (typeof block.thinking !== "string") {
                block.thinking = String(block.thinking);
                patched = true;
              }
            }
          }

          // Fix content_block_delta with type=thinking_delta but missing thinking field.
          // Claude Code does `contentBlock.thinking += delta.thinking` which would
          // produce "null" or "undefined" strings if delta.thinking is not a string.
          if (evt.type === "content_block_delta") {
            const delta = evt.delta as Record<string, unknown> | undefined;
            if (delta?.type === "thinking_delta") {
              if (delta.thinking === undefined || delta.thinking === null) {
                delta.thinking = "";
                patched = true;
              } else if (typeof delta.thinking !== "string") {
                delta.thinking = String(delta.thinking);
                patched = true;
              }
            }
          }

          if (patched) {
            patchedCount++;
            const newDataLine = "data: " + JSON.stringify(evt);
            const newLines = lines.map((l) =>
              l.startsWith("data: ") ? newDataLine : l,
            );
            controller.enqueue(encoder.encode(newLines.join("\n") + "\n\n"));
          } else {
            controller.enqueue(encoder.encode(part + "\n\n"));
          }
        } catch {
          controller.enqueue(encoder.encode(part + "\n\n"));
        }
      }
    },

    flush(controller) {
      if (sseBuf.trim()) {
        controller.enqueue(encoder.encode(sseBuf));
      }
      if (patchedCount > 0) {
        pipe.info("SSE_FIX", `patched ${patchedCount} thinking block(s) with missing 'thinking' field`);
      }
    },
  });
}

// ── Stream processing helpers ────────────────────────────────────────────────

interface AnthropicTapContext {
  config: ProxyConfig;
  modelId: string;
  keyId: string;
  sessionKey: string;
  upstreamUrl: string;
  requestPath: string;
  traceId: string;
  forkTraceId: string;
  startTime: string;
  inputMessages: unknown[];
  /** Anthropic top-level `system` field (string or content-block array). */
  system: unknown;
  /** Actual post-injection Anthropic `tools` field sent upstream. */
  tools: unknown;
  retried: boolean;
  logMeta: Record<string, unknown>;
  /** Requested model when the router forwarded elsewhere; "" otherwise. */
  routedFrom: string;
  pipe: ReturnType<typeof createPipeline>;
  /** For skill extract trigger. */
  sessionKeyForSkill: string;
  /** Client type (URL path 第一段) — 透传给 extract trigger 作为三段隔离键之一。 */
  agentSource: string;
  sessionInfo: Record<string, unknown> | null | undefined;
  /** Tdai L0 write. */
  tdaiClient: TdaiClient | null;
  tdaiIdentity: TdaiIdentity | null;
  tdaiUserMessage: TdaiMessage | null;
  assetCapabilities?: import("./injection/types.js").AssetCapabilityFlags;
  /** Langfuse turn-trace context (trace = one turn). */
  lf: LangfuseTurnContext;
  /** Space/tenant ID from request path. */
  spaceId?: string;
  /** Upstream response header `x-request-id` (empty when not returned). */
  upstreamRequestId?: string;
  /** CC 请求分流类别，决定 stream 完成后是否触发 skill/L0 副作用。 */
  requestKind: CcRequestKind;
  /** `config.langfuse.debug === true` 的求值结果，透传避免流内重复读 config。 */
  langfuseDebug: boolean;
  /** buildRequestDebugMetadata 求值结果；debug=false 时为 {}。 */
  debugMetadata: Record<string, unknown>;
  /** Opaque counters from the request-preparation stage; null when it didn't run. */
  preparedStats: Record<string, unknown> | null;
}

/** Observe buffered protocol snapshots without acquiring the network stream again. */
function observeNativeToolDecision(
  decision: ToolLoopDecision,
  ctx: AnthropicTapContext,
): void {
  if (decision.rounds.length === 0) {
    ctx.pipe.streamDone(null);
    return;
  }

  const lastIndex = decision.rounds.length - 1;
  decision.rounds.forEach((snapshot, index) => {
    const roundPipe = index === lastIndex
      ? ctx.pipe
      : createPipeline(ctx.config, ctx.traceId, ctx.modelId);
    if (index !== lastIndex) {
      roundPipe.requestReceived(ctx.inputMessages.length, true);
    }
    roundPipe.streamStart();
    const nativeIndexes = new Set(snapshot.toolCalls
      .filter((call) => call.owner === "proxy")
      .map((call) => call.contentBlockIndex));
    let observationBytes = snapshot.rawBytes;
    if (nativeIndexes.size > 0) {
      try {
        observationBytes = buildClientVisibleAnthropicSse(snapshot, nativeIndexes);
      } catch {
        // An incomplete/error snapshot cannot be safely rebuilt. Dropping its
        // telemetry payload is preferable to exposing hidden Tool arguments.
        roundPipe.streamDone(null);
        return;
      }
    }
    consumeAnthropicStream(streamFromBytes(observationBytes), {
      ...ctx,
      pipe: roundPipe,
      // Hidden Native rounds have accounting/Generation telemetry but never
      // run per-turn L0 or Skill writeback. Only the final visible response is
      // treated as the logical main-dialog response.
      requestKind: index === lastIndex && isLogicalFinalToolLoopDecision(decision.kind)
        ? ctx.requestKind
        : "fork",
      logMeta: {
        ...ctx.logMeta,
        nativeToolRound: index + 1,
        nativeToolDecision: decision.kind,
      },
    });
  });
}

/** Observe Responses-native rounds after rebuilding their Anthropic client view. */
function observeResponsesNativeToolDecision(
  decision: OpenAIToolLoopDecision,
  ctx: AnthropicTapContext,
): void {
  if (decision.rounds.length === 0) {
    ctx.pipe.streamDone(null);
    return;
  }
  const lastIndex = decision.rounds.length - 1;
  decision.rounds.forEach((snapshot, index) => {
    const roundPipe = index === lastIndex
      ? ctx.pipe
      : createPipeline(ctx.config, ctx.traceId, ctx.modelId);
    if (index !== lastIndex) roundPipe.requestReceived(ctx.inputMessages.length, true);
    roundPipe.streamStart();
    const nativeIndexes = new Set(snapshot.toolCalls
      .filter((call) => call.owner === "proxy")
      .map((call) => call.contentBlockIndex));
    try {
      const responsesBytes = nativeIndexes.size > 0
        ? buildClientVisibleResponsesSse(snapshot.rawBytes, nativeIndexes)
        : snapshot.rawBytes;
      const observationBytes = convertResponsesSseBytesToAnthropic(
        [responsesBytes],
        { model: ctx.modelId },
      );
      consumeAnthropicStream(streamFromBytes(observationBytes), {
        ...ctx,
        pipe: roundPipe,
        requestKind: index === lastIndex && isLogicalFinalToolLoopDecision(decision.kind)
          ? ctx.requestKind
          : "fork",
        logMeta: {
          ...ctx.logMeta,
          nativeToolRound: index + 1,
          nativeToolDecision: decision.kind,
          upstreamProtocol: "responses",
        },
      });
    } catch {
      roundPipe.streamDone(null);
    }
  });
}

/**
 * Consume Anthropic SSE stream in background, extract usage, log + Opik.
 */
function consumeAnthropicStream(stream: ReadableStream<Uint8Array>, ctx: AnthropicTapContext): void {
  const { config, modelId, keyId, sessionKey, upstreamUrl, traceId, forkTraceId, startTime, inputMessages, system, retried, logMeta, pipe, lf, spaceId, upstreamRequestId } = ctx;

  (async () => {
    const decoder = new TextDecoder();
    let sseBuf = "";
    let usage: Record<string, unknown> = {};
    let outputText = "";
    let toolUseCount = 0;
    let streamCompleted = false;
    // 内部使用埋点用：按 index 累积每个 tool_use 块。
    // Anthropic SSE 协议：
    //   1. content_block_start(type=tool_use)  → 拿到 index + name（此时 input 是空 {}）
    //   2. content_block_delta(type=input_json_delta) → 累积 partial_json 字符串
    //   3. content_block_stop → 该块结束
    // 之前的实现只读了 (1) 里的 input（永远空）—— 现在按 index 累加 (2) 里的 partial_json。
    const toolUseAcc = new Map<number, { id: string; name: string; inputJson: string }>();

    const timeoutHandle = setTimeout(() => {
      if (!streamCompleted) {
        pipe.error("STREAM_TIMEOUT", "Anthropic stream reading exceeded 5 minutes");
        // completeStream 是 async；这里 fire-and-forget（timeout 里已经无法 await）
        void completeStream().catch((err) => pipe.error("STREAM_TIMEOUT_COMPLETE", err));
      }
    }, 5 * 60 * 1000);

    async function completeStream(): Promise<void> {
      if (streamCompleted) return;
      streamCompleted = true;
      clearTimeout(timeoutHandle);

      const endTime = new Date().toISOString();

      if (Object.keys(usage).length > 0) {
        await recordInputTokenUsage({
          config,
          instanceId: spaceId || undefined,
          modelId,
          usage,
          protocol: "anthropic",
        });
        try {
          writeLog(config, {
            timestamp: endTime,
            event: "usage",
            modelId,
            keyId,
            sessionKey,
            turnSeq: lf.turnSeq,
            userInput: lf.userQuery || undefined,
            upstreamUrl,
            stream: true,
            usage,
            extensionStats: ctx.preparedStats ?? undefined,
            routedFrom: ctx.routedFrom,
            spaceId,
            upstreamRequestId,
            ...logMeta,
          });
        } catch (logErr: unknown) {
          pipe.error("LOG_WRITE", logErr);
        }

        try {
          opikCreateLlmSpan(config, {
            traceId,
            projectName: keyId,
            name: modelId,
            startTime,
            endTime,
            inputMessages: flattenAnthropicMessagesForOpik(inputMessages, system),
            outputMessage: outputText ? { role: "assistant", content: outputText } : null,
            model: modelId,
            usage,
            tags: retried ? ["retry"] : undefined,
            forkProjectName: "request_log",
            forkTraceId,
            forkMetadata: {
              keyId,
              modelId,
              stream: true,
              upstreamUrl,
            },
          });
        } catch (opikErr: unknown) {
          pipe.error("OPIK_SPAN", opikErr);
        }

        // Langfuse: report this LLM call as a generation under the turn trace
        // 流式无完整原生 assistant content 数组可用（tool_use 块在 SSE 里是分片
        // 增量事件），debug 时把 tool_use_count 与 stop_reason 塞进 metadata 兜底。
        try {
          const streamDebugExtra = ctx.langfuseDebug
            ? {
                stream_tool_use_count: toolUseCount,
                stream_output_text_len: outputText.length,
              }
            : {};
          langfuseReportGeneration({
            traceId: lf.traceId,
            name: modelId,
            model: modelId,
            startTime,
            endTime,
            input: buildLangfuseInput(inputMessages, system, ctx.langfuseDebug, ctx.tools),
            output: outputText ? { role: "assistant", content: outputText } : undefined,
            usage,
            traceName: lf.traceName,
            userId: lf.userId,
            sessionId: lf.sessionId,
            tags: lf.tags,
            traceInput: lf.userQuery || undefined,
            traceOutput: outputText ? { role: "assistant", content: outputText } : undefined,
            traceMetadata: {
              stream: true, retried, upstreamUrl, ...logMeta,
              ...ctx.debugMetadata, ...streamDebugExtra,
            },
            observationMetadata: {
              retried, ...logMeta,
              ...ctx.debugMetadata, ...streamDebugExtra,
            },
          });
        } catch (langfuseErr: unknown) {
          pipe.error("LANGFUSE_SPAN", langfuseErr);
        }
      }

      // CC 分流：FORK/SIDEQUERY 不是真实对话轮，跳过 L0/skill。Credit 仍上报。
      const isMainDialog = ctx.requestKind === "main";

      // Tdai L0 write
      if (isMainDialog && ctx.tdaiClient && isExtractionAllowed(ctx.config, "tdai-memory")) {
        // Streaming 不 await（会拖慢 SSE 关流），trackWrite + withL0Retry 应对两条丢包线：
        //   - trackWrite 注册 in-flight promise 到全局 set；SIGTERM 时 index.ts 会
        //     flushPendingWrites 兜底，避免 pod rolling 时 event loop 未 flush 就退出丢 L0。
        //   - withL0Retry 3 次退避重试（~3.5s），挡 tdai kernel 瞬断 / 5xx / 网络抖动。
        trackWrite(
          withL0Retry(() => recordTdaiTurn(
            ctx.tdaiClient!, ctx.tdaiIdentity, ctx.tdaiUserMessage,
            outputText || null,
          )).catch((err: unknown) => pipe.error("TDAI_L0", err))
        );
      } else if (isMainDialog && ctx.tdaiClient) {
        logExtractionSkipped(ctx.config, "tdai-memory", ctx.sessionKeyForSkill);
      } else if (!isMainDialog) {
        console.log(`[cc-routing] skip L0 write (stream) for kind=${ctx.requestKind} session=${ctx.sessionKeyForSkill}`);
      }

      pipe.streamDone(Object.keys(usage).length > 0 ? usage : null);

      // Report the completed response to the extension. Fire-and-forget; the
      // client has already been served by this point.
      void notifyUpstreamResponse(
        ctx.config,
        {
          protocol: "anthropic",
          sessionKey: ctx.sessionKey,
          model: modelId,
          stream: true,
          turnSeq: lf.turnSeq,
          text: outputText,
          toolCalls: Array.from(toolUseAcc.values())
            .filter((v) => v.id && v.inputJson)
            .map((v) => ({ id: v.id, name: v.name, arguments: v.inputJson })),
          usage,
        },
        pipe,
      );

      // 内部使用埋点：SSE 流累积的 tool_use 各出一条 model_intent。
      // 详见 docs/design/2026-08-03-internal-usage-telemetry-plan.md §7.2 F。
      // session_key 必须与 session_init_logs 用同一份 compositeKey (agentSource:sessionKey)，
      // 否则 §4.1 CTE 里的 `session_key IN (init_sessions)` 会对不上。
      if (toolUseAcc.size > 0) {
        // 按 index 排序输出（还原模型生成顺序）；inputJson 是流式累积的 partial_json
        const intents = Array.from(toolUseAcc.entries())
          .sort(([a], [b]) => a - b)
          .filter(([, v]) => v.name)
          .map(([, v]) => ({ name: v.name, arguments: v.inputJson || "{}" }));
        if (intents.length > 0) {
          emitModelIntentTelemetry({
            sessionKey: `${ctx.agentSource}:${ctx.sessionKey}`,
            turnSeq: ctx.lf.turnSeq,
            spaceId: ctx.spaceId,
            userId: ctx.keyId,
            agentSource: ctx.agentSource,
            intents,
          });
        }
      }

      // Skill extract trigger — after stream finalization.
      // 同步 await：直到 store 落盘再继续，保证下一轮跨节点读到最新数据。
      if (isMainDialog && isExtractionAllowed(ctx.config, "skill")) {
        await triggerSkillExtractIfReady({
          config: ctx.config,
          sessionKey: ctx.sessionKeyForSkill,
          agentSource: ctx.agentSource,
          sessionInfo: ctx.sessionInfo,
          inputMessages: ctx.inputMessages,
          assistantMessage: outputText
            ? { role: "assistant", content: outputText }
            : null,
          protocol: "anthropic",
          assetCapabilities: ctx.assetCapabilities,
          toolCallCountOverride: toolUseCount,
        });
      } else if (isMainDialog) {
        logExtractionSkipped(ctx.config, "skill", ctx.sessionKeyForSkill);
      } else {
        console.log(`[cc-routing] skip skill buffer (stream) for kind=${ctx.requestKind} session=${ctx.sessionKeyForSkill}`);
      }

      // Credit usage reporting for streaming responses. The stream has already
      // been forwarded to the client; failures here are best-effort and can
      // only be observed via server logs (no way to retro-add response headers).
      tryReportCreditFromPath(
        ctx.config.creditReport,
        ctx.requestPath,
        usage,
        ctx.config.creditPricing,
        ctx.modelId,
        ctx.upstreamUrl,
        "usage",
      )
        .then((outcome) => {
          if (outcome.attempted && !outcome.ok) {
            pipe.error("CREDIT_REPORT", `[stream] ${outcome.errorMessage ?? "unknown"}`);
            // Persist failed report as a raw record (reuses existing usage_raw table).
            writeFailedReportRaw(
              {
                timestamp: new Date().toISOString(),
                event: "usage",
                modelId: ctx.modelId,
                keyId: ctx.keyId,
                sessionKey: ctx.sessionKey,
                upstreamUrl: ctx.upstreamUrl,
                stream: true,
                usage,
                routedFrom: ctx.routedFrom,
                upstreamRequestId: ctx.upstreamRequestId,
                pricingConfig: ctx.config.creditPricing,
              },
              outcome.errorMessage ?? "unknown",
            );
          }
        })
        .catch((err: unknown) => pipe.error("CREDIT_REPORT", err));
    }

    try {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuf += decoder.decode(value, { stream: true });

        const parts = sseBuf.split("\n\n");
        sseBuf = parts.pop() ?? "";

        for (const part of parts) {
          const lines = part.split("\n");
          let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              dataStr = line.slice(6);
            } else if (line.startsWith("data:")) {
              dataStr = line.slice(5);
            }
          }

          if (!dataStr || dataStr === "[DONE]") continue;

          try {
            const evt = JSON.parse(dataStr) as Record<string, unknown>;
            const evtType = evt.type as string;

            if (evtType === "message_start") {
              const message = evt.message as Record<string, unknown> | undefined;
              if (message?.usage) {
                Object.assign(usage, message.usage as Record<string, unknown>);
              }
            } else if (evtType === "message_delta") {
              if (evt.usage) {
                Object.assign(usage, evt.usage as Record<string, unknown>);
              }
            } else if (evtType === "content_block_delta") {
              const delta = evt.delta as Record<string, unknown> | undefined;
              if (delta?.type === "text_delta" && typeof delta.text === "string") {
                outputText += delta.text;
              } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
                // 累积到对应 tool_use 块（按 index）
                try {
                  const idx = evt.index as number | undefined;
                  if (typeof idx === "number") {
                    const acc = toolUseAcc.get(idx);
                    if (acc) acc.inputJson += delta.partial_json;
                  }
                } catch {
                  // ignore — 埋点级别的问题不阻塞主链路
                }
              }
            } else if (evtType === "content_block_start") {
              const block = evt.content_block as Record<string, unknown> | undefined;
              if (block?.type === "tool_use") {
                toolUseCount++;
                try {
                  const name = (block.name as string) ?? "";
                  const idx = evt.index as number | undefined;
                  if (name && typeof idx === "number") {
                    toolUseAcc.set(idx, { id: (block.id as string) ?? "", name, inputJson: "" });
                  }
                } catch {
                  // ignore — 累积失败不影响主链路
                }
              }
            }
          } catch {
            // ignore malformed SSE data
          }
        }
      }

      // Drain remaining buffer
      if (sseBuf.trim()) {
        const lines = sseBuf.split("\n");
        let dataStr = "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            dataStr = line.slice(6);
          }
        }
        if (dataStr && dataStr !== "[DONE]") {
          try {
            const evt = JSON.parse(dataStr) as Record<string, unknown>;
            if (evt.type === "message_delta" && evt.usage) {
              Object.assign(usage, evt.usage as Record<string, unknown>);
            }
          } catch {
            // ignore
          }
        }
      }
    } catch (err: unknown) {
      pipe.error("STREAM", err);
    }

    await completeStream();
  })().catch((err: unknown) => {
    pipe.error("STREAM_CONSUME", err);
  });
}
