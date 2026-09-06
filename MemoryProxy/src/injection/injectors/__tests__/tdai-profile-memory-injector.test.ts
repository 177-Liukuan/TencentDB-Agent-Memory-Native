import { afterEach, describe, expect, it, vi } from "vitest";

import { TdaiProfileMemoryInjector } from "../tdai-profile-memory-injector.js";
import type { AgentContext } from "../../types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TDAI profile memory prompt", () => {
  it("explains cloud-memory priority and directs L2 reads to tdai_read_scene", async () => {
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
      "以下是 TDAI 长期记忆，它与 Claude Code 本地 MEMORY.md 是不同的数据源，但具有同等优先级。",
    );
    expect(prompt).toContain(
      "L2 只列路径和摘要，需要正文时使用 `tdai_read_scene` 读取所列路径。",
    );
    expect(prompt).toContain("用户偏好简洁的回答。");
    expect(prompt).toContain("`projects/native-tool.md` — Native Tool 项目约定");
  });
});
