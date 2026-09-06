import { afterEach, describe, expect, it, vi } from "vitest";

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
import { setCoreKnowledgeClient } from "../../knowledge/core-client.js";

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
  vi.unstubAllGlobals();
  setCoreKnowledgeClient(null);
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
  it("registers all six Memory, ten Skill, and two Knowledge tools in stable order", () => {
    const registry = createDefaultNativeProxyToolRegistry();

    expect(registry.list().map((tool) => tool.name)).toEqual([
      "tdai_memory_search",
      "tdai_atomic_query",
      "tdai_conversation_search",
      "tdai_conversation_query",
      "tdai_scenario_ls",
      "tdai_read_scene",
      "skill_search",
      "skill_view",
      "skill_files_read",
      "skill_extract",
      "skill_create",
      "skill_update",
      "skill_patch",
      "skill_delete",
      "skill_files_write",
      "skill_files_remove",
      "tdai_knowledge_tools_list",
      "tdai_knowledge_tool_call",
    ]);
    expect(registry.require("tdai_memory_search")).toMatchObject({
      owner: "proxy",
      backend: "memory",
      effect: "read",
      route: "atomic/search",
    });
    expect(registry.require("skill_extract")).toMatchObject({
      backend: "skill",
      effect: "archive",
      route: "extract",
    });
    expect(registry.require("skill_delete")).toMatchObject({
      backend: "skill",
      effect: "write",
      route: "delete",
    });
    expect(registry.require("tdai_knowledge_tool_call")).toMatchObject({
      backend: "knowledge",
      effect: "read",
      route: "tools/call",
    });
    expect(registry.owns("client_tool")).toBe(false);
    expect(registry.owns("skill_search")).toBe(true);
    expect(registry.owns("tdai_skill_search")).toBe(false);
  });

  it("resolves Memory, Skill, and Knowledge exposure independently", () => {
    const registry = createDefaultNativeProxyToolRegistry();
    const names = (value: Parameters<typeof registry.visibleFor>[0]) =>
      registry.visibleFor(value).map((tool) => tool.name);

    expect(names({
      memoryEnabled: false,
      chatMemory: false,
      skillEnabled: false,
      skillCapability: false,
      allowSkillWrite: false,
      knowledgeEnabled: false,
      knowledgeCapability: false,
      knowledgeCatalogAvailable: false,
    })).toEqual([]);
    expect(names({
      memoryEnabled: true,
      chatMemory: true,
      skillEnabled: false,
      skillCapability: false,
      allowSkillWrite: false,
      knowledgeEnabled: false,
      knowledgeCapability: false,
      knowledgeCatalogAvailable: false,
    })).toEqual(registry.list().slice(0, 6).map((tool) => tool.name));
    expect(names({
      memoryEnabled: false,
      chatMemory: false,
      skillEnabled: true,
      skillCapability: true,
      allowSkillWrite: false,
      knowledgeEnabled: false,
      knowledgeCapability: false,
      knowledgeCatalogAvailable: false,
    })).toEqual(["skill_search", "skill_view", "skill_files_read", "skill_extract"]);
    expect(names({
      memoryEnabled: false,
      chatMemory: false,
      skillEnabled: true,
      skillCapability: true,
      allowSkillWrite: true,
      knowledgeEnabled: false,
      knowledgeCapability: false,
      knowledgeCatalogAvailable: false,
    })).toEqual(registry.list().slice(6, 16).map((tool) => tool.name));
    expect(names({
      memoryEnabled: false,
      chatMemory: false,
      skillEnabled: false,
      skillCapability: false,
      allowSkillWrite: false,
      knowledgeEnabled: true,
      knowledgeCapability: true,
      knowledgeCatalogAvailable: true,
    })).toEqual(["tdai_knowledge_tools_list", "tdai_knowledge_tool_call"]);
  });

  it("publishes strict object schemas for every registered tool", () => {
    for (const tool of createDefaultNativeProxyToolRegistry().list()) {
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        properties: expect.any(Object),
      });
    }
  });

  it("preserves Baseline tool purposes without adding selection priorities or transport instructions", () => {
    const registry = createDefaultNativeProxyToolRegistry();
    const expectedGuidance: Record<string, readonly string[]> = {
      tdai_memory_search: ["L1 原子记忆", "按相关度排序", "self + imported", "source_agent_", "偏好"],
      tdai_atomic_query: ["type / 时间窗 / 分页", "不做语义检索"],
      tdai_conversation_search: ["L0", "具体消息原文 / 引用 / 时间线", "self + imported", "source_agent_"],
      tdai_conversation_query: ["按 session 顺序取 L0 历史消息"],
      tdai_scenario_ls: ["含 summary，不含正文", "system 已注入索引", "刷新/按前缀过滤"],
      tdai_read_scene: ["tdai_scenario_ls", "全文", "imported_from", "agent_id"],
      skill_search: ["关键词 + 语义", "有权限访问", "2-5", "换一组关键词", "自带的 skill 不够"],
      skill_view: ["skill_name", "<available_skills>", "skill_search", "manifest", "skill_files_read"],
      skill_files_read: ["skill_view", "skill_id", "path", "返回文件内容及编码"],
      skill_extract: ["异步", "适合", "完整", "复用", "不用传 messages"],
      skill_create: ["新建 skill", "当前 agent"],
      skill_update: ["替换 SKILL.md", "version+1"],
      skill_patch: ["子串替换", "避免大 diff"],
      skill_delete: ["永久删除", "所有版本", "资源"],
      skill_files_write: ["增/改资源文件", "version+1"],
      skill_files_remove: ["删资源文件", "实际删除文件", "version+1"],
      tdai_knowledge_tools_list: ["Knowledge", "knowledge_id", "工具清单"],
      tdai_knowledge_tool_call: ["tools_list", "tool_name", "params"],
    };

    for (const [name, phrases] of Object.entries(expectedGuidance)) {
      const description = registry.require(name).description;
      for (const phrase of phrases) expect(description).toContain(phrase);
      expect(description).not.toMatch(/bash|curl|https?|authorization|鉴权|请求头/i);
    }
    expect(registry.require("skill_files_read").description).not.toContain("结果大小限制");
    expect(registry.require("skill_extract").description).not.toContain("仅在");
    expect(registry.require("skill_delete").description).not.toContain("软删除");
    expect(registry.require("tdai_conversation_search").description).not.toContain("优先使用");
    expect(registry.require("skill_update").description).not.toContain("优先使用");
  });

  it.each([
    ["tdai_atomic_query", { type: "episodic", limit: 20, offset: 0 }],
    ["tdai_conversation_search", { query: "exact quote", limit: 5 }],
    ["tdai_conversation_query", { session_id: "session-old", limit: 50, offset: 0 }],
    ["tdai_scenario_ls", { path_prefix: "project/" }],
    ["tdai_read_scene", { path: "project/rules" }],
    ["skill_search", { query: "deployment" }],
    ["skill_view", { skill_name: "browser-use" }],
    ["skill_files_read", { skill_id: "skl-1", path: "SKILL.md", encoding: "utf-8" }],
    ["skill_extract", { reason: "reusable workflow" }],
    ["skill_create", { name: "deploy", content: "---\nname: deploy\n---" }],
    ["skill_update", { skill_id: "skl-1", content: "updated" }],
    ["skill_patch", { skill_id: "skl-1", old_string: "a", new_string: "b", replace_all: false }],
    ["skill_delete", { skill_id: "skl-1" }],
    ["skill_files_write", { skill_id: "skl-1", files: [{ path: "a.txt", content: "a", encoding: "utf-8" }] }],
    ["skill_files_remove", { skill_id: "skl-1", paths: ["a.txt"] }],
    ["tdai_knowledge_tools_list", { knowledge_id: "wiki-1" }],
    ["tdai_knowledge_tool_call", { knowledge_id: "wiki-1", tool_name: "search", params: { query: "routing" } }],
  ])("validates and normalizes %s arguments", (name, input) => {
    expect(createDefaultNativeProxyToolRegistry().require(name).validate(input))
      .toMatchObject({ ok: true });
  });

  it.each([
    ["tdai_atomic_query", { type: "unknown" }],
    ["tdai_conversation_search", { query: "" }],
    ["tdai_conversation_query", { session_id: "s", limit: 0 }],
    ["tdai_scenario_ls", { path_prefix: 1 }],
    ["tdai_read_scene", { path: "" }],
    ["skill_search", { query: "x", user_id: "attacker" }],
    ["skill_view", { skill_id: "skl-1" }],
    ["skill_files_read", { skill_id: "skl-1", path: "a", encoding: "binary" }],
    ["skill_extract", { reason: "x".repeat(2_001) }],
    ["skill_create", { name: "", content: "x" }],
    ["skill_update", { skill_id: "skl-1", content: "x".repeat(262_145) }],
    ["skill_patch", { skill_id: "skl-1", old_string: "", new_string: "b" }],
    ["skill_delete", { skill_id: "" }],
    ["skill_files_write", { skill_id: "skl-1", files: [] }],
    ["skill_files_remove", { skill_id: "skl-1", paths: [] }],
    ["tdai_knowledge_tools_list", { knowledge_id: "" }],
    ["tdai_knowledge_tool_call", { knowledge_id: "wiki-1", tool_name: "", params: {} }],
    ["tdai_knowledge_tool_call", { knowledge_id: "wiki-1", tool_name: "search", params: [] }],
  ])("rejects invalid %s arguments", (name, input) => {
    expect(createDefaultNativeProxyToolRegistry().require(name).validate(input))
      .toMatchObject({ ok: false });
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

  it("publishes and preserves the authorized source Agent when reading an imported L2 scene", () => {
    const tool = createDefaultNativeProxyToolRegistry().require("tdai_read_scene");

    expect(tool.inputSchema).toMatchObject({
      properties: { agent_id: { type: "string" } },
    });
    expect(tool.validate({ path: "project/rules", agent_id: "agent-imported" })).toEqual({
      ok: true,
      value: { path: "project/rules", agent_id: "agent-imported" },
    });
  });

  it("publishes and enforces the Skill name format used by Skill Core", () => {
    const tool = createDefaultNativeProxyToolRegistry().require("skill_create");

    expect(tool.inputSchema).toMatchObject({
      properties: {
        name: { pattern: "^[a-z0-9][a-z0-9-]*$" },
      },
    });
    expect(tool.validate({ name: "deploy-guide", content: "---\nname: deploy-guide\n---" }))
      .toMatchObject({ ok: true });
    expect(tool.validate({ name: "Deploy Guide", content: "---\nname: Deploy Guide\n---" }))
      .toMatchObject({ ok: false });
  });

  it("rejects write-resource paths that Skill Core cannot accept", () => {
    const registry = createDefaultNativeProxyToolRegistry();
    const longPath = `files/${"a".repeat(507)}`;

    expect(registry.require("skill_files_write").inputSchema).toMatchObject({
      properties: {
        files: { items: { properties: { path: { maxLength: 512 } } } },
      },
    });
    expect(registry.require("skill_files_write").validate({
      skill_id: "skl-1",
      files: [{ path: longPath, content: "x" }],
    })).toMatchObject({ ok: false });
    expect(registry.require("skill_files_remove").validate({
      skill_id: "skl-1",
      paths: [longPath],
    })).toMatchObject({ ok: false });
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
  it("serializes Skill parameter guidance in the schema without changing write exposure", async () => {
    const hooks = new HookRegistryImpl();
    hooks.register(new NativeProxyToolsInjector({
      enabled: true, memoryEnabled: false, skillEnabled: true, allowSkillWrite: true,
      registry: createDefaultNativeProxyToolRegistry(),
    }));
    const pipeline = new InjectionPipeline(hooks, new Map([["anthropic", new AnthropicAdapter()]]));
    const output = await pipeline.process({
      model: "claude-test", stream: true,
      messages: [{ role: "user", content: "update a reusable workflow" }],
    }, metadata);
    const tools = output.tools as Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
    const extract = tools.find((tool) => tool.name === "skill_extract")!;
    expect(extract.description).not.toContain("reason");
    expect(extract.input_schema).toMatchObject({
      properties: { reason: { description: expect.stringContaining("识别边界") } },
    });
    expect(extract.input_schema).not.toHaveProperty("required");
    const create = tools.find((tool) => tool.name === "skill_create")!;
    expect(create.description).not.toContain("frontmatter");
    expect(create.input_schema).toMatchObject({
      properties: {
        content: { description: expect.stringContaining("frontmatter.name") },
        resources: { description: expect.stringContaining("资源文件") },
      },
      required: ["name", "content"],
    });
    expect(tools.find((tool) => tool.name === "skill_update")!.input_schema).toMatchObject({
      properties: { content: { description: expect.stringContaining("不能更改 frontmatter.name") } },
    });
    expect(tools.find((tool) => tool.name === "skill_patch")!.input_schema).toMatchObject({
      properties: {
        old_string: { description: expect.any(String) },
        new_string: { description: expect.stringContaining("空字符串") },
        replace_all: { default: false, description: expect.stringContaining("唯一匹配") },
      },
    });
    expect(tools).toHaveLength(10);
  });

  it.each([
    { memoryEnabled: true, skillEnabled: true },
    { memoryEnabled: true, skillEnabled: false },
    { memoryEnabled: false, skillEnabled: true },
    { memoryEnabled: false, skillEnabled: false },
  ])("retains the Memory guide without assets only when Memory tools are exposed: $memoryEnabled/$skillEnabled", async ({ memoryEnabled, skillEnabled }) => {
    const hooks = new HookRegistryImpl();
    hooks.register(new NativeProxyToolsInjector({
      enabled: true,
      registry: createDefaultNativeProxyToolRegistry(),
      memoryEnabled,
      skillEnabled,
    }));
    const pipeline = new InjectionPipeline(hooks, new Map([["anthropic", new AnthropicAdapter()]]));
    const output = await pipeline.process({
      model: "claude-test", stream: true,
      messages: [{ role: "user", content: "a task without preloaded assets" }],
    }, metadata);
    const system = typeof output.system === "string" ? output.system : JSON.stringify(output.system ?? "");
    expect(system).not.toContain("<native_tool_usage>");
    expect(system.match(/<memory-tools-guide>/g) ?? []).toHaveLength(memoryEnabled ? 1 : 0);
    if (memoryEnabled) {
      expect(system).toContain("用户提及历史/过去/之前");
      expect(system).toContain("用户涉及自己身份/偏好/习惯");
      expect(system).toContain("用户要求你回忆/找");
      expect(system).toContain("答案强依赖历史事实");
      expect(system).toContain("当前会话上下文（同轮消息）里已能回答");
      expect(system).toContain("合计 ≤ 3 次");
      expect(system).toContain("同等优先级");
      expect(system).not.toMatch(/curl|Bash|二者都应/);
    }
    expect(output.tools ?? []).toHaveLength((memoryEnabled ? 6 : 0) + (skillEnabled ? 4 : 0));
  });

  it.each([
    { stream: false, enabled: true, expected: 0 },
    { stream: true, enabled: false, expected: 0 },
    { stream: true, enabled: true, expected: 6 },
  ])("applies streaming and feature visibility", async ({ stream, enabled, expected }) => {
    const injector = new NativeProxyToolsInjector({
      enabled,
      registry: createDefaultNativeProxyToolRegistry(),
    });

    expect(injector.execute(initializedAnthropicContext({ stream })))
      .toHaveLength(expected);
  });

  it("injects the same function schemas for streaming OpenAI Chat Completions", () => {
    const injector = new NativeProxyToolsInjector({
      enabled: true,
      registry: createDefaultNativeProxyToolRegistry(),
    });

    expect(injector.execute(initializedAnthropicContext({ protocol: "openai" })))
      .toHaveLength(6);
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

  it("exposes the four safe Skill tools or all ten when writes are enabled", () => {
    const readonlyInjector = new NativeProxyToolsInjector({
      enabled: true,
      memoryEnabled: false,
      skillEnabled: true,
      allowSkillWrite: false,
      registry: createDefaultNativeProxyToolRegistry(),
    });
    const writableInjector = new NativeProxyToolsInjector({
      enabled: true,
      memoryEnabled: false,
      skillEnabled: true,
      allowSkillWrite: true,
      registry: createDefaultNativeProxyToolRegistry(),
    });

    expect(readonlyInjector.execute(initializedAnthropicContext()).map((block) => block.metadata?.tool_name))
      .toEqual(["skill_search", "skill_view", "skill_files_read", "skill_extract"]);
    expect(writableInjector.execute(initializedAnthropicContext())).toHaveLength(10);
  });

  it("exposes Knowledge tools only when an authorized catalog was injected", () => {
    const injector = new NativeProxyToolsInjector({
      enabled: true,
      memoryEnabled: false,
      skillEnabled: false,
      knowledgeEnabled: true,
      registry: createDefaultNativeProxyToolRegistry(),
    });
    const withoutCatalog = initializedAnthropicContext();
    const withCatalog = initializedAnthropicContext();
    withCatalog.messages[0].blocks[0].content += "\n<knowledge_catalog>one</knowledge_catalog>";

    expect(injector.execute(withoutCatalog)).toEqual([]);
    expect(injector.execute(withCatalog).map((block) => block.metadata?.tool_name))
      .toEqual(["tdai_knowledge_tools_list", "tdai_knowledge_tool_call"]);
  });

  it("reserves a hidden Skill write name when writes are disabled", () => {
    const injector = new NativeProxyToolsInjector({
      enabled: true,
      memoryEnabled: false,
      skillEnabled: true,
      allowSkillWrite: false,
      registry: createDefaultNativeProxyToolRegistry(),
    });
    const context = initializedAnthropicContext();
    context.tools = [{
      name: "skill_delete",
      description: "client collision",
      parameters: { type: "object" },
    }];

    expect(() => injector.execute(context)).toThrow(NativeProxyToolNameCollisionError);
  });

  it("does not expose the tool on a request explicitly marked ineligible", () => {
    const injector = new NativeProxyToolsInjector({
      enabled: true,
      registry: createDefaultNativeProxyToolRegistry(),
    });
    const custom = {
      ...structuredClone(metadata.custom!),
      nativeProxyEligible: false,
    };

    expect(injector.execute(initializedAnthropicContext({ custom }))).toEqual([]);
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

  it("reserves the proxy-owned name even when the trusted Session is unavailable", () => {
    const injector = new NativeProxyToolsInjector({
      enabled: true,
      registry: createDefaultNativeProxyToolRegistry(),
    });
    const context = initializedAnthropicContext({ custom: {} });
    context.tools = [{
      name: "tdai_memory_search",
      description: "untrusted client collision",
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

    expect(output.tools).toHaveLength(6);
    expect(output.tools).toEqual(expect.arrayContaining([expect.objectContaining({
      name: "tdai_memory_search",
      input_schema: expect.objectContaining({
        type: "object",
        additionalProperties: false,
        required: ["query"],
      }),
    })]));
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

    expect(output.tools).toHaveLength(6);
    expect(output.tools).toEqual(expect.arrayContaining([expect.objectContaining({
      name: "tdai_memory_search",
    })]));
  });

  it("exposes Native Skill tools without enabling legacy Skill prompt injection", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.injection.enabled = false;
    config.injection.injectors = [];
    config.nativeProxyTools.enabled = true;
    config.coreSkill.serviceToken = "trusted-service-token";

    const output = await getInjectionPipeline(config).process({
      model: "claude-test",
      stream: true,
      messages: [{ role: "user", content: "find a skill" }],
    }, metadata);

    expect(output.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "skill_search" }),
      expect.objectContaining({ name: "skill_extract" }),
    ]));
  });

  it("injects a concise Knowledge catalog and two native schemas without legacy injection", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.injection.enabled = false;
    config.injection.injectors = [];
    config.nativeProxyTools.enabled = true;
    config.knowledge.enabled = true;
    config.knowledge.serviceToken = "server-secret";
    setCoreKnowledgeClient({
      listAgentKnowledgeIds: vi.fn(async () => ["wiki-1"]),
      listKnowledgeByIds: vi.fn(async () => [{
        knowledge_id: "wiki-1",
        type: "wiki",
        service_url: "https://private.example/v3",
        name: "Architecture",
        summary: "Design decisions",
        team_id: "team-1",
        user_id: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      }]),
    } as never);
    const custom = structuredClone(metadata.custom!);
    custom.userKey = "user-key-1";

    const output = await getInjectionPipeline(config).process({
      model: "claude-test",
      stream: true,
      system: "system",
      messages: [{ role: "user", content: "explain the design" }],
    }, { ...metadata, custom });
    const serialized = JSON.stringify(output);

    expect(output.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "tdai_knowledge_tools_list" }),
      expect.objectContaining({ name: "tdai_knowledge_tool_call" }),
    ]));
    expect(serialized).toContain("<knowledge_catalog>");
    expect(serialized).toContain('id=\\"wiki-1\\"');
    expect(serialized).not.toMatch(/private\.example|curl|authorization|x-tdai/i);
  });

  it("never emits Fake Tool tags or curl recipes beside the Native tool", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.injection.enabled = true;
    config.injection.injectors = ["skill", "knowledge", "tdai-memory"];
    config.nativeProxyTools.enabled = true;
    config.tdai.enabled = true;
    config.tdai.endpoint = "https://memory.example";
    config.tdai.memory.enabled = true;
    config.tdai.memory.inject = true;
    config.tdai.memory.injectL2L3 = true;
    config.knowledge.enabled = true;
    config.coreSkill.serviceToken = "service-token";
    config.knowledge.serviceToken = "knowledge-token";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: { items: [], skills: [] },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    const output = await getInjectionPipeline(config).process({
      model: "claude-test",
      stream: true,
      system: "system",
      messages: [{ role: "user", content: "remembered rules?" }],
    }, metadata);
    const serializedSystem = JSON.stringify(output.system ?? "");

    expect(output.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "tdai_memory_search" }),
    ]));
    const forbiddenTags = new RegExp([
      "<tdai_" + "memory_tools>",
      "<skill_" + "tools>",
      "<knowledge_" + "tools>",
    ].join("|"));
    expect(serializedSystem).not.toMatch(forbiddenTags);
    expect(serializedSystem).not.toMatch(
      /Bash\s*\+\s*curl|skill-bridge.*curl|memory-bridge.*curl/i,
    );
  });

  it("provides no Native or Fake Tool fallback when Native Proxy Tools are disabled", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.injection.enabled = false;
    config.injection.injectors = [];
    config.nativeProxyTools.enabled = false;

    const output = await getInjectionPipeline(config).process({
      model: "claude-test",
      stream: true,
      system: "system",
      messages: [{ role: "user", content: "remembered rules?" }],
    }, metadata);
    const serialized = JSON.stringify(output);

    expect(output).not.toHaveProperty("tools");
    const forbiddenFallbacks = new RegExp([
      "tdai_memory_search",
      "<tdai_" + "memory_tools>",
      "<memory-" + "tools-guide>",
      "<skill_" + "tools>",
      "<knowledge_" + "tools>",
    ].join("|"));
    expect(serialized).not.toMatch(forbiddenFallbacks);
    expect(serialized).not.toMatch(/Bash\s*\+\s*curl|skill-bridge.*curl|memory-bridge.*curl/i);
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
