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

const encoder = new TextEncoder();

function frame(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function messageStart(id: string): string {
  return frame("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [],
      stop_reason: null,
    },
  });
}

function messageStop(reason: string): string {
  return frame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: reason },
  }) + frame("message_stop", { type: "message_stop" });
}

function nativeCallFixture(): string {
  return messageStart("msg-native")
    + frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "native-call-1",
        name: "tdai_memory_search",
        input: {},
      },
    })
    + frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{\"query\":\"project rules\"}" },
    })
    + frame("content_block_stop", { type: "content_block_stop", index: 0 })
    + messageStop("tool_use");
}

function mixedCallFixture(): string {
  return messageStart("msg-mixed")
    + frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "native-call-1",
        name: "tdai_memory_search",
        input: {},
      },
    })
    + frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{\"query\":\"project rules\"}" },
    })
    + frame("content_block_stop", { type: "content_block_stop", index: 0 })
    + frame("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "client-call-1",
        name: "client_shell",
        input: {},
      },
    })
    + frame("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "{\"command\":\"pwd\"}" },
    })
    + frame("content_block_stop", { type: "content_block_stop", index: 1 })
    + messageStop("tool_use");
}

function clientOnlyFixture(): string {
  return messageStart("msg-client")
    + frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "client-call-1",
        name: "client_shell",
        input: {},
      },
    })
    + frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{\"command\":\"pwd\"}" },
    })
    + frame("content_block_stop", { type: "content_block_stop", index: 0 })
    + messageStop("tool_use");
}

function finalTextFixture(): string {
  return messageStart("msg-final")
    + frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })
    + frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "final answer" },
    })
    + frame("content_block_stop", { type: "content_block_stop", index: 0 })
    + messageStop("end_turn");
}

function singleConsumerSse(text: string): { response: Response; readers: () => number } {
  let readers = 0;
  const bytes = encoder.encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const getReader = stream.getReader.bind(stream);
  stream.getReader = ((...args: Parameters<typeof stream.getReader>) => {
    readers++;
    if (readers > 1) throw new Error("upstream stream was consumed more than once");
    return getReader(...args);
  }) as typeof stream.getReader;
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-request-id": `req-${Math.random()}` },
    }),
    readers: () => readers,
  };
}

function config() {
  const value = structuredClone(DEFAULT_CONFIG);
  value.server.forwardTimeoutMs = 5_000;
  value.upstream.url = "https://upstream.example/v1";
  value.upstream.apiKey = "server-key";
  value.upstream.agents["claude-code"] = {
    url: "https://upstream.example/v1",
    apiKey: "agent-key",
  };
  value.log.backend = "noop";
  value.rateLimit.tpm = 0;
  value.rateLimit.qpm = 0;
  value.nativeProxyTools.enabled = true;
  value.clickhouse.enabled = true;
  value.clickhouse.url = "http://clickhouse.invalid:8123";
  value.sessionInit.enabled = true;
  value.injection.enabled = false;
  value.injection.injectors = [];
  value.extraction.enabled = false;
  value.tdai.enabled = true;
  value.tdai.endpoint = "https://tdai.example";
  value.tdai.memory.enabled = true;
  value.tdai.memory.inject = false;
  value.tdai.memory.writeL0 = false;
  return value;
}

async function installInitializedSession(): Promise<void> {
  await getSessionStore().set("claude-code:session-1", {
    status: "initialized",
    keyId: "session-1",
    startedAt: Date.now(),
    attemptCount: 0,
    userId: "user-1",
    bypassed: false,
    sessionInfo: {
      session_id: "session-1",
      team_id: "team-1",
      agent_id: "agent-1",
      user_id: "user-1",
      space_id: "space-1",
    },
    agentDetail: null,
    taskDetail: null,
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

describe("Anthropic Native Proxy Tool handler", () => {
  it("fails closed and exposes readiness when ClickHouse state storage is unavailable", async () => {
    const proxyConfig = config();
    const storage = new InMemoryToolExecutionStorageAdapter();
    vi.spyOn(storage, "initializeAndProbe").mockRejectedValue(
      new Error("secret ClickHouse connection detail"),
    );
    const runtime = createNativeProxyToolRuntime(proxyConfig, {
      createStorage: () => storage,
    });
    __setNativeProxyToolRuntimeForTests(runtime);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp(proxyConfig);

    const response = await app.request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-conversation-id": "session-1",
      },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "question" }],
      }),
    });
    const responseText = await response.text();
    const health = await app.request("/health");
    const healthBody = await health.json() as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(responseText).toContain("native_tool_state_unavailable");
    expect(responseText).not.toContain("secret ClickHouse connection detail");
    expect(health.status).toBe(503);
    expect(healthBody).toMatchObject({
      status: "degraded",
      nativeProxyTools: {
        enabled: true,
        ready: false,
        failed: true,
      },
    });
    expect(JSON.stringify(healthBody)).not.toContain("secret ClickHouse connection detail");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the injected first request and exact successful target for internal re-entry", async () => {
    const proxyConfig = config();
    const storage = new InMemoryToolExecutionStorageAdapter();
    const execute = vi.fn(async () => ({
      isError: false,
      value: { items: [{ memory: "Use the project formatter" }] },
    }));
    const runtime = createNativeProxyToolRuntime(proxyConfig, {
      createStorage: () => storage,
      createDispatcher: () => ({ execute }),
    });
    await runtime.ready();
    __setNativeProxyToolRuntimeForTests(runtime);
    await installInitializedSession();

    const first = singleConsumerSse(nativeCallFixture());
    const second = singleConsumerSse(finalTextFixture());
    const upstreamCalls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === "https://tdai.example/v3/meta/config/user/get") {
        return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (href === "https://upstream.example/v1/messages") {
        upstreamCalls.push({
          url: href,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          headers: new Headers(init?.headers),
        });
        return upstreamCalls.length === 1 ? first.response : second.response;
      }
      return new Response("not found", { status: 404 });
    }));

    const app = createApp(proxyConfig);
    const response = await app.request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-key",
        "x-user-id": "user-1",
        "x-conversation-id": "session-1",
      },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 1_024,
        stream: true,
        system: [{ type: "text", text: "original system" }],
        messages: [{ role: "user", content: "What rules apply?" }],
      }),
    });
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(responseText).toContain("final answer");
    expect(responseText).not.toContain("tdai_memory_search");
    expect(responseText).not.toContain("native-call-1");
    expect(upstreamCalls).toHaveLength(2);
    expect(upstreamCalls[1].url).toBe(upstreamCalls[0].url);
    expect(upstreamCalls[1].body.system).toEqual(upstreamCalls[0].body.system);
    expect(upstreamCalls[1].body.tools).toEqual(upstreamCalls[0].body.tools);
    expect(upstreamCalls[0].body.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "tdai_memory_search" }),
    ]));
    expect(upstreamCalls[1].body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant" }),
      expect.objectContaining({ role: "user" }),
    ]));
    expect(upstreamCalls[1].headers.get("x-api-key")).toBe("agent-key");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(first.readers()).toBe(1);
    expect(second.readers()).toBe(1);
  });

  it("buffers a pure Client Tool round through message_stop and replays it byte-for-byte", async () => {
    const proxyConfig = config();
    const storage = new InMemoryToolExecutionStorageAdapter();
    const execute = vi.fn(async () => ({ isError: false, value: null }));
    const runtime = createNativeProxyToolRuntime(proxyConfig, {
      createStorage: () => storage,
      createDispatcher: () => ({ execute }),
    });
    await runtime.ready();
    __setNativeProxyToolRuntimeForTests(runtime);
    await installInitializedSession();
    const fixture = clientOnlyFixture();
    const upstream = singleConsumerSse(fixture);
    let upstreamCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === "https://tdai.example/v3/meta/config/user/get") {
        return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (href === "https://upstream.example/v1/messages") {
        upstreamCount++;
        return upstream.response;
      }
      return new Response("not found", { status: 404 });
    }));
    const app = createApp(proxyConfig);

    const response = await app.request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-key",
        "x-user-id": "user-1",
        "x-conversation-id": "session-1",
      },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 1_024,
        stream: true,
        tools: [{ name: "client_shell", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: "Run pwd" }],
      }),
    });

    expect(await response.text()).toBe(fixture);
    expect(upstreamCount).toBe(1);
    expect(upstream.readers()).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    expect(await storage.findActiveBySession({
      spaceId: "space-1",
      userId: "user-1",
      agentSource: "claude-code",
      sessionId: "session-1",
      contextVersion: "v1",
    })).toEqual([]);
  });

  it("waits for a later Native result when Client Tool Results arrive first", async () => {
    const proxyConfig = config();
    const storage = new InMemoryToolExecutionStorageAdapter();
    let releaseNative!: () => void;
    const nativeGate = new Promise<void>((resolve) => { releaseNative = resolve; });
    const execute = vi.fn(async () => {
      await nativeGate;
      return { isError: false, value: { items: [{ memory: "native result" }] } };
    });
    const runtime = createNativeProxyToolRuntime(proxyConfig, {
      createStorage: () => storage,
      createDispatcher: () => ({ execute }),
    });
    await runtime.ready();
    __setNativeProxyToolRuntimeForTests(runtime);
    await installInitializedSession();

    const mixed = singleConsumerSse(mixedCallFixture());
    const final = singleConsumerSse(finalTextFixture());
    const upstreamCalls: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === "https://tdai.example/v3/meta/config/user/get") {
        return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (href === "https://upstream.example/v1/messages") {
        upstreamCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return upstreamCalls.length === 1 ? mixed.response : final.response;
      }
      return new Response("not found", { status: 404 });
    }));

    const app = createApp(proxyConfig);
    const headers = {
      "content-type": "application/json",
      "x-api-key": "client-key",
      "x-user-id": "user-1",
      "x-conversation-id": "session-1",
    };
    const firstResponse = await app.request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 1_024,
        stream: true,
        system: "original system",
        tools: [{ name: "client_shell", description: "shell", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: "What rules apply?" }],
      }),
    });
    const firstText = await firstResponse.text();
    expect(firstText).toContain("client-call-1");
    expect(firstText).toContain("client_shell");
    expect(firstText).not.toContain("native-call-1");
    expect(firstText).not.toContain("tdai_memory_search");
    expect(upstreamCalls).toHaveLength(1);

    const resumed = app.request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 1_024,
        stream: true,
        system: "client continuation system must not replace persisted system",
        messages: [
          { role: "user", content: "What rules apply?" },
          {
            role: "assistant",
            content: [{
              type: "tool_use",
              id: "client-call-1",
              name: "client_shell",
              input: { command: "pwd" },
            }],
          },
          {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "client-call-1",
              content: "/workspace",
            }],
          },
        ],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const callCountBeforeNativeResult = upstreamCalls.length;
    releaseNative();
    expect(callCountBeforeNativeResult).toBe(1);
    const resumedResponse = await resumed;
    const resumedText = await resumedResponse.text();

    expect(resumedResponse.status).toBe(200);
    expect(resumedText).toContain("final answer");
    expect(resumedText).not.toContain("native-call-1");
    expect(upstreamCalls).toHaveLength(2);
    expect(upstreamCalls[1].system).toEqual(upstreamCalls[0].system);
    expect(upstreamCalls[1].tools).toEqual(upstreamCalls[0].tools);
    const reentryMessages = upstreamCalls[1].messages as Array<Record<string, unknown>>;
    const assistant = reentryMessages.at(-2)?.content as Array<Record<string, unknown>>;
    const results = reentryMessages.at(-1)?.content as Array<Record<string, unknown>>;
    expect(assistant.map((block) => block.id)).toEqual(["native-call-1", "client-call-1"]);
    expect(results.map((block) => block.tool_use_id)).toEqual(["native-call-1", "client-call-1"]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(mixed.readers()).toBe(1);
    expect(final.readers()).toBe(1);
  });
});
