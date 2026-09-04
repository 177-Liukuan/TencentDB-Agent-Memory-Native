import { describe, expect, it, vi } from "vitest";

import type { AgentContext } from "../../injection/types.js";
import {
  KnowledgeCatalogInjector,
  renderKnowledgeCatalog,
} from "../../injection/injectors/knowledge-catalog-injector.js";

function context(): AgentContext {
  return {
    messages: [
      { role: "system", blocks: [{ type: "text", content: "system" }] },
      { role: "user", blocks: [{ type: "text", content: "explain the design" }] },
    ],
    requestParams: { stream: true },
    metadata: {
      protocol: "anthropic",
      traceId: "trace-1",
      keyId: "key-1",
      modelId: "model-1",
      stream: true,
      agentSource: "claude-code",
      userId: "user-1",
      spaceId: "space-1",
      sessionKey: "session-1",
      custom: {
        userKey: "user-key-1",
        session: {
          session_id: "session-1",
          team_id: "team-1",
          agent_id: "agent-1",
          user_id: "user-1",
          space_id: "space-1",
        },
        assetCapabilities: { llm_wiki: true, code_graph: true },
      },
    },
  };
}

const resources = [
  {
    knowledge_id: "wiki-1",
    type: "wiki" as const,
    service_url: "https://secret.internal/v3",
    name: "Architecture & Decisions",
    summary: "Design history <and> trade-offs",
    team_id: "team-1",
    user_id: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    knowledge_id: "cg-1",
    type: "code-graph" as const,
    service_url: "https://secret.internal/v3",
    name: "Proxy Graph",
    summary: "counts only",
    team_id: "team-1",
    user_id: null,
    repo_url: "git@github.com:team/proxy.git",
    branch: "main",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
];

describe("KnowledgeCatalogInjector", () => {
  it("renders only authorized resource selection information without transport details", () => {
    const rendered = renderKnowledgeCatalog(resources);

    expect(rendered).toContain("<knowledge_catalog>");
    expect(rendered).toContain('id="wiki-1"');
    expect(rendered).toContain('about="Design history &lt;and&gt; trade-offs"');
    expect(rendered).toContain('match="team/proxy"');
    expect(rendered).toContain("tdai_knowledge_tools_list");
    expect(rendered).toContain("tdai_knowledge_tool_call");
    expect(rendered).not.toMatch(/secret\.internal|service_url|curl|authorization|请求头|x-tdai/i);
  });

  it("loads only resources bound to the current Agent and applies capability filters", async () => {
    const client = {
      listAgentKnowledgeIds: vi.fn(async () => ["wiki-1", "cg-1"]),
      listKnowledgeByIds: vi.fn(async () => resources),
    };
    const injector = new KnowledgeCatalogInjector({
      knowledge: {
        enabled: true,
        endpoint: "https://kernel.example",
        serviceToken: "server-secret",
        serviceId: "fallback-space",
        timeoutMs: 1_500,
      },
    }, client as never);
    const ctx = context();
    (ctx.metadata.custom!.assetCapabilities as Record<string, unknown>).code_graph = false;

    const blocks = await injector.execute(ctx);

    expect(client.listAgentKnowledgeIds).toHaveBeenCalledWith(
      "agent-1",
      "user-key-1",
      { serviceId: "space-1" },
    );
    expect(client.listKnowledgeByIds).toHaveBeenCalledWith(
      "team-1",
      ["wiki-1", "cg-1"],
      { serviceId: "space-1" },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toContain('id="wiki-1"');
    expect(blocks[0].content).not.toContain('id="cg-1"');
  });

  it("fails closed instead of listing every team resource when caller identity is incomplete", async () => {
    const client = {
      listAgentKnowledgeIds: vi.fn(),
      listKnowledgeByIds: vi.fn(),
      listKnowledge: vi.fn(),
    };
    const injector = new KnowledgeCatalogInjector({
      knowledge: {
        enabled: true,
        endpoint: "https://kernel.example",
        serviceToken: "server-secret",
        serviceId: "fallback-space",
        timeoutMs: 1_500,
      },
    }, client as never);
    const ctx = context();
    delete ctx.metadata.custom!.userKey;

    expect(await injector.execute(ctx)).toEqual([]);
    expect(client.listKnowledge).not.toHaveBeenCalled();
  });
});
