import type { ProxyConfig } from "../types.js";
import {
  buildUpstreamRequestSnapshot,
  createRestartExactTargetTransport,
  createRetainedExactTargetTransport,
} from "./exact-target-transport.js";
import {
  settleClientToolReentry,
  resumeClientToolResults,
} from "./client-tool-resume.js";
import { ResponsesToolLoopCoordinator } from "./responses-tool-loop-coordinator.js";
import { getNativeProxyToolRuntime } from "./runtime.js";
import type { JsonValue, PersistedForwardTarget, ToolExecutionScope } from "./types.js";

export interface ResponsesNativeRequestContext {
  signal?: AbortSignal;
  scope: ToolExecutionScope;
  turnSeq: number;
  originalInput: JsonValue[];
}

function streamFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

function hasInjectedDefinition(body: Record<string, unknown>, owns: (name: string) => boolean): boolean {
  return Array.isArray(body.tools) && body.tools.some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const tool = value as Record<string, unknown>;
    return tool.type === "function" && typeof tool.name === "string" && owns(tool.name);
  });
}

/**
 * Consume the successful upstream Responses SSE exactly once when Native
 * definitions were sent. Returns null for ordinary/client/provider-only rounds.
 */
export async function runResponsesNativeToolLoop(input: {
  config: ProxyConfig;
  body: Record<string, unknown>;
  upstreamResponse: Response;
  upstreamUrl: string;
  upstreamHeaders: Record<string, string>;
  model: string;
  authSource: PersistedForwardTarget["authSource"];
  request: ResponsesNativeRequestContext | null;
}): Promise<Response | null> {
  if (!input.request || !input.config.nativeProxyTools.enabled || input.body.stream !== true || !input.upstreamResponse.body) return null;
  const runtime = getNativeProxyToolRuntime(input.config);
  if (!hasInjectedDefinition(input.body, (name) => runtime.registry.owns(name))) return null;
  await runtime.ready();
  if (!runtime.storage || !runtime.dispatcher) throw new Error("Native Proxy Tool runtime is unavailable");

  const snapshot = buildUpstreamRequestSnapshot({
    protocol: "responses",
    clientProtocol: "responses",
    body: input.body,
    url: input.upstreamUrl,
    model: input.model,
    authSource: input.authSource,
    logicalBaseMessages: input.request.originalInput,
  });
  const reenter = createRetainedExactTargetTransport({
    capturedSnapshot: snapshot,
    headers: input.upstreamHeaders,
    timeoutMs: input.config.server.forwardTimeoutMs ?? 600_000,
  });
  const coordinator = new ResponsesToolLoopCoordinator({
    signal: input.request.signal,
    registry: runtime.registry,
    storage: runtime.storage,
    dispatcher: runtime.dispatcher,
    limits: input.config.nativeProxyTools,
    reenter,
    trackBackgroundOperation: (operation) => runtime.trackBackgroundOperation(operation),
  });
  const decision = await runtime.runOperation(() => coordinator.handleRound({
    stream: input.upstreamResponse.body!,
    status: input.upstreamResponse.status,
    headers: input.upstreamResponse.headers,
    scope: input.request!.scope,
    turnSeq: input.request!.turnSeq,
    upstreamSnapshot: snapshot,
    round: 1,
    totalCalls: 0,
  }));
  if (decision.kind === "client_dispatch") runtime.retainExactTarget(decision.stateKey, reenter);
  return new Response(streamFrom(decision.bytes), { status: decision.status, headers: decision.headers });
}

export function buildResponsesNativeRequestContext(input: {
  signal?: AbortSignal;
  config: ProxyConfig;
  spaceId: string;
  userId: string;
  agentSource: string;
  sessionId: string;
  sessionInfo?: Record<string, unknown> | null;
  turnSeq: number;
  eligible: boolean;
  originalInput?: readonly JsonValue[];
}): ResponsesNativeRequestContext | null {
  if (!input.eligible || !input.config.nativeProxyTools.enabled) return null;
  const sessionSpace = typeof input.sessionInfo?.space_id === "string" ? input.sessionInfo.space_id : "";
  const sessionUser = typeof input.sessionInfo?.user_id === "string" ? input.sessionInfo.user_id : "";
  return {
    signal: input.signal,
    turnSeq: input.turnSeq,
    originalInput: structuredClone([...(input.originalInput ?? [])]),
    scope: {
      spaceId: sessionSpace || input.spaceId || input.config.tdai.serviceId || input.config.coreSkill.serviceId,
      userId: sessionUser || input.userId || "anonymous",
      agentSource: input.agentSource,
      sessionId: input.sessionId,
      contextVersion: "v1",
    },
  };
}

/** Resume a persisted mixed Responses batch before ordinary injection/routing. */
export async function resumeResponsesNativeToolLoop(input: {
  config: ProxyConfig;
  body: Record<string, unknown>;
  request: ResponsesNativeRequestContext | null;
  model: string;
  agentSource: string;
  requestPath: string;
  sessionId: string;
  currentRequestHeaders: Record<string, string>;
}): Promise<Response | null> {
  if (!input.request || !input.config.nativeProxyTools.enabled || !Array.isArray(input.body.input)) return null;
  const runtime = getNativeProxyToolRuntime(input.config);
  await runtime.ready();
  if (!runtime.storage || !runtime.dispatcher) throw new Error("Native Proxy Tool runtime is unavailable");
  const restart = createRestartExactTargetTransport({
    config: input.config,
    currentModel: input.model,
    agentSource: input.agentSource,
    requestPath: input.requestPath,
    sessionId: input.sessionId,
    currentRequestHeaders: input.currentRequestHeaders,
    timeoutMs: input.config.server.forwardTimeoutMs ?? 600_000,
  });
  let selected = restart;
  // Responses 客户端当前只使用短期运行状态续接混合调用；Claude Hook 驱动的长期历史恢复仅接在 Anthropic 入口。
  const resume = await runtime.runOperation(() => resumeClientToolResults({
    signal: input.request!.signal,
    body: input.body,
    scope: input.request!.scope,
    storage: runtime.storage!,
    dispatcher: runtime.dispatcher!,
    limits: input.config.nativeProxyTools,
    reenter: async (request, stateKey) => {
      selected = runtime.getRetainedExactTarget(stateKey) ?? restart;
      return selected(request);
    },
  }));
  if (resume.kind === "not_applicable") return null;
  if (resume.kind === "error") {
    return new Response(JSON.stringify({ error: { type: "invalid_request_error", code: resume.code, message: resume.message } }), {
      status: resume.status, headers: { "content-type": "application/json" },
    });
  }
  if (resume.kind === "replay") {
    return new Response(streamFrom(resume.bytes), { status: resume.status, headers: resume.headers });
  }

  const coordinator = new ResponsesToolLoopCoordinator({
    signal: input.request.signal,
    registry: runtime.registry,
    storage: runtime.storage,
    dispatcher: runtime.dispatcher,
    limits: input.config.nativeProxyTools,
    reenter: selected,
    trackBackgroundOperation: (operation) => runtime.trackBackgroundOperation(operation),
  });
  const decision = await runtime.runOperation(() => coordinator.handleRound({
    ...resume.upstreamRound,
    scope: input.request!.scope,
    turnSeq: resume.turnSeq,
    upstreamSnapshot: resume.upstreamSnapshot,
    round: resume.round,
    totalCalls: resume.totalCalls,
    parentStateKey: resume.stateKey,
    parentReentryAttempt: resume.reentryAttempt,
  }));
  if (decision.kind === "client_dispatch") runtime.retainExactTarget(decision.stateKey, selected);
  const retryable = await settleClientToolReentry(
    runtime.storage,
    resume.stateKey,
    resume.reentryLeaseOwner,
    decision,
    resume.round,
  );
  if (!retryable) runtime.releaseExactTarget(resume.stateKey);
  return new Response(streamFrom(decision.bytes), { status: decision.status, headers: decision.headers });
}
