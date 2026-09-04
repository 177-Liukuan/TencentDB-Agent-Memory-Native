import type { BindingRepo, SessionBinding } from "../db/binding-repo.js";
import { getSessionStore } from "../session/store.js";
import type { SessionInitState } from "../session/types.js";
import type { ProxyConfig } from "../types.js";
import type { JsonValue } from "../native-proxy-tools/types.js";
import {
  getCoreKnowledgeClient,
  type KnowledgeItem,
} from "./core-client.js";

const TAG = "[knowledge-tool-executor]";

export interface KnowledgeToolSessionIdentity {
  user_id: string;
  team_id: string;
  agent_id: string;
  session_id: string;
  user_key: string;
  space_id?: string;
  agent_source: string;
}

export interface KnowledgeToolExecutionInput {
  config: ProxyConfig;
  route: string;
  body: Record<string, JsonValue>;
  sessionId: string;
  spaceId: string;
  agentSource: string;
  userId?: string;
  signal?: AbortSignal;
}

export interface KnowledgeToolExecutionResult {
  status: number;
  text: string;
  contentType: string;
}

export interface KnowledgeToolExecutorDeps {
  fetcher?: typeof fetch;
  now?: () => number;
  loadSessionIdentity?: (input: {
    sessionId: string;
    spaceId: string;
    agentSource: string;
  }) => Promise<KnowledgeToolSessionIdentity | null>;
  resolveAuthorizedResources?: (
    config: ProxyConfig,
    identity: KnowledgeToolSessionIdentity,
  ) => Promise<KnowledgeItem[]>;
}

interface DynamicParamDefinition {
  type?: unknown;
  required?: unknown;
  enum?: unknown;
}

interface DynamicToolDefinition {
  name?: unknown;
  params?: unknown;
}

function result(
  status: number,
  code: number,
  message: string,
  now: () => number,
): KnowledgeToolExecutionResult {
  return {
    status,
    contentType: "application/json",
    text: JSON.stringify({ code, message, request_id: `knowledge-tool-${now()}` }),
  };
}

function stateIdentity(
  state: SessionInitState | undefined,
  matchedKey: string,
): KnowledgeToolSessionIdentity | null {
  const session = state?.sessionInfo;
  if (state?.status !== "initialized" || !session?.user_id || !session.team_id
    || !session.agent_id || !session.session_id || !session.user_key) return null;
  const separator = matchedKey.indexOf(":");
  return {
    user_id: session.user_id,
    team_id: session.team_id,
    agent_id: session.agent_id,
    session_id: session.session_id,
    user_key: session.user_key,
    space_id: session.space_id,
    agent_source: separator > 0 ? matchedKey.slice(0, separator) : "claude-code",
  };
}

function bindingIdentity(
  binding: SessionBinding,
  spaceId: string,
  sessionId: string,
): KnowledgeToolSessionIdentity | null {
  if (binding.outcome !== "initialized" || !binding.userId || !binding.teamId
    || !binding.agentId || !binding.userKey) return null;
  return {
    user_id: binding.userId,
    team_id: binding.teamId,
    agent_id: binding.agentId,
    session_id: sessionId,
    user_key: binding.userKey,
    space_id: spaceId,
    agent_source: binding.agentSource || "claude-code",
  };
}

async function loadDefaultSessionIdentity(input: {
  sessionId: string;
  spaceId: string;
  agentSource: string;
}): Promise<KnowledgeToolSessionIdentity | null> {
  const store = getSessionStore();
  const candidates = input.sessionId.includes(":")
    ? [input.sessionId]
    : [
        `${input.agentSource}:${input.sessionId}`,
        input.sessionId,
        `claude-code:${input.sessionId}`,
        `codebuddy:${input.sessionId}`,
        `codex:${input.sessionId}`,
        `workbuddy:${input.sessionId}`,
      ];
  for (const key of [...new Set(candidates)]) {
    const identity = stateIdentity(store.get(key), key);
    if (identity) return identity;
  }
  return loadBindingIdentity(store.getBindingRepo(), input.spaceId, input.sessionId);
}

async function loadBindingIdentity(
  repo: BindingRepo | undefined,
  spaceId: string,
  sessionId: string,
): Promise<KnowledgeToolSessionIdentity | null> {
  if (!repo || !spaceId) return null;
  try {
    const binding = await repo.getBinding(spaceId, sessionId);
    return binding ? bindingIdentity(binding, spaceId, sessionId) : null;
  } catch (error) {
    console.warn(`${TAG} binding lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function resolveDefaultAuthorizedResources(
  config: ProxyConfig,
  identity: KnowledgeToolSessionIdentity,
): Promise<KnowledgeItem[]> {
  const client = getCoreKnowledgeClient(config.knowledge);
  const options = { serviceId: identity.space_id || config.knowledge.serviceId };
  const ids = await client.listAgentKnowledgeIds(identity.agent_id, identity.user_key, options);
  if (ids.length === 0) return [];
  const allowed = new Set(ids);
  const resources = await client.listKnowledgeByIds(identity.team_id, ids, options);
  return resources.filter((item) => (
    item.team_id === identity.team_id
    && allowed.has(item.knowledge_id)
    && (item.type === "wiki" || item.type === "code-graph")
  ));
}

function providerUrl(serviceUrl: string, route: "tools/list" | "tools/call"): string | null {
  try {
    const base = new URL(serviceUrl.endsWith("/") ? serviceUrl : `${serviceUrl}/`);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password
      || base.search || base.hash) return null;
    return new URL(route, base).toString();
  } catch {
    return null;
  }
}

async function callProvider(input: {
  fetcher: typeof fetch;
  url: string;
  body: Record<string, unknown>;
  identity: KnowledgeToolSessionIdentity;
  config: ProxyConfig;
  signal?: AbortSignal;
}): Promise<KnowledgeToolExecutionResult> {
  const serviceId = input.identity.space_id || input.config.knowledge.serviceId;
  const response = await input.fetcher(input.url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${input.config.knowledge.serviceToken}`,
      "Content-Type": "application/json",
      "x-tdai-service-id": serviceId,
      "x-conversation-id": input.identity.session_id,
      "x-tdai-user-id": input.identity.user_id,
      "x-tdai-team-id": input.identity.team_id,
      "x-tdai-agent-id": input.identity.agent_id,
      "x-tdai-agent-source": input.identity.agent_source,
      "x-tdai-space-id": serviceId,
    },
    body: JSON.stringify(input.body),
    signal: input.signal,
  });
  return {
    status: response.status,
    text: await response.text().catch(() => ""),
    contentType: response.headers.get("content-type") ?? "application/json",
  };
}

function parseToolList(response: KnowledgeToolExecutionResult): {
  ok: true;
  tools: DynamicToolDefinition[];
} | { ok: false } {
  if (response.status < 200 || response.status >= 300) return { ok: false };
  try {
    const envelope = JSON.parse(response.text) as {
      code?: unknown;
      data?: { tools?: unknown };
    };
    return envelope.code === 0 && Array.isArray(envelope.data?.tools)
      ? { ok: true, tools: envelope.data.tools as DynamicToolDefinition[] }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return isPlainObject(value);
    default: return false;
  }
}

/** 下游工具定义是动态的，因此在真正执行前按刚取回的参数表逐项检查。 */
function validateDynamicParams(
  tool: DynamicToolDefinition,
  params: unknown,
): string | null {
  if (!isPlainObject(params)) return "params must be an object";
  if (Object.keys(params).length > 64 || Buffer.byteLength(JSON.stringify(params), "utf8") > 65_536) {
    return "params exceed the allowed size";
  }
  if (!isPlainObject(tool.params)) return "provider returned an invalid parameter schema";
  const definitions = tool.params as Record<string, DynamicParamDefinition>;
  for (const [name, definition] of Object.entries(definitions)) {
    if (!isPlainObject(definition)) return "provider returned an invalid parameter schema";
    if (definition.required === true && params[name] === undefined) return `${name} is required`;
  }
  for (const [name, value] of Object.entries(params)) {
    const definition = definitions[name];
    if (!definition) return `unknown params field: ${name}`;
    if (!matchesType(value, definition.type)) return `${name} has an invalid type`;
    if (Array.isArray(definition.enum) && !definition.enum.includes(value)) {
      return `${name} must match the provider enum`;
    }
  }
  return null;
}

export async function executeKnowledgeTool(
  input: KnowledgeToolExecutionInput,
  deps: KnowledgeToolExecutorDeps = {},
): Promise<KnowledgeToolExecutionResult> {
  const now = deps.now ?? Date.now;
  if (!input.config.knowledge.enabled || !input.config.knowledge.serviceToken) {
    return result(503, 50300, "Knowledge Native Tool is not configured", now);
  }
  if (input.route !== "tools/list" && input.route !== "tools/call") {
    return result(403, 40300, "Knowledge tool route is not allowed", now);
  }
  const knowledgeId = input.body.knowledge_id;
  if (typeof knowledgeId !== "string" || !knowledgeId) {
    return result(400, 40001, "knowledge_id is required", now);
  }

  const loadIdentity = deps.loadSessionIdentity ?? loadDefaultSessionIdentity;
  const identity = await loadIdentity({
    sessionId: input.sessionId,
    spaceId: input.spaceId,
    agentSource: input.agentSource,
  });
  if (!identity || (input.userId && identity.user_id !== input.userId)) {
    return result(401, 40101, "Session identity is unavailable", now);
  }

  const resolveResources = deps.resolveAuthorizedResources ?? resolveDefaultAuthorizedResources;
  const resources = await resolveResources(input.config, identity);
  const resource = resources.find((item) => item.knowledge_id === knowledgeId);
  if (!resource) return result(403, 40301, "Knowledge resource is not authorized for this Agent", now);

  const listUrl = providerUrl(resource.service_url, "tools/list");
  const callUrl = providerUrl(resource.service_url, "tools/call");
  if (!listUrl || !callUrl) return result(502, 50302, "Knowledge resource target is invalid", now);
  const fetcher = deps.fetcher ?? globalThis.fetch.bind(globalThis);

  try {
    if (input.route === "tools/list") {
      return await callProvider({
        fetcher, url: listUrl, body: { knowledge_id: knowledgeId }, identity,
        config: input.config, signal: input.signal,
      });
    }

    const toolName = input.body.tool_name;
    const params = input.body.params;
    if (typeof toolName !== "string" || !toolName || !isPlainObject(params)) {
      return result(400, 40001, "tool_name and params are required", now);
    }
    const listResponse = await callProvider({
      fetcher, url: listUrl, body: { knowledge_id: knowledgeId }, identity,
      config: input.config, signal: input.signal,
    });
    const list = parseToolList(listResponse);
    if (!list.ok) return result(502, 50303, "Knowledge provider returned an invalid tool list", now);
    const tool = list.tools.find((candidate) => candidate.name === toolName);
    if (!tool) return result(400, 40002, "tool_name is not available for this resource", now);
    const validationError = validateDynamicParams(tool, params);
    if (validationError) return result(400, 40002, validationError, now);

    return await callProvider({
      fetcher,
      url: callUrl,
      body: { knowledge_id: knowledgeId, tool_name: toolName, params },
      identity,
      config: input.config,
      signal: input.signal,
    });
  } catch (error) {
    console.warn(`${TAG} provider request failed: ${error instanceof Error ? error.message : String(error)}`);
    return result(502, 50301, "Knowledge provider is temporarily unavailable", now);
  }
}
