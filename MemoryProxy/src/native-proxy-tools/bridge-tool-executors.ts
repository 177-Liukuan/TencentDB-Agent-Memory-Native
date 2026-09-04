import { executeMemoryBridge, type MemoryBridgeDeps } from "../memory/memory-bridge.js";
import { executeSkillBridge, type SkillBridgeDeps } from "../skill/skill-bridge.js";
import {
  executeKnowledgeTool,
  type KnowledgeToolExecutorDeps,
} from "../knowledge/knowledge-tool-executor.js";
import type { ProxyConfig } from "../types.js";
import type { NativeProxyToolDefinition } from "./tool-registry.js";
import type { JsonValue, NativeToolBackend, ToolExecutionScope } from "./types.js";

export interface BridgeToolExecutionResult {
  status: number;
  text: string;
  contentType: string;
}

export interface BridgeToolExecutionInput {
  callId: string;
  definition: NativeProxyToolDefinition;
  body: Record<string, JsonValue>;
  scope: ToolExecutionScope;
  signal: AbortSignal;
}

export type BridgeToolExecutor = (
  input: BridgeToolExecutionInput,
) => Promise<BridgeToolExecutionResult>;

export type BridgeToolExecutors = Record<NativeToolBackend, BridgeToolExecutor>;

export interface BridgeToolExecutorDependencies {
  memory?: MemoryBridgeDeps;
  skill?: SkillBridgeDeps;
  knowledge?: KnowledgeToolExecutorDeps;
}

export function createBridgeToolExecutors(
  config: ProxyConfig,
  dependencies: BridgeToolExecutorDependencies = {},
): BridgeToolExecutors {
  return {
    memory: async ({ definition, body, scope, signal }) => executeMemoryBridge({
      config,
      subpath: definition.route,
      body,
      sessionId: scope.sessionId,
      spaceId: scope.spaceId,
      signal,
    }, dependencies.memory ?? {}),
    skill: async ({ definition, body, scope, signal }) => executeSkillBridge({
      config,
      subpath: definition.route,
      body,
      sessionId: scope.sessionId,
      spaceId: scope.spaceId,
      signal,
    }, dependencies.skill ?? {}),
    knowledge: async ({ definition, body, scope, signal }) => executeKnowledgeTool({
      config,
      route: definition.route,
      body,
      sessionId: scope.sessionId,
      spaceId: scope.spaceId,
      agentSource: scope.agentSource,
      userId: scope.userId,
      signal,
    }, dependencies.knowledge ?? {}),
  };
}
