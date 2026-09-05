import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../config.js";
import { getSessionStore, __resetSessionStoreForTests } from "../../session/store.js";
import { createMemoryBridgeHandler } from "../memory-bridge.js";
import { createSkillBridgeHandler } from "../../skill/skill-bridge.js";
const directories: string[] = [];
afterEach(() => { __resetSessionStoreForTests(); for (const p of directories.splice(0)) rmSync(p, { recursive: true, force: true }); });
it.each(["memory", "skill"])("%s 记录在真实后端请求之前，后端失败也不会漏记", async (family) => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-start-")); directories.push(directory);
  const config = structuredClone(DEFAULT_CONFIG);
  config.evalToolObservation = { enabled: true, directory };
  config.coreSkill.endpoint = "http://unused";
  const sessionId = "observation-session";
  await getSessionStore().set("claude-code:" + sessionId, {
    status: "initialized", keyId: "claude-code:" + sessionId, startedAt: Date.now(), attemptCount: 1,
    sessionInfo: { user_id: "user", team_id: "team", agent_id: "agent", session_id: sessionId, space_id: "space" },
  });
  let recordedBeforeBackend = false;
  const fetcher: typeof fetch = async () => {
    const event = JSON.parse(readFileSync(join(directory, sessionId + ".jsonl"), "utf8"));
    recordedBeforeBackend = event.tool_name === (family === "memory" ? "tdai_atomic_query" : "skill_view");
    return new Response('{"code":500,"message":"failed"}', { status: 503 });
  };
  const app = new Hono();
  const path = family === "memory" ? "/memory-bridge/v3/atomic/query" : "/skill-bridge/v3/skill/get-by-name";
  const handler = family === "memory" ? createMemoryBridgeHandler(config, { fetcher }) : createSkillBridgeHandler(config, { fetcher });
  app.post("*", handler);
  const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-conversation-id": sessionId }, body: '{"ids":["m1"],"skill_name":"example"}' });
  expect(recordedBeforeBackend).toBe(true);
  expect(response.status).toBe(503);
  expect(readFileSync(join(directory, sessionId + ".jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
});

