import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import {
  executeMemoryBridge,
  type MemoryBridgeDeps,
  type MemoryBridgeSessionIdentity,
} from "../memory-bridge.js";

const trustedIdentity: MemoryBridgeSessionIdentity = {
  user_id: "user-1",
  team_id: "team-1",
  agent_id: "agent-1",
  session_id: "session-1",
  task_id: "task-1",
  space_id: "space-1",
  composite_key: "claude-code:session-1",
};

function config() {
  const value = structuredClone(DEFAULT_CONFIG);
  value.coreSkill.endpoint = "https://memory.internal";
  value.coreSkill.serviceToken = "service-secret";
  value.coreSkill.serviceId = "configured-space";
  value.coreSkill.timeoutMs = 1_500;
  value.tdai.apiKey = "tdai-secret";
  return value;
}

function deps(overrides: Partial<MemoryBridgeDeps> = {}): MemoryBridgeDeps {
  return {
    loadSessionIdentity: async () => trustedIdentity,
    resolveMemoryContexts: async () => [{
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
      agentName: "Self",
      isSelf: true,
    }],
    emitTelemetry: () => {},
    now: () => 1_000,
    ...overrides,
  };
}

describe("executeMemoryBridge", () => {
  it("overwrites model identity with trusted session identity", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    let upstreamHeaders: HeadersInit | undefined;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      upstreamHeaders = init?.headers;
      return new Response(JSON.stringify({
        code: 0,
        message: "ok",
        request_id: "request-1",
        data: { items: [{ id: "memory-1", content: "rule" }] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await executeMemoryBridge({
      config: config(),
      subpath: "atomic/search",
      body: {
        query: "rules",
        limit: 5,
        user_id: "attacker",
        team_id: "attacker",
        agent_id: "agent-1",
        session_id: "model-session",
        task_id: "model-task",
      },
      sessionId: "session-1",
      spaceId: "space-1",
    }, deps({ fetcher }));

    expect(upstreamBody).toMatchObject({
      query: "rules",
      limit: 5,
      user_id: "user-1",
      team_id: "team-1",
      agent_id: "agent-1",
      session_id: "session-1",
      task_id: "task-1",
    });
    expect(new Headers(upstreamHeaders).get("authorization")).toBe("Bearer tdai-secret");
    expect(new Headers(upstreamHeaders).get("x-tdai-service-id")).toBe("space-1");
    expect(result).toMatchObject({ status: 200, contentType: "application/json" });
    expect(JSON.parse(result.text)).toMatchObject({ data: { items: [{ id: "memory-1" }] } });
  });

  it("fans out Memory search and merges results in score order", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const imported = body.agent_id === "agent-2";
      return new Response(JSON.stringify({
        code: 0,
        data: {
          items: imported
            ? [{ id: "imported", content: "strong", score: 0.9 }]
            : [{ id: "self", content: "weak", score: 0.2 }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await executeMemoryBridge({
      config: config(),
      subpath: "atomic/search",
      body: { query: "rules", limit: 1 },
      sessionId: "session-1",
      spaceId: "space-1",
    }, deps({
      fetcher,
      resolveMemoryContexts: async () => [
        { teamId: "team-1", userId: "user-1", agentId: "agent-1", agentName: "Self", isSelf: true },
        { teamId: "team-1", userId: "user-2", agentId: "agent-2", agentName: "Imported", isSelf: false },
      ],
    }));

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.text)).toMatchObject({
      code: 0,
      data: {
        items: [{
          id: "imported",
          source_agent_id: "agent-2",
          source_agent_name: "Imported",
          source_agent_role: "imported_from",
        }],
        searched_agents: [
          { agent_id: "agent-1", role: "self" },
          { agent_id: "agent-2", role: "imported_from" },
        ],
      },
    });
  });

  it("returns an unavailable error when every fan-out target fails", async () => {
    const result = await executeMemoryBridge({
      config: config(),
      subpath: "atomic/search",
      body: { query: "rules", limit: 5 },
      sessionId: "session-1",
      spaceId: "space-1",
    }, deps({
      fetcher: (async () => { throw new Error("private network detail"); }) as typeof fetch,
      resolveMemoryContexts: async () => [
        { teamId: "team-1", userId: "user-1", agentId: "agent-1", agentName: "Self", isSelf: true },
        { teamId: "team-1", userId: "user-2", agentId: "agent-2", agentName: "Imported", isSelf: false },
      ],
    }));

    expect(result.status).toBe(502);
    expect(JSON.parse(result.text)).toMatchObject({ code: 50301 });
    expect(result.text).not.toContain("private network detail");
  });

  it("rejects an uninitialized Session without contacting upstream", async () => {
    const fetcher = vi.fn();
    const result = await executeMemoryBridge({
      config: config(),
      subpath: "atomic/search",
      body: { query: "rules" },
      sessionId: "missing-session",
      spaceId: "space-1",
    }, deps({ fetcher: fetcher as typeof fetch, loadSessionIdentity: async () => null }));

    expect(result.status).toBe(401);
    expect(JSON.parse(result.text)).toMatchObject({ code: 40101 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a disallowed subpath before resolving identity", async () => {
    const loadSessionIdentity = vi.fn(async () => trustedIdentity);
    const result = await executeMemoryBridge({
      config: config(),
      subpath: "atomic/update",
      body: { content: "malicious" },
      sessionId: "session-1",
      spaceId: "space-1",
    }, deps({ loadSessionIdentity }));

    expect(result.status).toBe(403);
    expect(JSON.parse(result.text)).toMatchObject({ code: 40301 });
    expect(loadSessionIdentity).not.toHaveBeenCalled();
  });

  it("maps an upstream network failure to the existing bridge envelope", async () => {
    const result = await executeMemoryBridge({
      config: config(),
      subpath: "atomic/search",
      body: { query: "rules", agent_id: "agent-1" },
      sessionId: "session-1",
      spaceId: "space-1",
    }, deps({
      fetcher: (async () => {
        throw new Error("connection refused");
      }) as typeof fetch,
    }));

    expect(result.status).toBe(502);
    expect(JSON.parse(result.text)).toMatchObject({ code: 50301 });
  });
});
