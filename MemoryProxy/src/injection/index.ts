/**
 * Context Injection Module — Public API.
 *
 * This module provides:
 * - Type definitions (AgentContext, InjectionHook, InjectionPoint, etc.)
 * - HookRegistry for registering injection hooks
 * - InjectionPipeline for executing the full injection flow
 * - Protocol adapters (OpenAI, Anthropic)
 * - Context utility functions
 */

// Types
export type {
  AgentContext,
  AgentContextMetadata,
  AgentTool,
  AnchorRelation,
  AnchorTarget,
  CacheStrategy,
  ContextBlock,
  ContextBlockType,
  ContextMessage,
  HookPriority,
  HookRegistry,
  InjectionHook,
  InjectionPoint,
  MessageRole,
  PrewarmInput,
  Protocol,
  SemanticSlot,
} from "./types.js";
export { HOOK_PRIORITY, INJECTION_POINTS } from "./types.js";

// Agent adaptation layer
export type { AgentProfile, PromptSegment, ResolvedAnchor, SegmentKind } from "./agents/interface.js";

// Content provider + generic hook factory
export type { ContextContentProvider, InjectionHookSpec } from "./provider.js";
export { createInjectionHook } from "./provider.js";

// Context utilities
export {
  appendTextToMessage,
  createAgentContext,
  getLastUserMessage,
  getMessageText,
  getSystemMessage,
  isFirstTurn,
  prependTextToMessage,
  textBlock,
  textMessage,
} from "./context.js";

// Registry
export { HookRegistryImpl } from "./registry.js";

// Pipeline
export { InjectionPipeline } from "./pipeline.js";
export { CriticalInjectionHookError } from "./pipeline.js";

// Observer (injection pipeline observability)
export type { InjectionObserver, HookResult } from "./observer.js";
export { NoopInjectionObserver, LoggingInjectionObserver } from "./observer.js";

// Prewarm runner
export { prewarmAll } from "./prewarm.js";
export type { PrewarmOptions, PrewarmResult } from "./prewarm.js";

// Adapters
export type { ProtocolAdapter } from "./adapters/interface.js";
export { OpenAIAdapter } from "./adapters/openai.js";
export { AnthropicAdapter } from "./adapters/anthropic.js";

// Injectors
export { SkillInjector } from "./injectors/skill-injector.js";
export { TdaiL1RecallInjector } from "./injectors/tdai-l1-recall-injector.js";
export { TdaiProfileMemoryInjector } from "./injectors/tdai-profile-memory-injector.js";
export { AssetReflectionInjector, renderAssetReflectionBlock } from "./injectors/asset-reflection-injector.js";

// CodeBuddy
export { isCodeBuddyPrompt, parseCodeBuddySystemPrompt } from "./agents/codebuddy/parser.js";
export { rebuildSystemPrompt, insertBeforeTag, insertAfterTag, appendInsideTag, prependInsideTag } from "./agents/codebuddy/serializer.js";
export { detectUnknownTags, classifyTags } from "./agents/codebuddy/constants.js";
export { CodeBuddyProfile } from "./agents/codebuddy/profile.js";

// Claude Code
export { ClaudeCodeProfile } from "./agents/claude-code/index.js";

// WorkBuddy — independent client (structurally XML-tag, wire protocol OpenAI/Responses).
// Deliberately kept as a distinct namespace with duplicated logic; no cross-imports
// from codebuddy/codex/claude-code.
export {
  WorkbuddyProfile,
  parseWorkbuddySystemPrompt,
  isWorkbuddyPrompt,
  WORKBUDDY_KNOWN_TAGS,
} from "./agents/workbuddy/index.js";

// ── Pipeline Factory ──────────────────────────────────────────────────────────

import type { ProxyConfig } from "../types.js";
import { InjectionPipeline } from "./pipeline.js";
import { HookRegistryImpl } from "./registry.js";
import { OpenAIAdapter } from "./adapters/openai.js";
import { AnthropicAdapter } from "./adapters/anthropic.js";
import { SkillInjector } from "./injectors/skill-injector.js";
import { TdaiProfileMemoryInjector } from "./injectors/tdai-profile-memory-injector.js";
import { AssetReflectionInjector } from "./injectors/asset-reflection-injector.js";
import { NativeProxyToolsInjector } from "../native-proxy-tools/native-proxy-tools-injector.js";
import { getNativeProxyToolRuntime } from "../native-proxy-tools/runtime.js";
import type { ProtocolAdapter } from "./adapters/interface.js";
import type { AgentProfile } from "./agents/interface.js";
import { CodeBuddyProfile } from "./agents/codebuddy/profile.js";
import { ClaudeCodeProfile } from "./agents/claude-code/index.js";
import { WorkbuddyProfile } from "./agents/workbuddy/profile.js";
import { getHookCacheRepo, setHookCacheRepo, type HookCacheRepo } from "../db/hookCacheRepo.js";
import { getSessionRepo, setSessionRepo, type SessionRepo } from "../db/sessionRepo.js";
import { getRedisClient } from "../db/redis-client.js";
import { RedisSessionRepo } from "../db/redis-session-repo.js";
import { RedisHookCacheRepo } from "../db/redis-hook-cache-repo.js";
import { RedisBindingRepo } from "../db/binding-repo.js";
import { KvSessionRepo } from "../db/kv-session-repo.js";
import { KvHookCacheRepo } from "../db/kv-hook-cache-repo.js";
import { KvBindingRepo } from "../db/kv-binding-repo.js";
import { getProxyStorage, getEffectiveBackend } from "../storage/factory.js";
import { getSessionStore } from "../session/store.js";
import type { HookRegistry, PrewarmInput } from "./types.js";
import { prewarmAll, type PrewarmOptions, type PrewarmResult } from "./prewarm.js";
import { LoggingInjectionObserver, NoopInjectionObserver, LangfuseInjectionObserver } from "./observer.js";

// ... (rest)

interface PipelineBundle {
  pipeline: InjectionPipeline;
  registry: HookRegistry;
  hookCacheRepo?: HookCacheRepo;
}

let cachedBundle: PipelineBundle | null = null;
let cachedConfigHash = "";

/**
 * Try to activate ProxyStorage (Kv*Repo) if `storage.enabled`.
 *
 * When active, replaces the RedisSessionRepo / RedisHookCacheRepo /
 * RedisBindingRepo entirely with their Kv* equivalents.
 *
 * Returns true iff ProxyStorage repos were installed (Redis path bypassed).
 */
export function tryActivateStorage(config: ProxyConfig): boolean {
  if (!config.storage?.enabled) return false;
  try {
    const storage = getProxyStorage(config.storage);
    setSessionRepo(new KvSessionRepo(storage));
    setHookCacheRepo(new KvHookCacheRepo(storage));
    const store = getSessionStore();
    store.setBindingRepo(new KvBindingRepo(storage));
    const eff = getEffectiveBackend();
    console.log(
      `[injection] activated ProxyStorage (requested=${eff.requested}, effective=${eff.effective})`,
    );
    return true;
  } catch (err) {
    console.warn(
      "[injection] ProxyStorage init failed, falling back to Redis/SQLite:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/** Try to activate Redis repos. Called once at pipeline build time, also exported for early activation. */
export function tryActivateRedis(config: ProxyConfig): boolean {
  if (!config.redis?.enabled) return false;
  try {
    const redis = getRedisClient(config.redis);
    if (!redis) return false;

    const ttl = config.redis.injectionTtlSeconds;
    setSessionRepo(new RedisSessionRepo(redis, ttl));
    setHookCacheRepo(new RedisHookCacheRepo(redis, ttl));
    const store = getSessionStore();
    store.setBindingRepo(new RedisBindingRepo(redis));
    console.log("[injection] activated Redis storage");
    return true;
  } catch (err) {
    console.warn("[injection] Redis unavailable, falling back to SQLite:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** Resolve `HookCacheRepo`. `getHookCacheRepo()` self-degrades to a NullRepo
 *  when better-sqlite3 is absent, so callers always receive a usable instance. */
function tryLoadHookCacheRepo(): HookCacheRepo | undefined {
  try {
    return getHookCacheRepo();
  } catch (err) {
    console.warn(
      "[injection] hook-cache repo unavailable, hooks will run without caching:",
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
}

function buildPipelineBundle(config: ProxyConfig): PipelineBundle {
  const registry = new HookRegistryImpl();
  const adapters = new Map<string, ProtocolAdapter>();
  adapters.set("openai", new OpenAIAdapter());
  adapters.set("anthropic", new AnthropicAdapter());

  // Register configured injectors. Each injector reads its own kernel config
  // (`coreSkill`, `tdai`, ...); there is no shared external endpoint anymore.
  const injectors = config.injection?.injectors ?? [];

  if (config.nativeProxyTools.enabled) {
    registry.register(new NativeProxyToolsInjector({
      enabled: true,
      registry: getNativeProxyToolRuntime(config).registry,
      memoryEnabled: config.tdai.enabled && config.tdai.memory.enabled,
      skillEnabled: injectors.includes("skill"),
      allowSkillWrite: config.skillRuntime?.allowLlmWrite ?? false,
    }));
  }

  if (injectors.includes("skill")) {
    // RAG-driven `<cloud_skills>` block. Calls /v3/skill/search at prewarm time.
    // When coreSkill is unconfigured (no serviceToken), the searchSkills call
    // will fail and the injector silently degrades to no <cloud_skills> block.
    registry.register(
      new SkillInjector({ coreSkill: config.coreSkill }),
    );
  }

  // The Phase 2/3 Native project deliberately has no model-facing Knowledge
  // tool family. Keep the config for other host integrations, but do not emit
  // a half-functional prompt block or curl recipe here.

  if (injectors.includes("tdai-memory") && config.tdai.enabled && config.tdai.memory.enabled && config.tdai.memory.inject) {
    // Base TdaiClient config. `TdaiProfileMemoryInjector` rebuilds a per-request
    // TdaiClient with `serviceId := session.space_id || baseConfig.serviceId`
    // so writes/recalls hit the correct kernel tenant (was hard-coded to
    // `config.tdai.serviceId` before; broke multi-tenant tests).
    const tdaiBaseConfig = {
      enabled: config.tdai.enabled && config.tdai.memory.enabled,
      endpoint: config.tdai.endpoint,
      apiKey: config.tdai.apiKey,
      serviceId: config.tdai.serviceId,
      writeL0: config.tdai.memory.writeL0,
      recallL1: config.tdai.memory.recallL1,
      injectL2L3: config.tdai.memory.injectL2L3,
      l1Limit: config.tdai.memory.l1Limit,
      l2Limit: config.tdai.memory.l2Limit,
      timeoutMs: config.tdai.memory.timeoutMs,
    };
    // fixed-asset-agents（self + 借入≤2）通过内核 MetadataClient 获取；
    // 内核不可达时 injector 自动降级为"只查当前 agent 的记忆"。
    if (config.tdai.memory.injectL2L3) {
      registry.register(new TdaiProfileMemoryInjector(tdaiBaseConfig, config.coreSkill));
    }
    // L0/L1 are not auto-recalled into the prompt. The only model-facing
    // retrieval capability is the structured `tdai_memory_search` Native Tool
    // registered above; no text/curl fallback is emitted.
  }

  // ── Asset Reflection (内部效果评估) ─────────────────────────────────────
  // 默认关闭（markerOptIn=false）—— 生产 pod 完全跳过 register，零性能开销。
  // 开启后即使 register，只有请求 URL 带 `/analyse` marker 才真 emit 块。
  // Tag 列表由本节点上"实际 register 了的资产 injector"派生，避免让 LLM 反思
  // 一个本节点根本没接入的资产。
  if (config.injection?.assetReflection?.markerOptIn) {
    const registeredIds = new Set(registry.getAll().map((h) => h.id));
    const activeAssetTags: string[] = [];
    if (registeredIds.has("skill-injector")) {
      activeAssetTags.push("available_skills");
    }
    if (registeredIds.has("tdai-profile-memory-injector")) {
      activeAssetTags.push("tdai_profile_memory");
    }
    if (registeredIds.has("native-proxy-tools-injector")) {
      activeAssetTags.push("tdai_memory_search");
    }
    if (activeAssetTags.length > 0) {
      registry.register(new AssetReflectionInjector({ activeAssetTags }));
      console.log(`[injection] asset-reflection registered, tags=[${activeAssetTags.join(",")}]`);
    } else {
      console.log(`[injection] asset-reflection markerOptIn=true 但本节点无资产 injector，跳过 register`);
    }
  }

  // Activate storage backend if configured (before loading repos).
  // ProxyStorage (COS/SQLite/FS/Memory) takes precedence when storage.enabled;
  // otherwise fall back to the original Redis path.
  if (!tryActivateStorage(config)) {
    tryActivateRedis(config);
  }

  const hookCacheRepo = tryLoadHookCacheRepo();

  // Observer: prefer Langfuse (injection spans under LLM trace) when enabled;
  // fall back to structured logging when log level ≤ info; else noop.
  const observer = config.langfuse?.enabled
    ? new LangfuseInjectionObserver()
    : (config.log?.level === "debug" || config.log?.level === "info")
      ? new LoggingInjectionObserver()
      : new NoopInjectionObserver();

  const pipeline = new InjectionPipeline(registry, adapters, {
    hookCacheRepo,
    // Agent profile registry — lookup by URL path prefix (agentSource).
    // Adding a new agent only adds a line here. The legacy detectAgent
    // (content-scanning) is kept as fallback for un-prefixed paths.
    agentProfiles: new Map<string, AgentProfile>([
      ["codebuddy", new CodeBuddyProfile()],
      ["claude-code", new ClaudeCodeProfile()],
      ["workbuddy", new WorkbuddyProfile()],
      // ["cursor", new CursorProfile()],
    ]),
    // Legacy fallback: scan system prompt content (for backward compat).
    detectAgent: (() => {
      const agentProfiles: AgentProfile[] = [
        new CodeBuddyProfile(),
        new ClaudeCodeProfile(),
        new WorkbuddyProfile(),
      ];
      return (systemText: string) =>
        agentProfiles.find((p) => p.detect(systemText)) ?? null;
    })(),
  }, observer);

  return { pipeline, registry, hookCacheRepo };
}

function getOrBuildBundle(config: ProxyConfig): PipelineBundle {
  const configHash = JSON.stringify({
    injection: config.injection,
    tdai: config.tdai,
    coreSkill: config.coreSkill,
    knowledge: config.knowledge,
    nativeProxyTools: config.nativeProxyTools,
    server: config.server,
  });
  if (cachedBundle && cachedConfigHash === configHash) {
    return cachedBundle;
  }
  cachedBundle = buildPipelineBundle(config);
  cachedConfigHash = configHash;
  return cachedBundle;
}

/**
 * Get or create an InjectionPipeline configured from ProxyConfig.
 * The pipeline is cached and reused for the lifetime of the config.
 */
export function getInjectionPipeline(config: ProxyConfig): InjectionPipeline {
  return getOrBuildBundle(config).pipeline;
}

/**
 * Drive `prewarmAll` against the same HookRegistry / HookCacheRepo used by
 * the live pipeline. Intended for the session_init hot path: call this once
 * per session immediately after the control plane returns `sessionInfo`.
 *
 * Errors are NEVER thrown — caller can safely `await` without try/catch.
 */
export async function prewarmFromConfig(
  config: ProxyConfig,
  input: PrewarmInput,
  opts?: PrewarmOptions,
): Promise<PrewarmResult> {
  const bundle = getOrBuildBundle(config);
  // No persistence layer or no hooks declaring strategy → noop with empty result.
  if (!bundle.hookCacheRepo) {
    return { cachedHookIds: [], skipped: [], durationMs: 0 };
  }
  try {
    return await prewarmAll(bundle.registry, bundle.hookCacheRepo, input, opts);
  } catch (err) {
    console.warn(
      "[hook-cache] prewarmFromConfig swallowed error:",
      err instanceof Error ? err.message : String(err),
    );
    return { cachedHookIds: [], skipped: [], durationMs: 0 };
  }
}

/** Test-only: drop the cached pipeline so the next call rebuilds from config. */
export function __resetInjectionPipelineForTests(): void {
  cachedBundle = null;
  cachedConfigHash = "";
}
