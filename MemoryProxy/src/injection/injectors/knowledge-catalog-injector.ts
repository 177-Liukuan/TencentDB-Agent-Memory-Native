import {
  getCoreKnowledgeClient,
  type CoreKnowledgeClient,
  type KnowledgeItem,
} from "../../knowledge/core-client.js";
import type { KnowledgeConfig } from "../../types.js";
import type {
  AgentContext,
  AnchorTarget,
  AssetCapabilityFlags,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
  PrewarmInput,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";

const TAG = "[knowledge-catalog-injector]";

/** Native Tool 注入器据此判断本次请求是否真的拿到了可用资源目录。 */
export const KNOWLEDGE_CATALOG_OPEN_TAG = "<knowledge_catalog>";

type KnowledgeCatalogClient = Pick<
  CoreKnowledgeClient,
  "listAgentKnowledgeIds" | "listKnowledgeByIds"
>;

export interface KnowledgeCatalogInjectorConfig {
  knowledge: KnowledgeConfig;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function attr(name: string, value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? ` ${name}="${xmlEscape(trimmed)}"` : "";
}

function deriveRepoSlug(repoUrl: string | undefined): string | undefined {
  if (!repoUrl) return undefined;
  try {
    const parsed = new URL(repoUrl);
    const slug = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return slug || undefined;
  } catch {
    const match = repoUrl.match(/^[^@]+@[^:]+:(.+)$/);
    const slug = match?.[1]?.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return slug || undefined;
  }
}

function filterByCapabilities(
  resources: KnowledgeItem[],
  capabilities: AssetCapabilityFlags | undefined,
): KnowledgeItem[] {
  return resources.filter((resource) => {
    if (resource.type === "wiki") return capabilities?.llm_wiki !== false;
    if (resource.type === "code-graph") return capabilities?.code_graph !== false;
    return false;
  });
}

/**
 * 目录只告诉模型“有哪些资源、何时选哪个资源”。服务地址、鉴权和 HTTP
 * 约定全部留在 Proxy 内部，避免把旧版 curl 使用说明重新带回提示词。
 */
export function renderKnowledgeCatalog(resources: KnowledgeItem[]): string | null {
  if (resources.length === 0) return null;
  const items = resources.map((resource) => {
    if (resource.type === "wiki") {
      return `<knowledge type="wiki" id="${xmlEscape(resource.knowledge_id)}" name="${xmlEscape(resource.name)}"${attr("about", resource.summary)} />`;
    }
    const match = resource.repo_slug ?? deriveRepoSlug(resource.repo_url);
    return `<knowledge type="code-graph" id="${xmlEscape(resource.knowledge_id)}" name="${xmlEscape(resource.name)}"${attr("match", match)}${attr("branch", resource.branch)} />`;
  });

  return [
    KNOWLEDGE_CATALOG_OPEN_TAG,
    "当前 Agent 可使用以下云端知识资源。Wiki 适合查询设计背景、历史决策和团队文档；Code Graph 适合查询与当前仓库匹配的跨文件结构、符号关系和影响范围。需要确认本地未提交代码的精确内容时，仍使用客户端文件工具。",
    ...items,
    "首次使用某个资源时，先调用 tdai_knowledge_tools_list 获取它当前提供的工具和参数，再用 tdai_knowledge_tool_call 执行；knowledge_id 必须来自上面的目录。",
    "</knowledge_catalog>",
  ].join("\n");
}

export class KnowledgeCatalogInjector implements InjectionHook {
  readonly id = "knowledge-catalog-injector";
  readonly point = "system.before_tools" as const;
  readonly anchor: AnchorTarget = { slot: "knowledge", relation: "after" };
  readonly priority: HookPriority = HOOK_PRIORITY.WIKI;
  readonly description = "Inject the authorized Knowledge resource catalog";
  readonly cacheStrategy: CacheStrategy = "session_init";

  constructor(
    private readonly config: KnowledgeCatalogInjectorConfig,
    private readonly clientOverride?: KnowledgeCatalogClient,
  ) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
    const session = custom?.session as Record<string, unknown> | undefined;
    return this.load({
      teamId: stringField(session, "team_id"),
      agentId: stringField(session, "agent_id"),
      userKey: stringField(custom, "userKey") ?? stringField(session, "user_key"),
      spaceId: stringField(session, "space_id") ?? ctx.metadata.spaceId ?? null,
      capabilities: custom?.assetCapabilities as AssetCapabilityFlags | undefined,
    });
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    return this.load({
      teamId: input.sessionInfo.team_id || null,
      agentId: input.sessionInfo.agent_id || null,
      userKey: input.callerUserKey ?? input.sessionInfo.user_key ?? null,
      spaceId: input.sessionInfo.space_id ?? input.spaceId ?? null,
      capabilities: input.assetCapabilities,
    });
  }

  private async load(input: {
    teamId: string | null;
    agentId: string | null;
    userKey: string | null;
    spaceId: string | null;
    capabilities?: AssetCapabilityFlags;
  }): Promise<ContextBlock[]> {
    // 不具备用户级 ACL 所需身份时直接不提供目录，禁止退回团队全量资源。
    if (!input.teamId || !input.agentId || !input.userKey) return [];
    try {
      const client = this.clientOverride ?? getCoreKnowledgeClient(this.config.knowledge);
      const options = { serviceId: input.spaceId ?? undefined };
      const ids = await client.listAgentKnowledgeIds(input.agentId, input.userKey, options);
      if (ids.length === 0) return [];
      const idSet = new Set(ids);
      const details = await client.listKnowledgeByIds(input.teamId, ids, options);
      const resources = filterByCapabilities(
        details.filter((item) => item.team_id === input.teamId && idSet.has(item.knowledge_id)),
        input.capabilities,
      );
      const content = renderKnowledgeCatalog(resources);
      if (!content) return [];
      return [{
        type: "text",
        content,
        metadata: {
          source: this.id,
          cacheKey: `${this.id}:agent:${input.agentId}`,
        },
      }];
    } catch (error) {
      console.warn(`${TAG} load failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }
}

function stringField(
  object: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = object?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
