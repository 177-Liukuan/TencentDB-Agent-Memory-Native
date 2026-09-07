/**
 * memory-bridge — reverse proxy for `<proxy>/memory-bridge/v3/*` → tdai gateway.
 *
 * 作为独立可信调用边界以及 Native Dispatcher 的协议无关执行边界：
 * bridge 强制注入 session IdFields + serviceToken 鉴权后转发到 tdai，
 * 但不通过模型提示暴露 HTTP 调用指南。
 *
 * 行为：
 *   1. 路径必须是 /memory-bridge/v3/{sub} ；sub 在 ALLOWED_SUBPATHS 内
 *   2. 强制 POST + Content-Type application/json
 *   3. 必须能识别 session（x-conversation-id / x-session-id ...），否则 401
 *   4. body 里 team_id/user_id/agent_id/session_id 一律被 session 值覆盖（防伪造）
 *   5. 转发到 ${coreSkill.endpoint}/v3/{sub}，添加 Bearer + service-id 头
 *   6. 透传 status 和 JSON body
 *
 * 安全：
 *   - allowlist 限定只有 search / read 类只读 subpath；mutation 走主链路
 *   - 不接受 atomic/update / scenario/write / core/write 等写操作
 *   - v3 strict isolation: 强制注入 session_id，满足 L0/L1 必填要求
 */

import type { Context } from "hono";
import { getSessionStore } from "../session/store.js";
import type { BindingRepo } from "../db/binding-repo.js";
import type { ProxyConfig } from "../types.js";
import { getMetadataClient } from "../meta/client.js";
import type { AgentContext } from "../injection/types.js";
import { resolveFixedAssetCtxs, type FixedAssetCtx } from "../injection/injectors/tdai-fixed-asset.js";
import type { TdaiIdentity } from "../tdai/types.js";
import { emitBridgeToolCallTelemetry, agentSourceFromSessionKey } from "./bridge-telemetry.js";
import { observeToolRequest } from "./tool-observation.js";

const TAG = "[memory-bridge]";

/**
 * 允许通过 bridge 转发的 tdai 子路径（只读）。
 *
 * 设计取舍：
 *   - L0/L1 不再每轮自动召回，改为静态工具按需检索（cache 友好），因此放行
 *     atomic/* 与 conversation/* 的 search/query。
 *   - L2：system 给索引 `<l2_scene_index>`，正文按需读 → 放行 scenario/ls + scenario/read。
 *   - L3（persona）：直接注入 system，无需工具 → **不放行** core/read。
 *
 * 写操作（write / rm / add / update / delete）一律不在 allowlist 里；写入走主链路。
 */
const ALLOWED_SUBPATHS = new Set<string>([
  "atomic/search",        // L1 原子记忆 hybrid search
  "atomic/query",         // L1 按 type/时间/分页
  "conversation/search",  // L0 对话 hybrid search
  "conversation/query",   // L0 按 session 取历史
  "scenario/ls",          // L2 场景列表（path 索引）
  "scenario/read",        // L2 按 path 读全文
]);

export interface MemoryBridgeSessionIdentity {
  user_id: string;
  team_id: string;
  agent_id: string;
  session_id: string;
  task_id?: string;
  user_key?: string;
  /**
   * Kernel tenant/instance ID for `x-tdai-service-id`. Extracted from
   * `SessionInfo.space_id`（原本来自请求路径 `/{agent}/{spaceId}/...`）。
   * 用它做 tenant 路由是正确形态；`config.tdai.serviceId` /
   * `config.coreSkill.serviceId` 只作为老 session（迁移前缓存）的兜底。
   */
  space_id?: string;
  /**
   * Composite key actually used to load state from SessionStore
   * (`${agentSource}:${sessionId}`). 用于埋点侧对齐 session_init_logs 的
   * session_key —— 埋点不能猜前缀，必须用真实命中的 key。
   */
  composite_key?: string;
}

type SessionIdFields = MemoryBridgeSessionIdentity;

/**
 * HTTP bridge caller supplies two routing headers:
 *   - x-conversation-id → sessionId
 *   - x-tdai-service-id → spaceId
 *
 * 不再吃 Authorization。见 docs/design/2026-08-03-binding-flatten.md。
 */
function deriveSessionId(c: Context): string | null {
  return (
    c.req.header("x-conversation-id") ??
    c.req.header("x-session-id") ??
    c.req.header("x-chat-id") ??
    c.req.header("x-thread-id") ??
    c.req.header("x-claude-code-session-id") ??
    null
  );
}

function toIdFields(
  state: import("../session/types.js").SessionInitState | undefined,
  compositeKey: string,
): SessionIdFields | null {
  if (!state || state.status !== "initialized" || !state.sessionInfo) return null;
  const s = state.sessionInfo;
  if (!s.user_id || !s.team_id || !s.agent_id || !s.session_id) return null;
  return {
    user_id: s.user_id,
    team_id: s.team_id,
    agent_id: s.agent_id,
    session_id: s.session_id,
    task_id: s.task_id,
    user_key: s.user_key,
    space_id: s.space_id,
    composite_key: compositeKey,
  };
}

function bindingToIdFields(
  binding: import("../db/binding-repo.js").SessionBinding,
  spaceId: string,
  sessionId: string,
): SessionIdFields | null {
  if (binding.outcome !== "initialized") return null;
  if (!binding.userId || !binding.teamId || !binding.agentId) return null;
  const agentSource = binding.agentSource || "claude-code";
  return {
    user_id: binding.userId,
    team_id: binding.teamId,
    agent_id: binding.agentId,
    session_id: sessionId,
    task_id: binding.taskId,
    user_key: binding.userKey,
    space_id: spaceId,
    composite_key: `${agentSource}:${sessionId}`,
  };
}

/**
 * L1 fast path — try in-memory Map with prefix fallback.
 * Returns null on miss (caller decides whether to probe L2).
 */
function loadSessionIdsL1(
  sessionId: string,
  store = getSessionStore(),
): SessionIdFields | null {
  // handler 层存的 L1 key 形如 `${agentSource}:${sessionId}`; bridge caller 拿到的
  // 通常是 bare sessionId。按候选前缀顺序探,命中即返回。
  const candidates = sessionId.includes(":")
    ? [sessionId]
    : [sessionId, `codebuddy:${sessionId}`, `claude-code:${sessionId}`];
  for (const k of candidates) {
    const state = store.get(k);
    if (state) {
      const fields = toIdFields(state, k);
      if (fields) return fields;
    }
  }
  return null;
}

/**
 * L2 fallthrough —— 拍平后只吃 (spaceId, sessionId)。见
 * docs/design/2026-08-03-binding-flatten.md。
 *
 * 不再走 verifyUserKey + getOrRecover 4 段路径:
 *   1) bridge request 不依赖 bearer，verify 路径拿不到 userId
 *   2) 拍平后 binding.json 里已经存了 user_id/team_id/agent_id/agent_source/user_key,
 *      单次 GET 直接凑齐 IdFields
 */
async function loadSessionIdsL2(
  bindingRepo: BindingRepo | null,
  spaceId: string,
  sessionId: string,
): Promise<SessionIdFields | null> {
  if (!bindingRepo) return null;
  try {
    const binding = await bindingRepo.getBinding(spaceId, sessionId);
    if (!binding) return null;
    return bindingToIdFields(binding, spaceId, sessionId);
  } catch (err) {
    console.warn(`${TAG} L2 getBinding error space=${spaceId} sid=${sessionId}: ${(err as Error).message}`);
    return null;
  }
}

function envelope(code: number, message: string, httpStatus = 200): Response {
  return new Response(
    JSON.stringify({ code, message, request_id: `mem-bridge-${Date.now()}` }),
    { status: httpStatus, headers: { "content-type": "application/json" } },
  );
}

function extractSubpath(path: string): string | null {
  const m = path.match(/^\/memory-bridge\/v3\/(.+)$/);
  if (!m) return null;
  return m[1].replace(/\/+$/, "");
}

function selfCtx(ids: SessionIdFields): FixedAssetCtx {
  return { teamId: ids.team_id, userId: ids.user_id, agentId: ids.agent_id, agentName: ids.agent_id, isSelf: true };
}

async function resolveMemoryCtxs(config: ProxyConfig, ids: SessionIdFields, sessionKey: string): Promise<FixedAssetCtx[]> {
  if (!ids.user_key) return [selfCtx(ids)];
  try {
    const serviceId = ids.space_id || config.tdai?.serviceId || config.coreSkill.serviceId;
    const metadataClient = getMetadataClient(config.coreSkill, serviceId, ids.user_key);
    const identity: TdaiIdentity = {
      teamId: ids.team_id,
      userId: ids.user_id,
      agentId: ids.agent_id,
      sessionId: ids.session_id,
      taskId: ids.task_id,
      userKey: ids.user_key,
    };
    const fakeCtx: AgentContext = {
      messages: [],
      tools: [],
      requestParams: {},
      metadata: {
        protocol: "anthropic",
        traceId: `memory-bridge:${sessionKey}`,
        keyId: sessionKey,
        modelId: "memory-bridge",
        stream: false,
        agentSource: "memory-bridge",
        custom: { session: ids, userKey: ids.user_key },
      },
    };
    return await resolveFixedAssetCtxs(fakeCtx, identity, metadataClient);
  } catch (err) {
    console.warn(`${TAG} fixed asset ctx resolve failed: ${(err as Error).message}`);
    return [selfCtx(ids)];
  }
}

function selectTargetCtx(ctxs: FixedAssetCtx[], requestedAgentId: unknown): FixedAssetCtx {
  if (typeof requestedAgentId === "string" && requestedAgentId.trim()) {
    const found = ctxs.find((ctx) => ctx.agentId === requestedAgentId.trim());
    if (found) return found;
  }
  return ctxs.find((ctx) => ctx.isSelf) ?? ctxs[0];
}

const MULTI_SEARCH_SUBPATHS = new Set(["atomic/search", "conversation/search"]);

function limitFromBody(body: Record<string, unknown>, fallback = 5): number {
  const n = typeof body.limit === "number" ? body.limit : fallback;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 50) : fallback;
}

export interface MemoryBridgeDeps {
  fetcher?: typeof fetch;
  now?: () => number;
  loadSessionIdentity?: (input: {
    config: ProxyConfig;
    sessionId: string;
    spaceId: string;
  }) => Promise<MemoryBridgeSessionIdentity | null>;
  resolveMemoryContexts?: (
    config: ProxyConfig,
    identity: MemoryBridgeSessionIdentity,
    sessionKey: string,
  ) => Promise<FixedAssetCtx[]>;
  emitTelemetry?: typeof emitBridgeToolCallTelemetry;
}

export interface MemoryBridgeExecutionInput {
  /** Native 自动重试继续使用原调用 ID，供评测去重。HTTP 调用不提供此值。 */
  callId?: string;
  config: ProxyConfig;
  subpath: string;
  body: Record<string, unknown>;
  sessionId: string;
  spaceId?: string;
  signal?: AbortSignal;
}

export interface MemoryBridgeExecutionResult {
  status: number;
  text: string;
  contentType: string;
}

function executionEnvelope(
  code: number,
  message: string,
  httpStatus: number,
  now: () => number,
): MemoryBridgeExecutionResult {
  return {
    status: httpStatus,
    contentType: "application/json",
    text: JSON.stringify({ code, message, request_id: `mem-bridge-${now()}` }),
  };
}

async function loadDefaultSessionIdentity(input: {
  config: ProxyConfig;
  sessionId: string;
  spaceId: string;
}): Promise<MemoryBridgeSessionIdentity | null> {
  const store = getSessionStore();
  let ids = loadSessionIdsL1(input.sessionId, store);
  const bindingRepo = store.getBindingRepo() ?? null;
  if (!ids && bindingRepo && input.spaceId) {
    console.log(`${TAG} session=${input.sessionId} L1 miss → L2 binding lookup (space=${input.spaceId})`);
    ids = await loadSessionIdsL2(bindingRepo, input.spaceId, input.sessionId);
  }
  return ids;
}

/**
 * Protocol-independent read-only Memory Bridge executor. Both the Hono route
 * and Native Proxy Tool dispatcher enter through this boundary so identity,
 * authorization, imported-agent fan-out, response mapping, and telemetry stay
 * identical without a localhost HTTP round trip.
 */
export async function executeMemoryBridge(
  input: MemoryBridgeExecutionInput,
  deps: MemoryBridgeDeps = {},
): Promise<MemoryBridgeExecutionResult> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const sub = input.subpath.replace(/^\/+|\/+$/g, "");
  if (!ALLOWED_SUBPATHS.has(sub)) {
    return executionEnvelope(
      40301,
      `${TAG} subpath '${sub}' not allowed via bridge`,
      403,
      now,
    );
  }

  const spaceId = input.spaceId
    ?? input.config.tdai?.serviceId
    ?? input.config.coreSkill?.serviceId
    ?? "";
  observeToolRequest(input.config, { sessionId: input.sessionId, family: "memory", subpath: sub, callId: input.callId });
  const loadIdentity = deps.loadSessionIdentity ?? loadDefaultSessionIdentity;
  const ids = await loadIdentity({
    config: input.config,
    sessionId: input.sessionId,
    spaceId,
  });
  if (!ids) {
    return executionEnvelope(
      40101,
      `${TAG} session not initialized; cannot derive identity`,
      401,
      now,
    );
  }

  const inboundBody = input.body;
  // session_id 是历史查询条件，不是当前执行会话的身份；未指定时应允许跨会话检索。
  // 当前会话仍用于身份解析、工具状态和埋点，不能随查询目标一起切换。
  const { session_id: requestedSessionId, ...queryBody } = inboundBody;
  const querySessionId = typeof requestedSessionId === "string" ? requestedSessionId.trim() : "";

  const upstreamUrl = `${input.config.coreSkill.endpoint.replace(/\/$/, "")}/v3/${sub}`;
  const upstreamToken =
    input.config.tdai?.apiKey || input.config.coreSkill.serviceToken || "local-proxy";
  const upstreamServiceId =
    ids.space_id || input.config.tdai?.serviceId || input.config.coreSkill.serviceId;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${upstreamToken}`,
    "x-tdai-service-id": upstreamServiceId,
    "Content-Type": "application/json",
  };

  const resolveContexts = deps.resolveMemoryContexts ?? resolveMemoryCtxs;
  const ctxs = await resolveContexts(input.config, ids, input.sessionId);
  const makeOutbound = (target: FixedAssetCtx): Record<string, unknown> => ({
    ...queryBody,
    user_id: target.userId,
    team_id: target.teamId,
    agent_id: target.agentId,
    ...(querySessionId ? { session_id: querySessionId } : {}),
    ...(ids.task_id ? { task_id: ids.task_id } : {}),
  });
  const fetcher = deps.fetcher ?? globalThis.fetch.bind(globalThis);
  const emitTelemetry = deps.emitTelemetry ?? emitBridgeToolCallTelemetry;

  const callUpstream = async (
    target: FixedAssetCtx,
  ): Promise<{ status: number; text: string; contentType: string }> => {
    const outboundBody = JSON.stringify(makeOutbound(target));
    const callStart = now();
    let status = 0;
    let text = "";
    let contentType = "application/json";
    try {
      const resp = await fetcher(upstreamUrl, {
        method: "POST",
        headers,
        body: outboundBody,
        signal: input.signal
          ?? AbortSignal.timeout(Math.max(5_000, input.config.coreSkill.timeoutMs * 4)),
      });
      status = resp.status;
      text = await resp.text().catch(() => "");
      contentType = resp.headers.get("content-type") ?? "application/json";
      return { status, text, contentType };
    } finally {
      const emitKey = ids.composite_key ?? input.sessionId;
      emitTelemetry({
        sessionKey: emitKey,
        spaceId: ids.space_id,
        userId: target.userId,
        teamId: target.teamId,
        agentId: target.agentId,
        agentSource: agentSourceFromSessionKey(emitKey),
        bridgeSource: "memory-bridge",
        executedEndpoint: sub,
        requestBody: outboundBody.slice(0, 512),
        upstreamStatus: status,
        elapsedMs: now() - callStart,
      });
    }
  };

  if (MULTI_SEARCH_SUBPATHS.has(sub) && typeof inboundBody.agent_id !== "string") {
    const limit = limitFromBody(inboundBody);
    const isConversationSearch = sub === "conversation/search";
    const resultKey: "items" | "messages" = isConversationSearch ? "messages" : "items";
    const settled = await Promise.allSettled(
      ctxs.map(async (target) => ({ target, ...(await callUpstream(target)) })),
    );
    const collected: Record<string, unknown>[] = [];
    let okCount = 0;
    for (const result of settled) {
      if (
        result.status !== "fulfilled"
        || result.value.status < 200
        || result.value.status >= 300
      ) continue;
      okCount++;
      try {
        const env = JSON.parse(result.value.text) as {
          data?: { items?: unknown[]; messages?: unknown[] };
        };
        const rows = (isConversationSearch ? env.data?.messages : env.data?.items) ?? [];
        for (const item of rows) {
          if (!item || typeof item !== "object") continue;
          collected.push({
            ...(item as Record<string, unknown>),
            source_agent_id: result.value.target.agentId,
            source_agent_name: result.value.target.agentName,
            source_agent_role: result.value.target.isSelf ? "self" : "imported_from",
          });
        }
      } catch {
        // A malformed response from one imported source does not discard the
        // other independently authorized search results.
      }
    }
    collected.sort(
      (a, b) => (typeof b.score === "number" ? b.score : 0)
        - (typeof a.score === "number" ? a.score : 0),
    );
    console.log(
      `${TAG} sub=${sub} multi targets=${ctxs.length} ok=${okCount} ${resultKey}=${collected.length} elapsed=${now() - t0}ms`,
    );
    if (okCount === 0) {
      return executionEnvelope(
        50301,
        `${TAG} upstream unavailable`,
        502,
        now,
      );
    }
    const searchedAgents = ctxs.map((ctx) => ({
      agent_id: ctx.agentId,
      name: ctx.agentName,
      role: ctx.isSelf ? "self" : "imported_from",
    }));
    const responseData: Record<string, unknown> = isConversationSearch
      ? { messages: collected.slice(0, limit), searched_agents: searchedAgents }
      : { items: collected.slice(0, limit), searched_agents: searchedAgents };
    return {
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({
        code: 0,
        message: "ok",
        request_id: `mem-bridge-${now()}`,
        data: responseData,
      }),
    };
  }

  let upstream: { status: number; text: string; contentType: string };
  try {
    upstream = await callUpstream(selectTargetCtx(ctxs, inboundBody.agent_id));
  } catch (err) {
    console.warn(`${TAG} upstream fetch failed sub=${sub} err=${(err as Error).message}`);
    return executionEnvelope(
      50301,
      `${TAG} upstream unavailable`,
      502,
      now,
    );
  }

  console.log(`${TAG} sub=${sub} status=${upstream.status} elapsed=${now() - t0}ms`);
  return upstream;
}

export function createMemoryBridgeHandler(
  config: ProxyConfig,
  deps: MemoryBridgeDeps = {},
): (c: Context) => Promise<Response> {
  return async (c: Context): Promise<Response> => {
    const path = new URL(c.req.url).pathname;
    const sub = extractSubpath(path);
    if (!sub) {
      return envelope(40401, `${TAG} unknown path ${path}`, 404);
    }
    if (!ALLOWED_SUBPATHS.has(sub)) {
      return envelope(40301, `${TAG} subpath '${sub}' not allowed via bridge`, 403);
    }
    if (c.req.method !== "POST") {
      return envelope(40501, `${TAG} method ${c.req.method} not allowed`, 405);
    }

    const ct = c.req.header("content-type") ?? "";
    if (!ct.toLowerCase().includes("application/json")) {
      return envelope(41501, `${TAG} content-type must be application/json`, 415);
    }

    const sessionKey = deriveSessionId(c);
    if (!sessionKey) {
      return envelope(40101, `${TAG} missing x-conversation-id (or x-session-id / x-chat-id / x-thread-id) header`, 401);
    }
    const spaceId = c.req.header("x-tdai-service-id")
      ?? config.tdai?.serviceId
      ?? config.coreSkill?.serviceId
      ?? "";
    let inboundBody: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw && raw.trim()) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          inboundBody = parsed as Record<string, unknown>;
        } else {
          return envelope(40001, `${TAG} body must be a JSON object`, 400);
        }
      }
    } catch (err) {
      return envelope(40001, `${TAG} invalid JSON body: ${(err as Error).message}`, 400);
    }

    const result = await executeMemoryBridge({
      config,
      subpath: sub,
      body: inboundBody,
      sessionId: sessionKey,
      spaceId,
    }, deps);
    return new Response(result.text, {
      status: result.status,
      headers: {
        "content-type": result.contentType,
      },
    });
  };
}
