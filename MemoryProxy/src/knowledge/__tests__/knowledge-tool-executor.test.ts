import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import {
  executeKnowledgeTool,
  type KnowledgeToolExecutorDeps,
  type KnowledgeToolSessionIdentity,
} from "../knowledge-tool-executor.js";

const identity: KnowledgeToolSessionIdentity = {
  user_id: "user-1",
  team_id: "team-1",
  agent_id: "agent-1",
  session_id: "session-1",
  user_key: "user-key-1",
  space_id: "space-1",
  agent_source: "claude-code",
};

const resource = {
  knowledge_id: "wiki-1",
  type: "wiki" as const,
  service_url: "https://knowledge.example/v3",
  name: "Architecture",
  summary: "Decisions",
  team_id: "team-1",
  user_id: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function config() {
  const value = structuredClone(DEFAULT_CONFIG);
  value.knowledge.enabled = true;
  value.knowledge.endpoint = "https://kernel.example";
  value.knowledge.serviceToken = "server-secret";
  value.knowledge.serviceId = "fallback-space";
  return value;
}

function deps(fetcher: typeof fetch): KnowledgeToolExecutorDeps {
  return {
    fetcher,
    loadSessionIdentity: async () => identity,
    resolveAuthorizedResources: async () => [resource],
    now: () => 1_000,
  };
}

function listEnvelope() {
  return {
    code: 0,
    data: {
      knowledge_id: "wiki-1",
      tools: [
        {
          name: "search",
          description: "search wiki",
          params: {
            query: { type: "string", required: true },
            limit: { type: "integer", required: false, default: 20 },
          },
        },
        { name: "get_info", description: "metadata", params: {} },
      ],
    },
  };
}

describe("executeKnowledgeTool", () => {
  it("resolves the provider URL from the authorized resource and lists its dynamic tools", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(
      JSON.stringify(listEnvelope()),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;

    const result = await executeKnowledgeTool({
      config: config(),
      route: "tools/list",
      body: { knowledge_id: "wiki-1" },
      sessionId: "session-1",
      spaceId: "space-1",
      agentSource: "claude-code",
    }, deps(fetcher));

    expect(String((fetcher as any).mock.calls[0][0])).toBe("https://knowledge.example/v3/tools/list");
    const init = (fetcher as any).mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer server-secret");
    expect(new Headers(init.headers).get("x-tdai-service-id")).toBe("space-1");
    expect(JSON.parse(String(init.body))).toEqual({ knowledge_id: "wiki-1" });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toEqual(listEnvelope());
  });

  it("checks the fresh tool list and parameters before calling a provider tool", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/tools/list")) {
        return new Response(JSON.stringify(listEnvelope()), { status: 200 });
      }
      expect(JSON.parse(String(init?.body))).toEqual({
        knowledge_id: "wiki-1",
        tool_name: "search",
        params: { query: "routing", limit: 5 },
      });
      return new Response(JSON.stringify({ code: 0, data: { results: ["doc-1"] } }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await executeKnowledgeTool({
      config: config(),
      route: "tools/call",
      body: {
        knowledge_id: "wiki-1",
        tool_name: "search",
        params: { query: "routing", limit: 5 },
      },
      sessionId: "session-1",
      spaceId: "space-1",
      agentSource: "claude-code",
    }, deps(fetcher));

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String((fetcher as any).mock.calls[1][0])).toBe("https://knowledge.example/v3/tools/call");
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toMatchObject({ code: 0, data: { results: ["doc-1"] } });
  });

  it.each([
    ["unknown tool", { knowledge_id: "wiki-1", tool_name: "delete", params: {} }],
    ["missing required field", { knowledge_id: "wiki-1", tool_name: "search", params: {} }],
    ["wrong field type", { knowledge_id: "wiki-1", tool_name: "search", params: { query: "x", limit: "many" } }],
    ["unknown field", { knowledge_id: "wiki-1", tool_name: "search", params: { query: "x", user_id: "attacker" } }],
  ])("rejects %s before tools/call", async (_case, body) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(listEnvelope()), { status: 200 })) as unknown as typeof fetch;

    const result = await executeKnowledgeTool({
      config: config(), route: "tools/call", body,
      sessionId: "session-1", spaceId: "space-1", agentSource: "claude-code",
    }, deps(fetcher));

    expect(result.status).toBe(400);
    expect(JSON.parse(result.text)).toMatchObject({ code: 40002 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects an unbound knowledge_id without contacting its provider URL", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;

    const result = await executeKnowledgeTool({
      config: config(), route: "tools/list", body: { knowledge_id: "wiki-other" },
      sessionId: "session-1", spaceId: "space-1", agentSource: "claude-code",
    }, deps(fetcher));

    expect(result.status).toBe(403);
    expect(JSON.parse(result.text)).toMatchObject({ code: 40301 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unsafe provider URLs from resource metadata", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const unsafe = deps(fetcher);
    unsafe.resolveAuthorizedResources = async () => [{ ...resource, service_url: "file:///etc/passwd" }];

    const result = await executeKnowledgeTool({
      config: config(), route: "tools/list", body: { knowledge_id: "wiki-1" },
      sessionId: "session-1", spaceId: "space-1", agentSource: "claude-code",
    }, unsafe);

    expect(result.status).toBe(502);
    expect(JSON.parse(result.text)).toMatchObject({ code: 50302 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
