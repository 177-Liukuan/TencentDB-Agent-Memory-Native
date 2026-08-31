import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import { AnthropicAdapter } from "../../injection/adapters/anthropic.js";
import {
  __resetInjectionPipelineForTests,
  getInjectionPipeline,
} from "../../injection/index.js";
import { InjectionPipeline, CriticalInjectionHookError } from "../../injection/pipeline.js";
import { HookRegistryImpl } from "../../injection/registry.js";
import type {
  AgentContext,
  AgentContextMetadata,
  InjectionHook,
} from "../../injection/types.js";
import {
  NativeProxyToolNameCollisionError,
  NativeProxyToolsInjector,
  describeNativeProxyToolInjectionFailure,
} from "../native-proxy-tools-injector.js";
import { createDefaultNativeProxyToolRegistry } from "../tool-registry.js";

const metadata: AgentContextMetadata = {
  protocol: "anthropic",
  traceId: "trace-1",
  keyId: "key-1",
  modelId: "claude-test",
  stream: true,
  agentSource: "claude-code",
  userId: "user-1",
  spaceId: "space-1",
  sessionKey: "session-1",
  custom: {
    session: {
      session_id: "session-1",
      team_id: "team-1",
      agent_id: "agent-1",
      user_id: "user-1",
    },
    assetCapabilities: {
      skill: true,
      llm_wiki: true,
      code_graph: true,
      chat_memory: true,
    },
  },
};

afterEach(() => {
  __resetInjectionPipelineForTests();
});

function initializedAnthropicContext(
  overrides: Partial<AgentContextMetadata> = {},
): AgentContext {
  return {
    messages: [
      { role: "system", blocks: [{ type: "text", content: "system" }] },
      { role: "user", blocks: [{ type: "text", content: "remembered rules?" }] },
    ],
    tools: [],
    requestParams: { model: "claude-test", stream: overrides.stream ?? true },
    metadata: {
      ...metadata,
      ...overrides,
      custom: overrides.custom ?? metadata.custom,
    },
  };
}

describe("Native Proxy Tool Registry", () => {
  it("registers exactly one read-only Memory search tool", () => {
    const registry = createDefaultNativeProxyToolRegistry();

    expect(registry.list().map((tool) => tool.name)).toEqual(["tdai_memory_search"]);
    expect(registry.require("tdai_memory_search")).toMatchObject({
      owner: "proxy",
      effect: "read",
      route: "atomic/search",
    });
    expect(registry.owns("client_tool")).toBe(false);
  });

  it("normalizes valid input and applies the default result limit", () => {
    const tool = createDefaultNativeProxyToolRegistry().require("tdai_memory_search");

    expect(tool.validate({ query: "  project rules  " })).toEqual({
      ok: true,
      value: { query: "project rules", limit: 5 },
    });
    expect(tool.validate({ query: "identity", limit: 20 })).toEqual({
      ok: true,
      value: { query: "identity", limit: 20 },
    });
  });

  it.each([
    [null, "object"],
    [[], "object"],
    [{}, "query"],
    [{ query: "   " }, "query"],
    [{ query: "x".repeat(2_001) }, "query"],
    [{ query: "x", limit: 1.5 }, "limit"],
    [{ query: "x", limit: 0 }, "limit"],
    [{ query: "x", limit: 21 }, "limit"],
    [{ query: "x", identity: "attacker" }, "unknown"],
  ])("rejects unsafe Memory search input %#", (input, expectedMessage) => {
    const result = createDefaultNativeProxyToolRegistry()
      .require("tdai_memory_search")
      .validate(input);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(expectedMessage);
  });

  it("throws for a required tool name that the proxy does not own", () => {
    expect(() => createDefaultNativeProxyToolRegistry().require("missing"))
      .toThrow(/missing/);
  });
});

describe("Native Proxy Tool injection", () => {
  it.each([
    { stream: false, enabled: true, expected: 0 },
    { stream: true, enabled: false, expected: 0 },
    { stream: true, enabled: true, expected: 1 },
  ])("applies streaming and feature visibility", async ({ stream, enabled, expected }) => {
    const injector = new NativeProxyToolsInjector({
      enabled,
      registry: createDefaultNativeProxyToolRegistry(),
    });

    expect(injector.execute(initializedAnthropicContext({ stream })))
      .toHaveLength(expected);
  });

  it("does not expose the tool without a trusted initialized Session", async () => {
    const injector = new NativeProxyToolsInjector({
      enabled: true,
      registry: createDefaultNativeProxyToolRegistry(),
    });

    expect(injector.execute(initializedAnthropicContext({ custom: {} })))
      .toEqual([]);
  });

  it("does not expose the tool when chat_memory is explicitly disabled", async () => {
    const injector = new NativeProxyToolsInjector({
      enabled: true,
      registry: createDefaultNativeProxyToolRegistry(),
    });
    const custom = structuredClone(metadata.custom!);
    (custom.assetCapabilities as Record<string, unknown>).chat_memory = false;

    expect(injector.execute(initializedAnthropicContext({ custom })))
      .toEqual([]);
  });

  it("fails closed when a Client Tool already uses the proxy-owned name", async () => {
    const injector = new NativeProxyToolsInjector({
      enabled: true,
      registry: createDefaultNativeProxyToolRegistry(),
    });
    const context = initializedAnthropicContext();
    context.tools = [{
      name: "tdai_memory_search",
      description: "client collision",
      parameters: { type: "object" },
    }];

    expect(() => injector.execute(context))
      .toThrow(NativeProxyToolNameCollisionError);
  });

  it("maps only Native critical failures to sanitized Anthropic errors", () => {
    const collision = new NativeProxyToolNameCollisionError("tdai_memory_search");
    expect(describeNativeProxyToolInjectionFailure(collision)).toEqual({
      type: "invalid_request_error",
      message: "Tool name 'tdai_memory_search' is reserved by the proxy",
    });
    expect(describeNativeProxyToolInjectionFailure(new CriticalInjectionHookError(
      "native-proxy-tools-injector",
      collision,
    ))).toEqual({
      type: "invalid_request_error",
      message: "Tool name 'tdai_memory_search' is reserved by the proxy",
    });

    const critical = new CriticalInjectionHookError(
      "native-proxy-tools-injector",
      new Error("secret internal detail"),
    );
    expect(describeNativeProxyToolInjectionFailure(critical)).toEqual({
      type: "invalid_request_error",
      message: "Native Proxy Tool injection failed",
    });
    expect(JSON.stringify(describeNativeProxyToolInjectionFailure(critical)))
      .not.toContain("secret internal detail");
    expect(describeNativeProxyToolInjectionFailure(new Error("ordinary"))).toBeNull();
  });

  it("serializes the registered schema as a native Anthropic tool", async () => {
    const hooks = new HookRegistryImpl();
    hooks.register(new NativeProxyToolsInjector({
      enabled: true,
      registry: createDefaultNativeProxyToolRegistry(),
    }));
    const pipeline = new InjectionPipeline(
      hooks,
      new Map([["anthropic", new AnthropicAdapter()]]),
    );

    const output = await pipeline.process({
      model: "claude-test",
      stream: true,
      system: "system",
      messages: [{ role: "user", content: "remembered rules?" }],
    }, metadata);

    expect(output.tools).toEqual([expect.objectContaining({
      name: "tdai_memory_search",
      input_schema: expect.objectContaining({
        type: "object",
        additionalProperties: false,
        required: ["query"],
      }),
    })]);
  });

  it("runs the Native hook when legacy prompt injection is disabled", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.injection.enabled = false;
    config.injection.injectors = [];
    config.nativeProxyTools.enabled = true;
    config.tdai.enabled = true;
    config.tdai.memory.enabled = true;

    const output = await getInjectionPipeline(config).process({
      model: "claude-test",
      stream: true,
      messages: [{ role: "user", content: "remembered rules?" }],
    }, metadata);

    expect(output.tools).toEqual([expect.objectContaining({
      name: "tdai_memory_search",
    })]);
  });

  it("propagates critical hook failures while retaining non-critical degradation", async () => {
    const critical: InjectionHook = {
      id: "critical-test-hook",
      point: "tools.append",
      priority: 0,
      description: "critical",
      critical: true,
      execute: () => {
        throw new Error("broken invariant");
      },
    };
    const nonCritical = { ...critical, id: "non-critical-test-hook", critical: false };

    const criticalHooks = new HookRegistryImpl();
    criticalHooks.register(critical);
    const criticalPipeline = new InjectionPipeline(
      criticalHooks,
      new Map([["anthropic", new AnthropicAdapter()]]),
    );
    await expect(criticalPipeline.process({
      model: "claude-test",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }, metadata)).rejects.toBeInstanceOf(CriticalInjectionHookError);

    const nonCriticalHooks = new HookRegistryImpl();
    nonCriticalHooks.register(nonCritical);
    const nonCriticalPipeline = new InjectionPipeline(
      nonCriticalHooks,
      new Map([["anthropic", new AnthropicAdapter()]]),
    );
    const output = await nonCriticalPipeline.process({
      model: "claude-test",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }, metadata);
    expect(output).not.toHaveProperty("tools");
  });
});
