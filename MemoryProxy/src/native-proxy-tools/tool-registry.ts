import type { JsonValue } from "./types.js";

export interface NativeProxyToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  owner: "proxy";
  effect: "read";
  route: "atomic/search";
  validate(input: unknown):
    | { ok: true; value: Record<string, JsonValue> }
    | { ok: false; message: string };
}

export interface NativeProxyToolRegistry {
  list(): readonly NativeProxyToolDefinition[];
  get(name: string): NativeProxyToolDefinition | undefined;
  require(name: string): NativeProxyToolDefinition;
  owns(name: string): boolean;
}

const MEMORY_SEARCH_DESCRIPTION =
  "搜索已经提炼的长期记忆，用于查找当前上下文之外的用户偏好、身份事实、历史结论、规则和项目约定。过去消息的具体原文或时间线不属于本工具范围。";

const MEMORY_SEARCH_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 2_000,
      description: "需要检索的问题或关键词",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      default: 5,
    },
  },
  required: ["query"],
};

function validateMemorySearchInput(input: unknown):
  | { ok: true; value: Record<string, JsonValue> }
  | { ok: false; message: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "input must be an object" };
  }

  const record = input as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter((key) => key !== "query" && key !== "limit");
  if (unknownFields.length > 0) {
    return { ok: false, message: `unknown input field: ${unknownFields[0]}` };
  }

  if (typeof record.query !== "string") {
    return { ok: false, message: "query must be a string" };
  }
  const query = record.query.trim();
  if (query.length === 0 || query.length > 2_000) {
    return { ok: false, message: "query length must be between 1 and 2000 characters" };
  }

  const limit = record.limit ?? 5;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 20) {
    return { ok: false, message: "limit must be an integer between 1 and 20" };
  }

  return {
    ok: true,
    value: { query, limit: limit as number },
  };
}

class DefaultNativeProxyToolRegistry implements NativeProxyToolRegistry {
  private readonly tools: readonly NativeProxyToolDefinition[];
  private readonly toolsByName: ReadonlyMap<string, NativeProxyToolDefinition>;

  constructor() {
    const memorySearch: NativeProxyToolDefinition = {
      name: "tdai_memory_search",
      description: MEMORY_SEARCH_DESCRIPTION,
      inputSchema: MEMORY_SEARCH_INPUT_SCHEMA,
      owner: "proxy",
      effect: "read",
      route: "atomic/search",
      validate: validateMemorySearchInput,
    };
    this.tools = Object.freeze([memorySearch]);
    this.toolsByName = new Map([[memorySearch.name, memorySearch]]);
  }

  list(): readonly NativeProxyToolDefinition[] {
    return this.tools;
  }

  get(name: string): NativeProxyToolDefinition | undefined {
    return this.toolsByName.get(name);
  }

  require(name: string): NativeProxyToolDefinition {
    const tool = this.get(name);
    if (!tool) throw new Error(`Unknown Native Proxy Tool: ${name}`);
    return tool;
  }

  owns(name: string): boolean {
    return this.toolsByName.has(name);
  }
}

export function createDefaultNativeProxyToolRegistry(): NativeProxyToolRegistry {
  return new DefaultNativeProxyToolRegistry();
}
