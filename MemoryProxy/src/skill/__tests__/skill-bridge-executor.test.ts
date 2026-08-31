import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import { __resetSessionStoreForTests, getSessionStore } from "../../session/store.js";
import { executeSkillBridge } from "../skill-bridge.js";

function config(allowWrite = false) {
  const value = structuredClone(DEFAULT_CONFIG);
  value.coreSkill.endpoint = "https://skill.example";
  value.coreSkill.serviceToken = "server-secret";
  value.coreSkill.serviceId = "fallback-space";
  value.skillRuntime.allowLlmWrite = allowWrite;
  value.storage.enabled = false;
  value.redis.enabled = false;
  return value;
}

async function installSession(): Promise<void> {
  await getSessionStore().set("claude-code:session-1", {
    status: "initialized",
    keyId: "claude-code:session-1",
    startedAt: Date.now(),
    attemptCount: 1,
    userId: "user-1",
    sessionInfo: {
      user_id: "user-1",
      team_id: "team-1",
      agent_id: "agent-1",
      session_id: "session-1",
      space_id: "space-1",
    },
  });
}

afterEach(() => {
  __resetSessionStoreForTests();
  vi.restoreAllMocks();
});

describe("executeSkillBridge", () => {
  it("reuses Skill Bridge identity stamping without a localhost request", async () => {
    await installSession();
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        skill_id: "skl-1",
        include_content: true,
        include_manifest: true,
        user_id: "user-1",
        team_id: "team-1",
        agent_id: "agent-1",
      });
      expect(body.user_id).not.toBe("attacker");
      return new Response(JSON.stringify({
        code: 0,
        data: { skill_id: "skl-1", version: 3, content: "# Skill" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await executeSkillBridge({
      config: config(),
      subpath: "get",
      body: {
        skill_id: "skl-1",
        include_content: true,
        include_manifest: true,
        user_id: "attacker",
      },
      sessionId: "session-1",
      spaceId: "space-1",
    }, { fetcher });

    expect(result.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0][0])).toBe("https://skill.example/v3/skill/get");
  });

  it("keeps Skill write policy enforcement inside the shared Bridge", async () => {
    await installSession();
    const fetcher = vi.fn();

    const result = await executeSkillBridge({
      config: config(false),
      subpath: "delete",
      body: { skill_id: "skl-1" },
      sessionId: "session-1",
      spaceId: "space-1",
    }, { fetcher });

    expect(result.status).toBe(403);
    expect(JSON.parse(result.text)).toMatchObject({ code: 40302 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
