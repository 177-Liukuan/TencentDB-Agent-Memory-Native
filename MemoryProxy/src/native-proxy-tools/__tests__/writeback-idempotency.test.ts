import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import { CoreSkillClient, setCoreSkillClient } from "../../skill/core-client.js";
import { triggerSkillExtractIfReady } from "../../skill/handler-glue.js";
import { TdaiClient } from "../../tdai/client.js";

afterEach(() => {
  setCoreSkillClient(null);
  vi.unstubAllGlobals();
});

describe("durable writeback idempotency", () => {
  it("sends a stable idempotency key to TDAI and surfaces durable write failures", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ code: 0, data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetcher);
    const client = new TdaiClient({
      enabled: true,
      endpoint: "https://tdai.example",
      apiKey: "test-key",
      serviceId: "service-1",
      writeL0: true,
      recallL1: false,
      injectL2L3: false,
      l1Limit: 5,
      l2Limit: 3,
      timeoutMs: 1_000,
    });
    const identity = {
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
      sessionId: "session-1",
    };

    await client.addConversation(identity, [{ role: "user", content: "question" }], {
      idempotencyKey: "native-tool-observation-stable",
      requireSuccess: true,
    });
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("idempotency-key"))
      .toBe("native-tool-observation-stable:0");

    fetcher.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(client.addConversation(identity, [{ role: "user", content: "retry" }], {
      idempotencyKey: "native-tool-observation-stable",
      requireSuccess: true,
    })).rejects.toThrow(/write failed/i);

    const disabledWrite = new TdaiClient({
      enabled: true,
      endpoint: "https://tdai.example",
      apiKey: "test-key",
      serviceId: "service-1",
      writeL0: false,
      recallL1: false,
      injectL2L3: false,
      l1Limit: 5,
      l2Limit: 3,
      timeoutMs: 1_000,
    });
    await expect(disabledWrite.addConversation(
      identity,
      [{ role: "user", content: "must remain pending" }],
      { requireSuccess: true },
    )).rejects.toThrow(/unavailable/i);
  });

  it("forwards idempotency to Skill Core and can fail the durable outbox", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => (
      new Response("unavailable", { status: 503 })
    ));
    const client = new CoreSkillClient({
      endpoint: "https://skill.example",
      serviceToken: "token",
      serviceId: "service",
      timeoutMs: 1_000,
    }, fetcher as typeof fetch);
    setCoreSkillClient(client);
    const config = structuredClone(DEFAULT_CONFIG);
    config.coreSkill.endpoint = "https://skill.example";
    config.coreSkill.serviceToken = "token";

    await expect(triggerSkillExtractIfReady({
      config,
      sessionKey: "session-1",
      agentSource: "claude-code",
      sessionInfo: {
        session_id: "session-1",
        space_id: "space-1",
        team_id: "team-1",
        user_id: "user-1",
        agent_id: "agent-1",
      },
      inputMessages: [{ role: "user", content: "question" }],
      assistantMessage: { role: "assistant", content: "answer" },
      protocol: "anthropic",
      idempotencyKey: "native-tool-observation-stable",
      throwOnError: true,
    })).rejects.toThrow(/HTTP 503/);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("idempotency-key"))
      .toBe("native-tool-observation-stable");
  });
});
