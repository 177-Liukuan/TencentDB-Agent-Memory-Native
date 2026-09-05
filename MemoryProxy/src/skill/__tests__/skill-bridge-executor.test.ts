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

  it.each([
    ["update", { skill_id: "skl-1", content: "# Updated" }],
    ["patch", { skill_id: "skl-1", old_string: "old", new_string: "new" }],
    ["delete", { skill_id: "skl-1" }],
    ["files/write", { skill_id: "skl-1", files: [{ path: "scripts/run.sh", content: "echo ok", encoding: "utf-8" }] }],
    ["files/remove", { skill_id: "skl-1", paths: ["scripts/old.sh"] }],
  ])("loads the current version before a first-session %s write", async (subpath, body) => {
    await installSession();
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const outbound = JSON.parse(String(init?.body)) as Record<string, unknown>;

      if (path === "/v3/skill/get") {
        expect(outbound).toMatchObject({
          skill_id: "skl-1",
          user_id: "user-1",
          team_id: "team-1",
          agent_id: "agent-1",
        });
        return new Response(JSON.stringify({
          code: 0,
          data: { skill_id: "skl-1", version: 7 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      expect(path).toBe(`/v3/skill/${subpath}`);
      expect(outbound).toMatchObject({
        ...body,
        expected_version: 7,
        user_id: "user-1",
        team_id: "team-1",
        agent_id: "agent-1",
      });
      return new Response(JSON.stringify({
        code: 0,
        data: subpath === "delete"
          ? { skill_id: "skl-1", archived: true }
          : { skill_id: "skl-1", version: 8 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await executeSkillBridge({
      config: config(true),
      subpath,
      body,
      sessionId: "session-1",
      spaceId: "space-1",
    }, { fetcher });

    expect(result.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("cancels the upstream Skill request when the Native caller aborts", async () => {
    await installSession();
    const controller = new AbortController();
    let notifyFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => (
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        const timer = setTimeout(() => {
          resolve(new Response(JSON.stringify({ code: 0, data: { skill_id: "skl-1" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
        }, 50);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
        notifyFetchStarted();
      })
    ));

    const execution = executeSkillBridge({
      config: config(),
      subpath: "get",
      body: { skill_id: "skl-1" },
      sessionId: "session-1",
      spaceId: "space-1",
      signal: controller.signal,
    }, { fetcher });
    await fetchStarted;
    controller.abort(new Error("Native caller stopped waiting"));

    const result = await execution;

    expect(result.status).toBe(502);
    expect(JSON.parse(result.text)).toMatchObject({ code: 50301 });
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
