import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../config.js";
import { InMemoryNativeToolLedgerStorageAdapter } from "../db/in-memory-native-tool-ledger-storage-adapter.js";
import { InMemoryToolExecutionStorageAdapter } from "../db/in-memory-tool-execution-storage-adapter.js";
import {
  __resetNativeProxyToolRuntimeForTests,
  __setNativeProxyToolRuntimeForTests,
  createNativeProxyToolRuntime,
  shutdownNativeProxyToolRuntime,
} from "../native-proxy-tools/runtime.js";
import { createApp } from "../server.js";

afterEach(async () => {
  await shutdownNativeProxyToolRuntime();
  __resetNativeProxyToolRuntimeForTests();
});

describe("Claude Code context Hook HTTP endpoint", () => {
  it("records only real prompts and advances epoch only after PostCompact", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.nativeProxyTools.enabled = true;
    config.auth.enabled = false;
    const ledger = new InMemoryNativeToolLedgerStorageAdapter();
    const runtime = createNativeProxyToolRuntime(config, {
      createStorage: () => new InMemoryToolExecutionStorageAdapter(),
      createLedgerStorage: () => ledger,
    });
    await runtime.ready();
    __setNativeProxyToolRuntimeForTests(runtime);
    const app = createApp(config);
    const url = "/claude-code/space/hooks/claude-code/context";
    const headers = { "content-type": "application/json", "x-user-id": "user" };
    const send = (payload: Record<string, unknown>) => app.request(url, {
      method: "POST", headers, body: JSON.stringify({ session_id: "session", ...payload }),
    });

    const prompt = await send({ hook_event_name: "UserPromptSubmit", prompt: "hello" });
    expect(prompt.status).toBe(200);
    expect(await prompt.json()).toMatchObject({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: expect.stringMatching(/tdai-native-turn/) },
    });
    expect((await send({ hook_event_name: "UserPromptSubmit", prompt: "/compact" })).status).toBe(204);
    expect((await send({ hook_event_name: "PreCompact", trigger: "manual" })).status).toBe(204);
    expect(await ledger.getSessionContext({ spaceId: "space", userId: "user", agentSource: "claude-code", sessionId: "session" }))
      .toMatchObject({ currentTurnSeq: 1, currentEpoch: 0, pendingCompactEpoch: 1 });
    expect((await send({ hook_event_name: "PostCompact", trigger: "manual" })).status).toBe(204);
    expect(await ledger.getSessionContext({ spaceId: "space", userId: "user", agentSource: "claude-code", sessionId: "session" }))
      .toMatchObject({ currentTurnSeq: 1, currentEpoch: 1, pendingCompactEpoch: null });
  });
});
