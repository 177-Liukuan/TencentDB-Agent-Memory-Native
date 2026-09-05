import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../config.js";
import {
  createInMemoryToolExecutionBackend,
  InMemoryToolExecutionStorageAdapter,
} from "../db/in-memory-tool-execution-storage-adapter.js";
import {
  createInMemoryNativeToolLedgerBackend,
  InMemoryNativeToolLedgerStorageAdapter,
} from "../db/in-memory-native-tool-ledger-storage-adapter.js";
import { __resetInjectionPipelineForTests } from "../injection/index.js";
import {
  __resetNativeProxyToolRuntimeForTests,
  __setNativeProxyToolRuntimeForTests,
  createNativeProxyToolRuntime,
  shutdownNativeProxyToolRuntime,
} from "../native-proxy-tools/runtime.js";
import { createApp } from "../server.js";
import { createClaudeTurnMarker } from "../native-proxy-tools/turn-marker.js";
import { __resetSessionStoreForTests, getSessionStore } from "../session/store.js";
import { setCoreKnowledgeClient } from "../knowledge/core-client.js";

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

function knowledgeCallFixture(
  id: string,
  name: "tdai_knowledge_tools_list" | "tdai_knowledge_tool_call",
  input: Record<string, unknown>,
): string {
  return messageStart(`msg-${id}`)
    + frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name, input: {} },
    })
    + frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    })
    + frame("content_block_stop", { type: "content_block_stop", index: 0 })
    + messageStop("tool_use");
}

function mixedCallFixture(
  nativeCallId = "native-call-1",
  clientCallId = "client-call-1",
): string {
  return messageStart("msg-mixed")
    + frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: nativeCallId,
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
        id: clientCallId,
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

function clientOnlyFixture(callId = "client-call-1"): string {
  return messageStart("msg-client")
    + frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: callId,
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

function finalTextFixture(text = "final answer"): string {
  return messageStart("msg-final")
    + frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })
    + frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
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
  setCoreKnowledgeClient(null);
  await shutdownNativeProxyToolRuntime();
  __resetInjectionPipelineForTests();
  __resetSessionStoreForTests();
  __resetNativeProxyToolRuntimeForTests();
});

describe("Anthropic Native Proxy Tool handler", () => {
  it.each([false, true])("keeps Native -> Client -> Client -> Native continuations across restart (initial mixed: %s)", async (mixed) => {
    const proxyConfig = config();
    const stateBackend = createInMemoryToolExecutionBackend();
    const ledgerBackend = createInMemoryNativeToolLedgerBackend();
    const ledgerScope = { spaceId: "space-1", userId: "user-1", agentSource: "claude-code", sessionId: "session-1" };
    const execute = vi.fn(async () => ({ isError: false, value: { memories: ["rule"] } }));
    const installRuntime = async () => {
      const runtime = createNativeProxyToolRuntime(proxyConfig, {
        createStorage: () => new InMemoryToolExecutionStorageAdapter({ backend: stateBackend }),
        createLedgerStorage: () => new InMemoryNativeToolLedgerStorageAdapter({ backend: ledgerBackend }),
        createDispatcher: () => ({ execute }),
      });
      await runtime.ready();
      __setNativeProxyToolRuntimeForTests(runtime);
      return runtime;
    };
    let runtime = await installRuntime();
    const turn = await runtime.ledgerStorage!.recordUserPrompt(ledgerScope);
    await installInitializedSession();
    const bodies: Record<string, unknown>[] = [];
    const fixtures = [
      ...(mixed ? [mixedCallFixture()] : [nativeCallFixture(), clientOnlyFixture()]),
      clientOnlyFixture("client-call-2"),
      nativeCallFixture().replaceAll("native-call-1", "native-call-2"),
      finalTextFixture(),
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === "https://upstream.example/v1/messages") {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const fixture = fixtures[bodies.length - 1];
        if (!fixture) throw new Error("unexpected duplicate model request");
        return singleConsumerSse(fixture).response;
      }
      return new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 });
    }));
    const app = createApp(proxyConfig);
    const headers = { "content-type": "application/json", "x-user-id": "user-1", "x-conversation-id": "session-1" };
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "Check rules and workspace" }, { type: "text", text: createClaudeTurnMarker(turn.turnToken) }] },
    ];
    const request = () => app.request("/claude-code/space-1/v1/messages", {
      method: "POST", headers,
      body: JSON.stringify({
        model: "claude-test", stream: true, max_tokens: 1024, system: "original system", messages,
        tools: [{ name: "client_shell", description: "shell", input_schema: { type: "object" } }],
      }),
    });
    const first = await request();
    const firstText = await first.text();
    expect(first.status, firstText).toBe(200);
    expect(firstText).toContain("client-call-1");
    expect(firstText).not.toContain("native-call");

    for (const callId of ["client-call-1", "client-call-2"]) {
      // 清掉进程内对象，仅复用已保存数据，验证恢复不依赖同一个 Coordinator 或内存请求。
      await shutdownNativeProxyToolRuntime();
      __resetNativeProxyToolRuntimeForTests();
      runtime = await installRuntime();
      messages.push(
        { role: "assistant", content: [{ type: "tool_use", id: callId, name: "client_shell", input: { command: "pwd" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: "/workspace" }] },
      );
      const response = await request();
      const text = await response.text();
      expect(response.status, text).toBe(200);
      expect(text).toContain(callId === "client-call-1" ? "client-call-2" : "final answer");
      expect(text).not.toContain("native-call");
      expect(text).not.toContain("tdai_memory_search");
      const requestCount = bodies.length;
      const replay = await request();
      expect(replay.status).toBe(200);
      expect(await replay.text()).toBe(text);
      expect(bodies).toHaveLength(requestCount);
    }
    expect(execute).toHaveBeenCalledTimes(2);
    expect(bodies).toHaveLength(mixed ? 4 : 5);
    const lastMessages = bodies.at(-1)!.messages as Array<{ content: unknown }>;
    const calls = lastMessages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((block) => block.type === "tool_use").map((block) => block.id);
    const results = lastMessages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((block) => block.type === "tool_result").map((block) => block.tool_use_id);
    expect(calls).toEqual(["native-call-1", "client-call-1", "client-call-2", "native-call-2"]);
    expect(results).toEqual(calls);
    for (const body of bodies.slice(1)) {
      expect(body.system).toEqual(bodies[0].system);
      expect(body.tools).toEqual(bodies[0].tools);
    }
    expect(await runtime.ledgerStorage!.findRounds(ledgerScope, 0)).toHaveLength(2);
    expect([...stateBackend.rows.values()].filter((state) => state.slots.some((slot) => slot.owner === "client")))
      .toEqual([expect.objectContaining({ clientDispatchStatus: "completed" }), expect.objectContaining({ clientDispatchStatus: "completed" })]);

    // 当前续写正确还不够：下一次真实用户请求必须仅靠长期记录还原同样的顺序。
    await shutdownNativeProxyToolRuntime();
    __resetNativeProxyToolRuntimeForTests();
    stateBackend.rows.clear();
    runtime = await installRuntime();
    const nextTurn = await runtime.ledgerStorage!.recordUserPrompt(ledgerScope);
    messages.push(
      { role: "assistant", content: "final answer" },
      { role: "user", content: [{ type: "text", text: "Next question" }, { type: "text", text: createClaudeTurnMarker(nextTurn.turnToken) }] },
    );
    fixtures.push(finalTextFixture("next answer"));
    const next = await request();
    expect(next.status, await next.clone().text()).toBe(200);
    expect(await next.text()).toContain("next answer");
    const restoredBlocks = (bodies.at(-1)!.messages as Array<{ content: unknown }>).flatMap((message) => Array.isArray(message.content) ? message.content : []);
    expect(restoredBlocks.filter((block) => block.type === "tool_use").map((block) => block.id))
      .toEqual(["native-call-1", "client-call-1", "client-call-2", "native-call-2"]);
    expect(restoredBlocks.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id))
      .toEqual(["native-call-1", "client-call-1", "client-call-2", "native-call-2"]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("executes the two-step Knowledge Native Tool flow and hides both internal rounds", async () => {
    const proxyConfig = config();
    // 验证 Knowledge 可以独立开启，不依赖 Memory 工具开关碰巧把注入链路带起来。
    proxyConfig.tdai.memory.enabled = false;
    proxyConfig.knowledge.enabled = true;
    proxyConfig.knowledge.serviceToken = "knowledge-secret";
    const knowledgeResource = {
      knowledge_id: "wiki-1",
      type: "wiki" as const,
      service_url: "https://knowledge.example/v3",
      name: "Architecture",
      summary: "Design decisions",
      team_id: "team-1",
      user_id: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    setCoreKnowledgeClient({
      listAgentKnowledgeIds: vi.fn(async () => ["wiki-1"]),
      listKnowledgeByIds: vi.fn(async () => [knowledgeResource]),
    } as never);
    const runtime = createNativeProxyToolRuntime(proxyConfig, {
      createStorage: () => new InMemoryToolExecutionStorageAdapter(),
      createLedgerStorage: () => new InMemoryNativeToolLedgerStorageAdapter(),
    });
    await runtime.ready();
    __setNativeProxyToolRuntimeForTests(runtime);
    await getSessionStore().set("claude-code:session-1", {
      status: "initialized",
      keyId: "claude-code:session-1",
      startedAt: Date.now(),
      attemptCount: 0,
      userId: "user-1",
      sessionInfo: {
        session_id: "session-1",
        team_id: "team-1",
        agent_id: "agent-1",
        user_id: "user-1",
        user_key: "client-key",
        space_id: "space-1",
      },
    });

    const upstreamBodies: Record<string, unknown>[] = [];
    const providerBodies: Record<string, unknown>[] = [];
    const modelResponses = [
      knowledgeCallFixture("knowledge-list-1", "tdai_knowledge_tools_list", { knowledge_id: "wiki-1" }),
      knowledgeCallFixture("knowledge-call-1", "tdai_knowledge_tool_call", {
        knowledge_id: "wiki-1",
        tool_name: "search",
        params: { query: "routing" },
      }),
      finalTextFixture("Knowledge says routing is centralized"),
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === "https://tdai.example/v3/meta/config/user/get") {
        return new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 });
      }
      if (href === "https://upstream.example/v1/messages") {
        upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return singleConsumerSse(modelResponses[upstreamBodies.length - 1]).response;
      }
      if (href === "https://knowledge.example/v3/tools/list") {
        providerBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({
          code: 0,
          data: {
            knowledge_id: "wiki-1",
            tools: [{
              name: "search",
              description: "search wiki",
              params: { query: { type: "string", required: true } },
            }],
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (href === "https://knowledge.example/v3/tools/call") {
        providerBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer knowledge-secret");
        expect(new Headers(init?.headers).get("x-tdai-service-id")).toBe("space-1");
        return new Response(JSON.stringify({
          code: 0,
          data: { results: [{ title: "Routing", text: "Routing is centralized" }] },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }));

    const response = await createApp(proxyConfig).request("/claude-code/space-1/v1/messages", {
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
        system: "You are Claude Code",
        messages: [{ role: "user", content: "Why is routing designed this way?" }],
      }),
    });
    const visible = await response.text();

    expect(response.status).toBe(200);
    expect(visible).toContain("Knowledge says routing is centralized");
    expect(visible).not.toMatch(/tdai_knowledge|knowledge-list-1|knowledge-call-1/);
    expect(upstreamBodies).toHaveLength(3);
    expect(upstreamBodies[0].tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "tdai_knowledge_tools_list" }),
      expect.objectContaining({ name: "tdai_knowledge_tool_call" }),
    ]));
    expect(JSON.stringify(upstreamBodies[1].messages)).toContain("knowledge-list-1");
    expect(JSON.stringify(upstreamBodies[2].messages)).toContain("knowledge-call-1");
    expect(JSON.stringify(upstreamBodies[2].messages)).toContain("Routing is centralized");
    expect(providerBodies).toEqual([
      { knowledge_id: "wiki-1" },
      { knowledge_id: "wiki-1" },
      { knowledge_id: "wiki-1", tool_name: "search", params: { query: "routing" } },
    ]);
  });

  it("forwards Claude Code internal WebSearch without requiring a turn marker", async () => {
    const proxyConfig = config();
    proxyConfig.ccRequestRouting.enabled = false;
    const ledgerStorage = new InMemoryNativeToolLedgerStorageAdapter();
    const scope = {
      spaceId: "space-1",
      userId: "user-1",
      agentSource: "claude-code",
      sessionId: "session-1",
    };
    await ledgerStorage.recordUserPrompt(scope);
    const runtime = createNativeProxyToolRuntime(proxyConfig, {
      createStorage: () => new InMemoryToolExecutionStorageAdapter(),
      createLedgerStorage: () => ledgerStorage,
    });
    await runtime.ready();
    __setNativeProxyToolRuntimeForTests(runtime);
    await installInitializedSession();

    const upstreamBodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === "https://tdai.example/v3/meta/config/user/get") {
        return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url) === "https://upstream.example/v1/messages") {
        upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return singleConsumerSse(finalTextFixture("search complete")).response;
      }
      return new Response("not found", { status: 404 });
    }));

    const webSearchTool = {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 8,
    };
    const response = await createApp(proxyConfig).request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-user-id": "user-1",
        "x-claude-code-session-id": "session-1",
      },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 1_024,
        stream: true,
        system: "You are an assistant for performing a web search tool use",
        messages: [{ role: "user", content: "Perform a web search for the query: Shenzhen weather" }],
        tools: [webSearchTool],
        tool_choice: { type: "auto" },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("search complete");
    expect(upstreamBodies).toHaveLength(1);
    expect(upstreamBodies[0]?.tools).toEqual([webSearchTool]);
    expect(JSON.stringify(upstreamBodies[0])).not.toContain("tdai_memory_search");
  });

  it("does not create compression records from summary-like text in an ordinary Messages request", async () => {
    const proxyConfig = config();
    const ledgerStorage = new InMemoryNativeToolLedgerStorageAdapter();
    const originalMessages = [{ role: "user", content: "What rules apply?" }];
    const runtime = createNativeProxyToolRuntime(proxyConfig, {
      createStorage: () => new InMemoryToolExecutionStorageAdapter(),
      createLedgerStorage: () => ledgerStorage,
    });
    await runtime.ready();
    __setNativeProxyToolRuntimeForTests(runtime);
    await installInitializedSession();

    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      if (String(url) === "https://tdai.example/v3/meta/config/user/get") {
        return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url) === "https://upstream.example/v1/messages") {
        return singleConsumerSse(finalTextFixture("summary response")).response;
      }
      return new Response("not found", { status: 404 });
    }));

    const response = await createApp(proxyConfig).request("/claude-code/space-1/v1/messages", {
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
        messages: [
          ...originalMessages,
          { role: "assistant", content: "previous answer" },
          { role: "user", content: "Provide a detailed summary of our conversation so far." },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("summary response");
    await expect(ledgerStorage.getSessionContext({
      spaceId: "space-1",
      userId: "user-1",
      agentSource: "claude-code",
      sessionId: "session-1",
    })).resolves.toMatchObject({ currentEpoch: 0, pendingCompactEpoch: null });
  });

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

  it("fails closed instead of forwarding when long-term history cannot be queried", async () => {
    const proxyConfig = config();
    const ledgerStorage = new InMemoryNativeToolLedgerStorageAdapter();
    vi.spyOn(ledgerStorage, "findRounds").mockRejectedValue(new Error("secret database detail"));
    const runtime = createNativeProxyToolRuntime(proxyConfig, {
      createStorage: () => new InMemoryToolExecutionStorageAdapter(),
      createLedgerStorage: () => ledgerStorage,
    });
    await runtime.ready();
    __setNativeProxyToolRuntimeForTests(runtime);
    await installInitializedSession();
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === "https://tdai.example/v3/meta/config/user/get") {
        return new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 });
      }
      return new Response("unexpected upstream call", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await createApp(proxyConfig).request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "user-1", "x-conversation-id": "session-1" },
      body: JSON.stringify({ model: "claude-test", stream: true, messages: [{ role: "user", content: "question" }] }),
    });
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(text).toContain("native_tool_history_unavailable");
    expect(text).not.toContain("secret database detail");
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "https://upstream.example/v1/messages")).toBe(false);
  });

  it("uses the exact successful target and replays a pure-Native final after restart", async () => {
    const proxyConfig = config();
    const backend = createInMemoryToolExecutionBackend();
    const storage = new InMemoryToolExecutionStorageAdapter({ backend });
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
    const requestInit = {
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
    };
    const response = await app.request("/claude-code/space-1/v1/messages", requestInit);
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
    await expect(storage.findActiveBySession({
      spaceId: "space-1",
      userId: "user-1",
      agentSource: "claude-code",
      sessionId: "session-1",
      contextVersion: "epoch:0",
    })).resolves.toEqual([
      expect.objectContaining({
        observationStatus: "completed",
        observationAttempt: 1,
        observationOutcome: expect.objectContaining({ status: 200 }),
      }),
    ]);

    await shutdownNativeProxyToolRuntime();
    __resetNativeProxyToolRuntimeForTests();
    __resetSessionStoreForTests();
    const restartedStorage = new InMemoryToolExecutionStorageAdapter({ backend });
    const restartedRuntime = createNativeProxyToolRuntime(proxyConfig, {
      createStorage: () => restartedStorage,
      createDispatcher: () => ({ execute }),
    });
    await restartedRuntime.ready();
    __setNativeProxyToolRuntimeForTests(restartedRuntime);

    const replay = await app.request("/claude-code/space-1/v1/messages", requestInit);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain("final answer");
    expect(upstreamCalls).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(restartedStorage.findActiveBySession({
      spaceId: "space-1",
      userId: "user-1",
      agentSource: "claude-code",
      sessionId: "session-1",
      contextVersion: "epoch:0",
    })).resolves.toEqual([
      expect.objectContaining({
        observationStatus: "completed",
        observationAttempt: 1,
      }),
    ]);
  });

  it("restores a completed hidden Native call in the next Claude Code request exactly once", async () => {
    const proxyConfig = config();
    const stateBackend = createInMemoryToolExecutionBackend();
    const ledgerBackend = createInMemoryNativeToolLedgerBackend();
    const ledgerStorage = new InMemoryNativeToolLedgerStorageAdapter({ backend: ledgerBackend });
    const ledgerScope = { spaceId: "space-1", userId: "user-1", agentSource: "claude-code", sessionId: "session-1" };
    const firstTurn = await ledgerStorage.recordUserPrompt(ledgerScope);
    let runtime = createNativeProxyToolRuntime(proxyConfig, {
      createStorage: () => new InMemoryToolExecutionStorageAdapter({ backend: stateBackend }),
      createLedgerStorage: () => new InMemoryNativeToolLedgerStorageAdapter({ backend: ledgerBackend }),
      createDispatcher: () => ({
        execute: async () => ({ isError: false, value: { items: [{ memory: "project rule" }] } }),
      }),
    });
    await runtime.ready();
    __setNativeProxyToolRuntimeForTests(runtime);
    await installInitializedSession();

    const upstreamBodies: Record<string, unknown>[] = [];
    const responses = [
      singleConsumerSse(nativeCallFixture()).response,
      singleConsumerSse(finalTextFixture("first answer")).response,
      singleConsumerSse(finalTextFixture("second answer")).response,
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === "https://tdai.example/v3/meta/config/user/get") {
        return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (href === "https://upstream.example/v1/messages") {
        upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return responses[upstreamBodies.length - 1];
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
    // 模拟 Claude Code 2.1.260 的真实消息形态：Hook 标记可能附在一条临时
    // system 消息后面，而 Anthropic Adapter 随后会把该消息移出 messages。
    const hookContext = (marker: string): string => (
      `Available agents and skills\n\nUserPromptSubmit hook additional context: ${marker}`
    );

    const first = await app.request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 1_024,
        stream: true,
        system: "You are Claude Code",
        messages: [
          { role: "user", content: "What rules apply?" },
          { role: "system", content: hookContext(createClaudeTurnMarker(firstTurn.turnToken)) },
        ],
      }),
    });
    expect(await first.text()).toContain("first answer");

    await shutdownNativeProxyToolRuntime();
    __resetNativeProxyToolRuntimeForTests();
    for (const state of stateBackend.rows.values()) {
      state.expiresAt = "2026-01-01T00:00:00.000Z";
    }
    runtime = createNativeProxyToolRuntime(proxyConfig, {
      createStorage: () => new InMemoryToolExecutionStorageAdapter({ backend: stateBackend }),
      createLedgerStorage: () => new InMemoryNativeToolLedgerStorageAdapter({ backend: ledgerBackend }),
      createDispatcher: () => ({
        execute: async () => ({ isError: false, value: { items: [{ memory: "should not execute" }] } }),
      }),
    });
    await runtime.ready();
    __setNativeProxyToolRuntimeForTests(runtime);
    const secondTurn = await ledgerStorage.recordUserPrompt(ledgerScope);

    const second = await app.request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 1_024,
        stream: true,
        system: "You are Claude Code",
        messages: [
          { role: "user", content: "What rules apply?" },
          { role: "system", content: hookContext(createClaudeTurnMarker(firstTurn.turnToken)) },
          { role: "assistant", content: "first answer" },
          { role: "user", content: "What about now?" },
          { role: "system", content: `UserPromptSubmit hook additional context: ${createClaudeTurnMarker(secondTurn.turnToken)}` },
        ],
      }),
    });
    expect(await second.text()).toContain("second answer");
    expect(upstreamBodies).toHaveLength(3);

    const restoredMessages = upstreamBodies[2].messages as Array<Record<string, unknown>>;
    expect(restoredMessages.map((message) => message.role)).toEqual([
      "user", "assistant", "user", "assistant", "user",
    ]);
    expect(restoredMessages[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(restoredMessages[0].content)).toContain("What rules apply?");
    expect(restoredMessages[1]).toMatchObject({
      role: "assistant",
      content: [expect.objectContaining({ type: "tool_use", id: "native-call-1" })],
    });
    expect(restoredMessages[2]).toMatchObject({
      role: "user",
      content: [expect.objectContaining({ type: "tool_result", tool_use_id: "native-call-1" })],
    });
    expect(restoredMessages[3]).toMatchObject({ role: "assistant" });
    expect(JSON.stringify(restoredMessages[3].content)).toContain("first answer");
    expect(restoredMessages[4]).toMatchObject({ role: "user" });
    expect(JSON.stringify(restoredMessages[4].content)).toContain("What about now?");
    expect(restoredMessages.some((message) => message.role === "system")).toBe(false);
    const serialized = JSON.stringify(restoredMessages);
    expect(serialized.match(/native-call-1/g)).toHaveLength(2);
    expect(serialized.match(/tdai_memory_search/g)).toHaveLength(1);
    expect(serialized).toContain("project rule");
  });

  it("simulates Claude Hook compaction: includes old Native history in compact input and excludes it afterwards", async () => {
    const proxyConfig = config();
    const runtime = createNativeProxyToolRuntime(proxyConfig, {
      createStorage: () => new InMemoryToolExecutionStorageAdapter(),
      createDispatcher: () => ({ execute: async () => ({ isError: false, value: { memory: "hidden rule" } }) }),
    });
    await runtime.ready();
    __setNativeProxyToolRuntimeForTests(runtime);
    await installInitializedSession();
    const upstreamBodies: Record<string, unknown>[] = [];
    const responses = [
      singleConsumerSse(nativeCallFixture()).response,
      singleConsumerSse(finalTextFixture("first answer")).response,
      singleConsumerSse(finalTextFixture("compacted summary")).response,
      singleConsumerSse(finalTextFixture("after compact")).response,
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === "https://tdai.example/v3/meta/config/user/get") {
        return new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (String(url) === "https://upstream.example/v1/messages") {
        upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return responses[upstreamBodies.length - 1];
      }
      return new Response("not found", { status: 404 });
    }));
    const app = createApp(proxyConfig);
    const headers = { "content-type": "application/json", "x-user-id": "user-1", "x-conversation-id": "session-1" };
    // 按 Claude Code 2.1.260 的真实格式模拟 Hook additionalContext。
    const wrapHookContext = (marker: string): string => `UserPromptSubmit hook additional context: ${marker}`;
    const hook = async (payload: Record<string, unknown>): Promise<Response> => app.request(
      "/claude-code/space-1/hooks/claude-code/context",
      { method: "POST", headers, body: JSON.stringify({ session_id: "session-1", ...payload }) },
    );
    const turnOneBody = await (await hook({ hook_event_name: "UserPromptSubmit", prompt: "question" })).json() as Record<string, any>;
    const markerOne = turnOneBody.hookSpecificOutput.additionalContext as string;
    const firstMessages = [{ role: "user", content: [{ type: "text", text: "question" }, { type: "text", text: wrapHookContext(markerOne) }] }];
    const first = await app.request("/claude-code/space-1/v1/messages", {
      method: "POST", headers,
      body: JSON.stringify({ model: "claude-test", max_tokens: 1_024, stream: true, messages: firstMessages }),
    });
    expect(await first.text()).toContain("first answer");

    expect((await hook({ hook_event_name: "PreCompact", trigger: "manual" })).status).toBe(204);
    const compact = await app.request("/claude-code/space-1/v1/messages", {
      method: "POST", headers,
      body: JSON.stringify({ model: "claude-test", max_tokens: 1_024, stream: true, messages: [
        ...firstMessages,
        { role: "assistant", content: "first answer" },
        { role: "user", content: "make concise notes" },
      ] }),
    });
    expect(await compact.text()).toContain("compacted summary");
    expect(JSON.stringify(upstreamBodies[2].messages).match(/native-call-1/g)).toHaveLength(2);
    expect((await hook({ hook_event_name: "PostCompact", trigger: "manual" })).status).toBe(204);

    const turnTwoBody = await (await hook({ hook_event_name: "UserPromptSubmit", prompt: "continue" })).json() as Record<string, any>;
    const markerTwo = turnTwoBody.hookSpecificOutput.additionalContext as string;
    const after = await app.request("/claude-code/space-1/v1/messages", {
      method: "POST", headers,
      body: JSON.stringify({ model: "claude-test", max_tokens: 1_024, stream: true, messages: [
        { role: "user", content: "compacted summary" },
        { role: "user", content: [{ type: "text", text: "continue" }, { type: "text", text: wrapHookContext(markerTwo) }] },
      ] }),
    });
    expect(await after.text()).toContain("after compact");
    expect(JSON.stringify(upstreamBodies[3].messages)).not.toContain("native-call-1");
  });

  it("keeps a durable final pending when its original observation intent is missing", async () => {
    const proxyConfig = config();
    const backend = createInMemoryToolExecutionBackend();
    const storage = new InMemoryToolExecutionStorageAdapter({ backend });
    const prepareObservation = storage.prepareObservation.bind(storage);
    vi.spyOn(storage, "prepareObservation").mockImplementation(async (preparation) => {
      const prepared = await prepareObservation(preparation);
      if (prepared) {
        const persisted = [...backend.rows.values()].find((context) => (
          context.key.toolBatchId === preparation.key.toolBatchId
        ));
        if (persisted) delete persisted.upstreamSnapshot.observationIntent;
      }
      return prepared;
    });
    const execute = vi.fn(async () => ({ isError: false, value: { items: [] } }));
    const runtime = createNativeProxyToolRuntime(proxyConfig, {
      createStorage: () => storage,
      createDispatcher: () => ({ execute }),
    });
    await runtime.ready();
    __setNativeProxyToolRuntimeForTests(runtime);
    await installInitializedSession();

    const responses = [
      singleConsumerSse(nativeCallFixture()).response,
      singleConsumerSse(finalTextFixture()).response,
    ];
    let upstreamCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === "https://tdai.example/v3/meta/config/user/get") {
        return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (href === "https://upstream.example/v1/messages") {
        return responses[upstreamCalls++];
      }
      return new Response("not found", { status: 404 });
    }));
    const app = createApp(proxyConfig);
    const requestInit = {
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
        messages: [{ role: "user", content: "What rules apply?" }],
      }),
    };

    const first = await app.request("/claude-code/space-1/v1/messages", requestInit);
    expect(first.status).toBe(503);
    expect(await first.text()).toContain("native_tool_observation_payload_unavailable");
    const retry = await app.request("/claude-code/space-1/v1/messages", requestInit);
    expect(retry.status).toBe(503);
    expect(await retry.text()).toContain("native_tool_observation_payload_unavailable");
    expect(upstreamCalls).toBe(2);
    expect(execute).toHaveBeenCalledTimes(1);
    const pendingStates = await storage.findActiveBySession({
      spaceId: "space-1",
      userId: "user-1",
      agentSource: "claude-code",
      sessionId: "session-1",
      contextVersion: "epoch:0",
    });
    expect(pendingStates).toEqual([
      expect.objectContaining({
        observationStatus: "pending",
      }),
    ]);
    expect(pendingStates[0]).not.toHaveProperty("observationAttempt");
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
      contextVersion: "epoch:0",
    })).toEqual([]);
  });

  it("keeps retained client credentials isolated by batch during reverse-order resume", async () => {
    const proxyConfig = config();
    proxyConfig.upstream.agents = {};
    proxyConfig.upstream.apiKey = "";
    const storage = new InMemoryToolExecutionStorageAdapter();
    const runtime = createNativeProxyToolRuntime(proxyConfig, {
      createStorage: () => storage,
      createDispatcher: () => ({
        execute: async () => ({ isError: false, value: { items: [] } }),
      }),
    });
    await runtime.ready();
    __setNativeProxyToolRuntimeForTests(runtime);
    await installInitializedSession();
    const upstreamCalls: Array<{
      apiKey: string | null;
      body: Record<string, unknown>;
    }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === "https://tdai.example/v3/meta/config/user/get") {
        return new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 });
      }
      if (href !== "https://upstream.example/v1/messages") {
        return new Response("not found", { status: 404 });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      upstreamCalls.push({ apiKey: new Headers(init?.headers).get("x-api-key"), body });
      const messages = body.messages as Array<Record<string, unknown>>;
      const latest = messages.at(-1);
      const latestContent = latest?.content;
      const toolResultId = Array.isArray(latestContent)
        ? (latestContent.find((block) => (
            block !== null
            && typeof block === "object"
            && (block as Record<string, unknown>).type === "tool_result"
          )) as Record<string, unknown> | undefined)?.tool_use_id
        : undefined;
      if (toolResultId) return singleConsumerSse(finalTextFixture()).response;
      const userText = typeof messages[0]?.content === "string"
        ? messages[0].content
        : JSON.stringify(messages[0]?.content ?? "");
      const suffix = userText.includes("batch-a") ? "a" : "b";
      return singleConsumerSse(mixedCallFixture(`native-${suffix}`, `client-${suffix}`)).response;
    }));
    const app = createApp(proxyConfig);
    const baseBody = (label: string) => ({
      model: "claude-test",
      max_tokens: 256,
      stream: true,
      tools: [{ name: "client_shell", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: label }],
    });
    const initialRequest = (label: string, apiKey: string) => app.request(
      "/claude-code/space-1/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "x-user-id": "user-1",
          "x-conversation-id": "session-1",
        },
        body: JSON.stringify(baseBody(label)),
      },
    );
    const [initialA, initialB] = await Promise.all([
      initialRequest("batch-a", "initial-key-a"),
      initialRequest("batch-b", "initial-key-b"),
    ]);
    expect(await initialA.text()).toContain("client-a");
    expect(await initialB.text()).toContain("client-b");

    const resumeRequest = (suffix: "a" | "b") => app.request(
      "/claude-code/space-1/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "resume-placeholder",
          "x-user-id": "user-1",
          "x-conversation-id": "session-1",
        },
        body: JSON.stringify({
          model: "claude-test",
          max_tokens: 256,
          stream: true,
          messages: [
            { role: "user", content: `batch-${suffix}` },
            {
              role: "assistant",
              content: [{
                type: "tool_use",
                id: `client-${suffix}`,
                name: "client_shell",
                input: { command: "pwd" },
              }],
            },
            {
              role: "user",
              content: [{
                type: "tool_result",
                tool_use_id: `client-${suffix}`,
                content: `/workspace/${suffix}`,
              }],
            },
          ],
        }),
      },
    );
    const resumedB = await resumeRequest("b");
    const resumedA = await resumeRequest("a");
    expect(await resumedB.text()).toContain("final answer");
    expect(await resumedA.text()).toContain("final answer");

    const resumedCalls = upstreamCalls.slice(-2);
    expect(resumedCalls.map(({ apiKey, body }) => {
      const messages = body.messages as Array<Record<string, unknown>>;
      const result = (messages.at(-1)?.content as Array<Record<string, unknown>>)
        .find((block) => (
          block.type === "tool_result"
          && typeof block.tool_use_id === "string"
          && block.tool_use_id.startsWith("client-")
        ));
      return [result?.tool_use_id, apiKey];
    })).toEqual([
      ["client-b", "initial-key-b"],
      ["client-a", "initial-key-a"],
    ]);
  });

  it("does not execute a reserved-name upstream call when this request did not receive the Native definition", async () => {
    const proxyConfig = config();
    proxyConfig.tdai.memory.enabled = false;
    const storage = new InMemoryToolExecutionStorageAdapter();
    const execute = vi.fn(async () => ({ isError: false, value: null }));
    const runtime = createNativeProxyToolRuntime(proxyConfig, {
      createStorage: () => storage,
      createDispatcher: () => ({ execute }),
    });
    await runtime.ready();
    __setNativeProxyToolRuntimeForTests(runtime);
    await installInitializedSession();
    const upstream = singleConsumerSse(nativeCallFixture());
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === "https://tdai.example/v3/meta/config/user/get") {
        return new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 });
      }
      if (href === "https://upstream.example/v1/messages") return upstream.response;
      return new Response("not found", { status: 404 });
    }));

    const response = await createApp(proxyConfig).request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-key",
        "x-user-id": "user-1",
        "x-conversation-id": "session-1",
      },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "question" }],
      }),
    });

    expect(await response.text()).toBe(nativeCallFixture());
    expect(execute).not.toHaveBeenCalled();
    expect(upstream.readers()).toBeLessThanOrEqual(1);
  });

  it("rejects a Client definition that uses a proxy-reserved tool name before forwarding", async () => {
    const proxyConfig = config();
    proxyConfig.tdai.memory.enabled = false;
    const storage = new InMemoryToolExecutionStorageAdapter();
    const runtime = createNativeProxyToolRuntime(proxyConfig, { createStorage: () => storage });
    await runtime.ready();
    __setNativeProxyToolRuntimeForTests(runtime);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await createApp(proxyConfig).request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-conversation-id": "session-1" },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 128,
        stream: true,
        tools: [{ name: "tdai_memory_search", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: "question" }],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("reserved by the proxy");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a generic streaming upstream error after Native schemas were injected", async () => {
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
    const exactError = JSON.stringify({ type: "error", marker: "upstream-503" });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === "https://tdai.example/v3/meta/config/user/get") {
        return new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 });
      }
      if (href === "https://upstream.example/v1/messages") {
        return new Response(exactError, {
          status: 503,
          headers: { "content-type": "application/json", "x-request-id": "upstream-error" },
        });
      }
      return new Response("not found", { status: 404 });
    }));

    const response = await createApp(proxyConfig).request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-key",
        "x-user-id": "user-1",
        "x-conversation-id": "session-1",
      },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "question" }],
      }),
    });

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Upstream model request failed");
    expect(response.headers.get("x-request-id")).toBe("upstream-error");
    expect(execute).not.toHaveBeenCalled();
  });

  it("sanitizes a streaming upstream non-2xx response that echoes the injected Native Registry", async () => {
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
    const leakedError = JSON.stringify({
      type: "error",
      marker: "tdai_memory_search",
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === "https://tdai.example/v3/meta/config/user/get") {
        return new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 });
      }
      if (href === "https://upstream.example/v1/messages") {
        return new Response(leakedError, {
          status: 503,
          headers: { "content-type": "application/json", "x-request-id": "upstream-error" },
        });
      }
      return new Response("not found", { status: 404 });
    }));

    const response = await createApp(proxyConfig).request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-key",
        "x-user-id": "user-1",
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

    expect(response.status).toBe(503);
    expect(responseText).toContain("Upstream model request failed");
    expect(responseText).not.toContain("tdai_memory_search");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["tool name", "tdai_memory_search"],
    ["call ID", "native-call-1"],
    ["serialized input", '{"query":"project rules"}'],
  ])("allows mixed-resume text to mention the old Native %s", async (_label, leakedMarker) => {
    const proxyConfig = config();
    const storage = new InMemoryToolExecutionStorageAdapter();
    const runtime = createNativeProxyToolRuntime(proxyConfig, {
      createStorage: () => storage,
      createDispatcher: () => ({
        execute: async () => ({ isError: false, value: { items: [] } }),
      }),
    });
    await runtime.ready();
    __setNativeProxyToolRuntimeForTests(runtime);
    await installInitializedSession();
    const rounds = [
      singleConsumerSse(mixedCallFixture()).response,
      singleConsumerSse(finalTextFixture(leakedMarker)).response,
    ];
    let upstreamCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === "https://tdai.example/v3/meta/config/user/get") {
        return new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 });
      }
      if (href === "https://upstream.example/v1/messages") {
        return rounds[upstreamCalls++] ?? new Response("unexpected", { status: 500 });
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
    const initial = await app.request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 256,
        stream: true,
        tools: [{ name: "client_shell", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: "question" }],
      }),
    });
    expect((await initial.text())).toContain("client-call-1");

    const resumed = await app.request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 256,
        stream: true,
        messages: [
          { role: "user", content: "question" },
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
    const responseText = await resumed.text();

    expect(resumed.status).toBe(200);
    expect(responseText).toContain(JSON.stringify(leakedMarker).slice(1, -1));
    expect(upstreamCalls).toBe(2);
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

    // Same-process continuation must use the retained successful transport,
    // even if live routing/auth configuration changes before Client results.
    proxyConfig.upstream.agents = {};
    proxyConfig.upstream.url = "https://changed.example/v1";
    proxyConfig.upstream.apiKey = "changed-key";

    const resumeBody = {
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
    };
    const resumed = app.request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(resumeBody),
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
    const completedParent = (await storage.findActiveBySession({
      spaceId: "space-1",
      userId: "user-1",
      agentSource: "claude-code",
      sessionId: "session-1",
      contextVersion: "epoch:0",
    })).find((state) => state.slots.some((slot) => slot.callId === "client-call-1"));
    expect(completedParent).toMatchObject({
      clientDispatchStatus: "completed",
      observationStatus: "completed",
      observationAttempt: 1,
    });

    const replayedResponse = await app.request("/claude-code/space-1/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(resumeBody),
    });
    expect(replayedResponse.status).toBe(200);
    expect(await replayedResponse.text()).toBe(resumedText);
    expect(upstreamCalls).toHaveLength(2);
  });
});
