import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import {
  NativeToolTargetUnavailableError,
  buildUpstreamRequestSnapshot,
  createRestartExactTargetTransport,
  createRetainedExactTargetTransport,
} from "../exact-target-transport.js";

const encoder = new TextEncoder();

function responseStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
      ));
      controller.close();
    },
  });
}

function sentBody(): Record<string, unknown> {
  return {
    model: "claude-test",
    max_tokens: 1_024,
    temperature: 0.2,
    stream: true,
    system: [{ type: "text", text: "injected once" }],
    tools: [{
      name: "tdai_memory_search",
      description: "memory",
      input_schema: { type: "object" },
    }],
    messages: [{ role: "user", content: "question" }],
    // This field must never enter persisted request parameters.
    untrusted_extension_field: "drop-me",
  };
}

describe("exact Anthropic target transport", () => {
  it("snapshots only replay-safe request fields and reuses retained transport exactly", async () => {
    const snapshot = buildUpstreamRequestSnapshot({
      body: sentBody(),
      url: "https://upstream.example/v1/messages",
      model: "claude-test",
      authSource: "agent",
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(responseStream(), {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "content-length": "999",
        "x-request-id": "upstream-2",
      },
    }));
    const reenter = createRetainedExactTargetTransport({
      capturedSnapshot: snapshot,
      headers: {
        "content-type": "application/json",
        "x-api-key": "secret-agent-key",
        "x-vertex-ai-session-id": "session-1",
      },
      timeoutMs: 5_000,
      fetchImpl,
    });

    const messages = [
      ...snapshot.baseMessages,
      { role: "assistant", content: [{ type: "tool_use", id: "p1" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "p1", content: "ok" }] },
    ];
    const round = await reenter({
      upstreamSnapshot: structuredClone(snapshot),
      messages,
      round: 2,
      totalCalls: 1,
    });

    expect(snapshot.requestParameters).toEqual({
      model: "claude-test",
      max_tokens: 1_024,
      temperature: 0.2,
      stream: true,
    });
    expect(snapshot.target.id).toMatch(/^sha256:/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(snapshot.target.url);
    expect(init?.headers).toEqual(expect.objectContaining({
      "x-api-key": "secret-agent-key",
      "x-vertex-ai-session-id": "session-1",
    }));
    expect(JSON.parse(String(init?.body))).toEqual({
      ...snapshot.requestParameters,
      system: snapshot.system,
      tools: snapshot.tools,
      messages,
    });
    expect(round.headers.get("content-length")).toBeNull();
    expect(round.headers.get("x-request-id")).toBe("upstream-2");
  });

  it("reconstructs permitted agent auth after restart without rerouting", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.upstream.url = "https://global.example/v1";
    config.upstream.apiKey = "global-secret";
    config.upstream.agents["claude-code"] = {
      url: "https://agent.example/v1",
      apiKey: "agent-secret",
    };
    const snapshot = buildUpstreamRequestSnapshot({
      body: sentBody(),
      url: "https://agent.example/v1/messages",
      model: "claude-test",
      authSource: "agent",
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(responseStream(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    const reenter = createRestartExactTargetTransport({
      config,
      agentSource: "claude-code",
      requestPath: "/messages",
      sessionId: "session-1",
      currentRequestHeaders: {
        "x-api-key": "client-secret",
        "x-conversation-id": "session-1",
      },
      timeoutMs: 5_000,
      fetchImpl,
    });

    await reenter({
      upstreamSnapshot: snapshot,
      messages: snapshot.baseMessages,
      round: 2,
      totalCalls: 1,
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://agent.example/v1/messages");
    expect(init?.headers).toEqual(expect.objectContaining({
      "x-api-key": "agent-secret",
      "x-vertex-ai-session-id": "session-1",
    }));
    expect(JSON.stringify(init?.headers)).not.toContain("client-secret");
  });

  it.each([
    ["an extension-owned credential", "extension" as const, "https://agent.example/v1/messages", "claude-test"],
    ["a substituted URL", "agent" as const, "https://attacker.example/v1/messages", "claude-test"],
    ["a substituted model", "agent" as const, "https://agent.example/v1/messages", "other-model"],
  ])("rejects %s instead of selecting a fallback", async (_name, authSource, url, model) => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.upstream.agents["claude-code"] = {
      url: "https://agent.example/v1",
      apiKey: "agent-secret",
    };
    const snapshot = buildUpstreamRequestSnapshot({
      body: sentBody(),
      url,
      model,
      authSource,
    });
    const fetchImpl = vi.fn<typeof fetch>();
    const reenter = createRestartExactTargetTransport({
      config,
      agentSource: "claude-code",
      requestPath: "/messages",
      sessionId: "session-1",
      currentRequestHeaders: { "x-api-key": "client-secret" },
      timeoutMs: 5_000,
      fetchImpl,
    });

    await expect(reenter({
      upstreamSnapshot: snapshot,
      messages: snapshot.baseMessages,
      round: 2,
      totalCalls: 1,
    })).rejects.toBeInstanceOf(NativeToolTargetUnavailableError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
