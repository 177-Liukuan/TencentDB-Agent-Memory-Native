import type { Context } from "hono";

import { verifyUserKey } from "../auth.js";
import { apiKeyToKeyId, extractBearerToken } from "../opik.js";
import { applyClaudeContextHook, hookResultBody } from "../native-proxy-tools/claude-context-hooks.js";
import { getNativeProxyToolRuntime } from "../native-proxy-tools/runtime.js";
import type { ProxyConfig } from "../types.js";

/** 接收 Claude Code 官方 Hook；请求体中的身份字段不能替代服务端鉴权结果。 */
export async function handleClaudeContextHook(c: Context, config: ProxyConfig): Promise<Response> {
  if (!config.nativeProxyTools.enabled) return c.json({ error: "native_proxy_tools_disabled" }, 404);
  const spaceId = c.req.param("spaceId") || config.tdai.serviceId || config.coreSkill.serviceId;
  const authorization = c.req.header("authorization") ?? "";
  const userKey = c.req.header("x-tdai-user-key")
    || c.req.header("x-api-key")
    || extractBearerToken(authorization);
  const verified = await verifyUserKey(userKey, spaceId);
  if (verified.rejected) return c.json({ error: "unauthorized", message: verified.rejectReason }, 401);
  const userId = verified.userId
    || c.req.header("x-user-id")
    || c.req.header("x-tdai-user-token")
    || (userKey ? apiKeyToKeyId(userKey) : "anonymous");
  let payload: Record<string, unknown>;
  try { payload = await c.req.json<Record<string, unknown>>(); }
  catch { return c.json({ error: "invalid_json" }, 400); }
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  if (!sessionId) return c.json({ error: "missing_session_id" }, 400);

  const runtime = getNativeProxyToolRuntime(config);
  try {
    await runtime.ready();
    if (!runtime.ledgerStorage) throw new Error("Native Tool ledger unavailable");
    const result = await runtime.runOperation(() => applyClaudeContextHook({
      scope: { spaceId, userId, agentSource: "claude-code", sessionId },
      payload,
      storage: runtime.ledgerStorage!,
    }));
    const resultBody = hookResultBody(result);
    return new Response(resultBody === undefined ? null : JSON.stringify(resultBody), {
      status: result.status,
      headers: result.body ? { "content-type": "application/json" } : undefined,
    });
  } catch {
    return c.json({ error: "native_tool_history_unavailable" }, 503);
  }
}
