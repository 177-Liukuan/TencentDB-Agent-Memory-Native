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

function finalResponsesRound(): string {
  const item = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    content: [{ type: "output_text", text: "hello from Responses" }],
  };
  return event("response.created", {
    response: {
      id: "resp_1",
      model: "deepseek-v4-flash",
      usage: { input_tokens: 11, output_tokens: 0 },
    },
  }) + event("response.output_item.done", { output_index: 0, item })
    + event("response.completed", {
      response: {
        id: "resp_1",
        model: "deepseek-v4-flash",
        status: "completed",
        output: [item],
        usage: { input_tokens: 11, output_tokens: 4 },
      },
    });
}

function nativeResponsesRound(): string {
  const item = {
    type: "function_call",
    id: "fc_native",
    call_id: "call_native",
    name: "tdai_memory_search",
    arguments: "{\"query\":\"project rules\"}",
  };
  return event("response.created", {
    response: { id: "resp_native", model: "deepseek-v4-flash" },
  }) + event("response.output_item.added", {
    output_index: 0,
    item: { ...item, arguments: "" },
  }) + event("response.function_call_arguments.done", {
    output_index: 0,
    item_id: item.id,
    arguments: item.arguments,
  }) + event("response.output_item.done", { output_index: 0, item })
    + event("response.completed", {
      response: {
        id: "resp_native",
        model: "deepseek-v4-flash",
        status: "completed",
        output: [item],
        usage: { input_tokens: 20, output_tokens: 5 },
      },
    });
}

function mixedResponsesRound(): string {
  const calls = [
    {
      type: "function_call",
      id: "fc_native",
      call_id: "call_native",
      name: "tdai_memory_search",
      arguments: "{\"query\":\"project rules\"}",
    },
    {
      type: "function_call",
      id: "fc_client",
      call_id: "call_client",
      name: "Bash",
      arguments: "{\"command\":\"pwd\"}",
    },
  ];
  return event("response.created", {
    response: { id: "resp_mixed", model: "deepseek-v4-flash" },
  }) + calls.map((item, outputIndex) => (
    event("response.output_item.added", {
      output_index: outputIndex,
      item: { ...item, arguments: "" },
    }) + event("response.function_call_arguments.done", {
      output_index: outputIndex,
      item_id: item.id,
      arguments: item.arguments,
    }) + event("response.output_item.done", { output_index: outputIndex, item })
  )).join("") + event("response.completed", {
    response: {
      id: "resp_mixed",
      model: "deepseek-v4-flash",
      status: "completed",
      output: calls,
      usage: { input_tokens: 20, output_tokens: 8 },
    },
  });
}

function config() {
  const value = structuredClone(DEFAULT_CONFIG);
  value.log.backend = "noop";
  value.rateLimit.tpm = 0;
  value.rateLimit.qpm = 0;
  value.sessionInit.enabled = false;
  value.injection.enabled = false;
  value.nativeProxyTools.enabled = false;
  value.upstream.url = "https://api.deepseek.com";
  value.upstream.apiKey = "deepseek-server-key";
  value.upstream.agents["claude-code"] = {
    protocol: "responses",
  };
  return value;
}

beforeEach(() => {
  __resetInjectionPipelineForTests();
  __resetNativeProxyToolRuntimeForTests();
  __resetSessionStoreForTests();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await shutdownNativeProxyToolRuntime();
  __resetInjectionPipelineForTests();
  __resetNativeProxyToolRuntimeForTests();
  __resetSessionStoreForTests();
});

describe("Claude Code Anthropic client with a Responses upstream", () => {
  it("forwards Responses JSON to /responses and streams Anthropic SSE back", async () => {
    let upstreamUrl = "";
    let upstreamHeaders = new Headers();
    let upstreamBody: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).startsWith("https://api.deepseek.com")) {
        return new Response(JSON.stringify({ code: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      upstreamUrl = String(url);
      upstreamHeaders = new Headers(init?.headers);
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(finalResponsesRound(), {
        status: 200,
        headers: { "content-type": "text/event-stream", "x-request-id": "deepseek-request-1" },
      });
    }));

    const response = await createApp(config()).request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "memory-user-key",
        "x-conversation-id": "session-1",
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        stream: true,
        max_tokens: 1024,
        system: [{ type: "text", text: "system context", cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [{
          name: "Bash",
          description: "Run command",
          input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        }],
      }),
    });
    const visible = await response.text();

    expect(response.status, visible).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(upstreamUrl).toBe("https://api.deepseek.com/responses");
    expect(upstreamHeaders.get("authorization")).toBe("Bearer deepseek-server-key");
    expect(upstreamHeaders.has("x-api-key")).toBe(false);
    expect(upstreamBody).toMatchObject({
      model: "deepseek-v4-flash",
      stream: true,
      max_output_tokens: 1024,
      instructions: "system context",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      tools: [{ type: "function", name: "Bash", parameters: expect.any(Object) }],
    });
    expect(upstreamBody.messages).toBeUndefined();
    expect(visible).toContain("event: message_start");
    expect(visible).toContain("hello from Responses");
    expect(visible).toContain("event: message_stop");
    expect(visible).not.toContain("response.output_item");
  });

  it("converts a non-streaming Responses object to an Anthropic message", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      if (!String(url).startsWith("https://api.deepseek.com")) {
        return new Response(JSON.stringify({ code: 0 }), { status: 200 });
      }
      return new Response(JSON.stringify({
        id: "resp_json",
        model: "deepseek-v4-flash",
        status: "completed",
        output: [{
          type: "message",
          id: "msg_json",
          role: "assistant",
          content: [{ type: "output_text", text: "non-stream answer" }],
        }],
        usage: { input_tokens: 7, output_tokens: 3 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const response = await createApp(config()).request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "memory-user-key" },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        stream: false,
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "resp_json",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "non-stream answer" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 7, output_tokens: 3 },
    });
  });

  it("maps a Responses upstream error to the Anthropic error envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      if (!String(url).startsWith("https://api.deepseek.com")) {
        return new Response(JSON.stringify({ code: 0 }), { status: 200 });
      }
      return new Response(JSON.stringify({
        error: { type: "invalid_request_error", message: "bad Responses request" },
      }), { status: 400, headers: { "content-type": "application/json" } });
    }));

    const response = await createApp(config()).request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "memory-user-key" },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        stream: true,
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      type: "error",
      error: { type: "api_error", message: "bad Responses request" },
    });
  });

  it("does not fabricate an Anthropic message_stop after a Responses stream interruption", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      if (!String(url).startsWith("https://api.deepseek.com")) {
        return new Response(JSON.stringify({ code: 0 }), { status: 200 });
      }
      return new Response(event("response.created", {
        response: { id: "resp_cut", model: "deepseek-v4-flash" },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }));

    const response = await createApp(config()).request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "memory-user-key" },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        stream: true,
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    await expect(response.text()).rejects.toThrow(/terminal response event/);
  });

  it("executes an injected Native Tool through Responses internal re-entry without leaking it", async () => {
    const proxyConfig = config();
    proxyConfig.injection.enabled = true;
    proxyConfig.injection.injectors = [];
    proxyConfig.nativeProxyTools.enabled = true;
    proxyConfig.clickhouse.enabled = true;
    proxyConfig.tdai.enabled = true;
    proxyConfig.tdai.memory.enabled = true;
    proxyConfig.tdai.memory.inject = false;
    proxyConfig.tdai.memory.writeL0 = false;
    proxyConfig.extraction.enabled = false;
    proxyConfig.sessionInit.enabled = true;
    const storage = new InMemoryToolExecutionStorageAdapter();
    const execute = vi.fn(async () => ({
      isError: false,
      value: { memories: ["always run tests"] },
    }));
    const runtime = createNativeProxyToolRuntime(proxyConfig, {
      createStorage: () => storage,
      createDispatcher: () => ({ execute }),
    });
    await runtime.ready();
    __setNativeProxyToolRuntimeForTests(runtime);
    await getSessionStore().set("claude-code:native-session-1", {
      status: "initialized",
      keyId: "native-session-1",
      startedAt: Date.now(),
      attemptCount: 0,
      userId: "user-1",
      bypassed: false,
      sessionInfo: {
        session_id: "native-session-1",
        team_id: "team-1",
        agent_id: "agent-1",
        user_id: "user-1",
        space_id: "space-1",
      },
      agentDetail: null,
      taskDetail: null,
    });

    const upstreamBodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).startsWith("https://api.deepseek.com")) {
        return new Response(JSON.stringify({ code: 0, data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        upstreamBodies.length === 1 ? nativeResponsesRound() : finalResponsesRound(),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }));

    const response = await createApp(proxyConfig).request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "memory-user-key",
        "x-user-id": "user-1",
        "x-conversation-id": "native-session-1",
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        stream: true,
        max_tokens: 1024,
        messages: [{ role: "user", content: "What project rules apply?" }],
      }),
    });
    const visible = await response.text();

    expect(response.status, visible).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(upstreamBodies).toHaveLength(2);
    expect(upstreamBodies[0].tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function", name: "tdai_memory_search", parameters: expect.any(Object) }),
    ]));
    expect(upstreamBodies[1].input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", call_id: "call_native" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call_native" }),
    ]));
    expect(visible).toContain("hello from Responses");
    expect(visible).not.toContain("tdai_memory_search");
    expect(visible).not.toContain("call_native");
    expect(visible).not.toContain("always run tests");

    const followUp = await createApp(proxyConfig).request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "memory-user-key",
        "x-user-id": "user-1",
        "x-conversation-id": "native-session-1",
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        stream: true,
        max_tokens: 1024,
        messages: [
          { role: "user", content: "What project rules apply?" },
          { role: "assistant", content: "hello from Responses" },
          { role: "user", content: "Repeat the conclusion" },
        ],
      }),
    });
    expect(await followUp.text()).toContain("hello from Responses");
    expect(upstreamBodies).toHaveLength(3);
    const restored = JSON.stringify(upstreamBodies[2].input);
    expect(restored.match(/call_native/g)).toHaveLength(2);
    expect(restored.match(/tdai_memory_search/g)).toHaveLength(1);
    expect(restored).toContain("always run tests");
  });

  it("dispatches an Anthropic Client Tool, accepts its tool_result, and resumes the Responses batch", async () => {
    const proxyConfig = config();
    proxyConfig.injection.enabled = true;
    proxyConfig.injection.injectors = [];
    proxyConfig.nativeProxyTools.enabled = true;
    proxyConfig.clickhouse.enabled = true;
    proxyConfig.tdai.enabled = true;
    proxyConfig.tdai.memory.enabled = true;
    proxyConfig.tdai.memory.inject = false;
    proxyConfig.tdai.memory.writeL0 = false;
    proxyConfig.extraction.enabled = false;
    proxyConfig.sessionInit.enabled = true;
    const storage = new InMemoryToolExecutionStorageAdapter();
    const execute = vi.fn(async () => ({ isError: false, value: { memories: ["native result"] } }));
    const runtime = createNativeProxyToolRuntime(proxyConfig, {
      createStorage: () => storage,
      createDispatcher: () => ({ execute }),
    });
    await runtime.ready();
    __setNativeProxyToolRuntimeForTests(runtime);
    await getSessionStore().set("claude-code:mixed-session-1", {
      status: "initialized",
      keyId: "mixed-session-1",
      startedAt: Date.now(),
      attemptCount: 0,
      userId: "user-1",
      bypassed: false,
      sessionInfo: {
        session_id: "mixed-session-1",
        team_id: "team-1",
        agent_id: "agent-1",
        user_id: "user-1",
        space_id: "space-1",
      },
      agentDetail: null,
      taskDetail: null,
    });

    const upstreamBodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).startsWith("https://api.deepseek.com")) {
        return new Response(JSON.stringify({ code: 0, data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        upstreamBodies.length === 1 ? mixedResponsesRound() : finalResponsesRound(),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }));
    const app = createApp(proxyConfig);
    const headers = {
      "content-type": "application/json",
      "x-api-key": "memory-user-key",
      "x-user-id": "user-1",
      "x-conversation-id": "mixed-session-1",
    };
    const initial = await app.request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        stream: true,
        max_tokens: 1024,
        messages: [{ role: "user", content: "Use memory and run pwd" }],
        tools: [{
          name: "Bash",
          description: "Run command",
          input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        }],
      }),
    });
    const dispatched = await initial.text();
    expect(initial.status, dispatched).toBe(200);
    expect(dispatched).toContain('"id":"call_client"');
    expect(dispatched).toContain('"name":"Bash"');
    expect(dispatched).not.toContain("tdai_memory_search");

    const resumed = await app.request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        stream: true,
        max_tokens: 1024,
        messages: [
          { role: "user", content: "Use memory and run pwd" },
          { role: "assistant", content: [{ type: "tool_use", id: "call_client", name: "Bash", input: { command: "pwd" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_client", content: "/workspace" }] },
        ],
        tools: [{
          name: "Bash",
          description: "Run command",
          input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        }],
      }),
    });
    const final = await resumed.text();

    expect(resumed.status, final).toBe(200);
    expect(final).toContain("hello from Responses");
    expect(final).not.toContain("tdai_memory_search");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(upstreamBodies).toHaveLength(2);
    expect(upstreamBodies[1].input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", call_id: "call_native" }),
      expect.objectContaining({ type: "function_call", call_id: "call_client" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call_native" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call_client", output: "/workspace" }),
    ]));
  });
});
