import { afterEach, describe, expect, it, vi } from "vitest";

import { TdaiProfileMemoryInjector } from "../tdai-profile-memory-injector.js";
import type { AgentContext } from "../../types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TDAI profile memory prompt", () => {
  it("keeps profile material separate from the tool usage guide", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const data = url.endsWith("/v3/core/read")
        ? { content: "用户偏好简洁的回答。" }
        : { entries: [{ path: "projects/native-tool.md", summary: "Native Tool 项目约定" }] };
      return new Response(JSON.stringify({ code: 0, data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const injector = new TdaiProfileMemoryInjector({
      enabled: true,
      endpoint: "https://tdai.example",
      apiKey: "test-key",
      serviceId: "space-1",
      writeL0: false,
      recallL1: false,
      injectL2L3: true,
      l1Limit: 5,
      l2Limit: 3,
      timeoutMs: 1_000,
    });
    const context: AgentContext = {
      messages: [],
      tools: [],
      requestParams: {},
      metadata: {
        protocol: "anthropic",
        traceId: "trace-1",
        keyId: "key-1",
        modelId: "model-1",
        stream: true,
        agentSource: "claude-code",
        custom: {
          session: {
            session_id: "session-1",
            space_id: "space-1",
            team_id: "team-1",
            user_id: "user-1",
            agent_id: "agent-1",
          },
        },
      },
    };

    const blocks = await injector.execute(context);
    const prompt = blocks[0]?.content ?? "";

    expect(prompt).toContain(
      "以下是 TDAI 为当前 agent 维护的长期工作记忆（自有 + 借入分段；L2 仅给索引，按需用工具读全文）：",
    );
    expect(prompt).toContain("用户偏好简洁的回答。");
    expect(prompt).toContain("`projects/native-tool.md` — Native Tool 项目约定");
    expect(prompt).not.toMatch(/二者都应|tdai_memory_search|<native_tool_usage>|<memory-tools-guide>/);
  });
});
