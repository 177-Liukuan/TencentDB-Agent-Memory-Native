import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../config.js";
import { InMemoryToolExecutionStorageAdapter } from "../db/in-memory-tool-execution-storage-adapter.js";
import { __resetInjectionPipelineForTests } from "../injection/index.js";
import {
  __resetNativeProxyToolRuntimeForTests,
  __setNativeProxyToolRuntimeForTests,
  createNativeProxyToolRuntime,
  shutdownNativeProxyToolRuntime,
} from "../native-proxy-tools/runtime.js";
import { createApp } from "../server.js";
import { __resetSessionStoreForTests, getSessionStore } from "../session/store.js";

function event(type: string, value: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

function nativeRound(): string {
  const item = { type: "function_call", id: "fc_native", call_id: "call_native", name: "tdai_memory_search", arguments: "{\"query\":\"project rules\"}" };
  return event("response.output_item.added", { output_index: 0, item: { ...item, arguments: "" } })
    + event("response.function_call_arguments.done", { output_index: 0, item_id: "fc_native", arguments: item.arguments })
    + event("response.output_item.done", { output_index: 0, item })
    + event("response.completed", { response: { id: "resp_native", status: "completed", output: [item] } });
}

function mixedRound(): string {
  const native = { type: "function_call", id: "fc_native", call_id: "call_native", name: "tdai_memory_search", arguments: "{\"query\":\"project rules\"}" };
  const client = { type: "function_call", id: "fc_client", call_id: "call_client", name: "client_shell", arguments: "{\"command\":\"pwd\"}" };
  return [native, client].map((item, output_index) => (
    event("response.output_item.added", { output_index, item: { ...item, arguments: "" } })
    + event("response.function_call_arguments.done", { output_index, item_id: item.id, arguments: item.arguments })
    + event("response.output_item.done", { output_index, item })
  )).join("") + event("response.completed", { response: { id: "resp_mixed", status: "completed", output: [native, client] } });
}

function finalRound(): string {
  const item = { type: "message", id: "msg_final", role: "assistant", content: [{ type: "output_text", text: "final from Responses" }] };
  return event("response.output_item.done", { output_index: 0, item })
    + event("response.completed", { response: { id: "resp_final", status: "completed", output: [item] } });
}

function proxyConfig() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.server.forwardTimeoutMs = 5_000;
  config.upstream.url = "https://responses.example";
  config.upstream.apiKey = "server-key";
  config.log.backend = "noop";
  config.sessionInit.enabled = true;
  config.injection.enabled = true;
  config.injection.injectors = [];
  config.nativeProxyTools.enabled = true;
  config.clickhouse.enabled = true;
  config.tdai.enabled = true;
  config.tdai.memory.enabled = true;
  config.tdai.memory.inject = false;
  config.tdai.memory.writeL0 = false;
  config.extraction.enabled = false;
  return config;
}

async function installSession(): Promise<void> {
  await getSessionStore().set("codex:session-responses", {
    status: "initialized", keyId: "session-responses", startedAt: Date.now(), attemptCount: 0,
    userId: "anonymous", bypassed: false,
    sessionInfo: { session_id: "session-responses", team_id: "team-1", agent_id: "agent-1", user_id: "anonymous", space_id: "space-1" },
    agentDetail: null, taskDetail: null,
  });
}

beforeEach(() => {
  __resetInjectionPipelineForTests();
  __resetSessionStoreForTests();
  __resetNativeProxyToolRuntimeForTests();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await shutdownNativeProxyToolRuntime();
  __resetInjectionPipelineForTests();
  __resetSessionStoreForTests();
  __resetNativeProxyToolRuntimeForTests();
});

describe.each([
  ["Codex", "/codex/space-1/v1/responses"],
  ["WorkBuddy", "/workbuddy/space-1/v1/responses"],
])("%s Responses Native Proxy Tool HTTP loop", (_client, route) => {
  it("injects flat tools, executes Native calls, and hides the internal round", async () => {
    const config = proxyConfig();
    const storage = new InMemoryToolExecutionStorageAdapter();
    const execute = vi.fn(async () => ({ isError: false, value: { memories: ["use formatter"] } }));
    const runtime = createNativeProxyToolRuntime(config, {
      createStorage: () => storage,
      createDispatcher: () => ({ execute }),
    });
    await runtime.ready();
    __setNativeProxyToolRuntimeForTests(runtime);
    await installSession();

    const upstreamBodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).startsWith("https://responses.example")) {
        return new Response(JSON.stringify({ code: 0, data: { chat_memory: true, skill: true } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const text = upstreamBodies.length === 1 ? nativeRound() : finalRound();
      return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
    }));

    const response = await createApp(config).request(route, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": "Bearer client-key", "x-user-id": "user-1", "session-id": "session-responses" },
      body: JSON.stringify({
        model: "gpt-5", stream: true, instructions: "original instructions",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "What rules apply?" }] }],
        tools: [{ type: "function", name: "client_shell", description: "shell", parameters: { type: "object" }, strict: true }],
      }),
    });
    const visible = await response.text();

    expect(response.status).toBe(200);
    expect(upstreamBodies[0].tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function", name: "tdai_memory_search", parameters: expect.any(Object) }),
    ]));
    expect(visible).toContain("final from Responses");
    expect(visible).not.toContain("tdai_memory_search");
    expect(visible).not.toContain("call_native");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(upstreamBodies).toHaveLength(2);
    expect(upstreamBodies[0].tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function", name: "tdai_memory_search", parameters: expect.any(Object) }),
      expect.objectContaining({ type: "function", name: "client_shell" }),
    ]));
    expect(JSON.stringify(upstreamBodies[0].tools)).not.toContain('"function":{"name"');
    expect(upstreamBodies[1].input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", call_id: "call_native" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call_native" }),
    ]));

    const followUp = await createApp(config).request(route, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": "Bearer client-key", "x-user-id": "user-1", "session-id": "session-responses" },
      body: JSON.stringify({
        model: "gpt-5", stream: true,
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "What rules apply?" }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "final from Responses" }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "What about now?" }] },
        ],
      }),
    });
    expect(await followUp.text()).toContain("final from Responses");
    expect(upstreamBodies).toHaveLength(3);
    const restored = JSON.stringify(upstreamBodies[2].input);
    expect(restored.match(/call_native/g)).toHaveLength(2);
    expect(restored.match(/tdai_memory_search/g)).toHaveLength(1);
    expect(restored).toContain("use formatter");

    const compact = await createApp(config).request(`${route}/compact`, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": "Bearer client-key", "x-user-id": "user-1", "session-id": "session-responses" },
      body: JSON.stringify({
        model: "gpt-5", stream: true,
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "What rules apply?" }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "final from Responses" }] },
        ],
      }),
    });
    expect(await compact.text()).toContain("response.completed");
    expect(JSON.stringify(upstreamBodies[3].input).match(/call_native/g)).toHaveLength(2);

    const afterCompact = await createApp(config).request(route, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": "Bearer client-key", "x-user-id": "user-1", "session-id": "session-responses" },
      body: JSON.stringify({
        model: "gpt-5", stream: true,
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "Summary of the earlier conversation" }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
        ],
      }),
    });
    await afterCompact.text();
    expect(JSON.stringify(upstreamBodies[4].input)).not.toContain("call_native");
    expect(await runtime.historyStorage!.findPendingCompressionReceipts({
      spaceId: "space-1", userId: "anonymous", agentSource: _client === "Codex" ? "codex" : "workbuddy", sessionId: "session-responses",
    })).toEqual([]);
  });

  it("keeps auxiliary Responses endpoints as single-call pass-through", async () => {
    const config = proxyConfig();
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(finalRound(), { status: 200, headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const auxRoute = `${route}/compact`;
    const response = await createApp(config).request(auxRoute, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", stream: true, input: [{ role: "user", content: "compact" }] }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("final from Responses");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(sent.tools).toBeUndefined();
  });
});

describe("Responses mixed Client/Native HTTP continuation", () => {
  it("accepts the Client result, merges the hidden Native result, and re-enters once", async () => {
    const config = proxyConfig();
    const storage = new InMemoryToolExecutionStorageAdapter();
    const execute = vi.fn(async () => ({ isError: false, value: { memories: ["native result"] } }));
    const runtime = createNativeProxyToolRuntime(config, { createStorage: () => storage, createDispatcher: () => ({ execute }) });
    await runtime.ready();
    __setNativeProxyToolRuntimeForTests(runtime);
    await installSession();
    const upstreamBodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).startsWith("https://responses.example")) {
        return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200, headers: { "content-type": "application/json" } });
      }
      upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(upstreamBodies.length === 1 ? mixedRound() : finalRound(), { status: 200, headers: { "content-type": "text/event-stream" } });
    }));
    const app = createApp(config);
    const common = { "content-type": "application/json", "authorization": "Bearer client-key", "session-id": "session-responses" };
    const initial = await app.request("/codex/space-1/v1/responses", {
      method: "POST", headers: common,
      body: JSON.stringify({ model: "gpt-5", stream: true, input: [{ type: "message", role: "user", content: "question" }], tools: [{ type: "function", name: "client_shell", description: "shell", parameters: { type: "object" } }] }),
    });
    const dispatched = await initial.text();
    expect(dispatched).toContain("client_shell");
    expect(dispatched).not.toContain("tdai_memory_search");

    const resumed = await app.request("/codex/space-1/v1/responses", {
      method: "POST", headers: common,
      body: JSON.stringify({ model: "gpt-5", stream: true, input: [
        { type: "message", role: "user", content: "question" },
        { type: "function_call_output", call_id: "call_client", output: "pwd output" },
      ] }),
    });
    expect(resumed.status).toBe(200);
    expect(await resumed.text()).toContain("final from Responses");
    expect(upstreamBodies).toHaveLength(2);
    expect(upstreamBodies[1].input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", call_id: "call_native" }),
      expect.objectContaining({ type: "function_call", call_id: "call_client" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call_native" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call_client", output: "pwd output" }),
    ]));
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
