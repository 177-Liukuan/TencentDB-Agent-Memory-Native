import type { JsonValue, NativeToolBackend, NativeToolEffect } from "./types.js";

export type NativeToolExposure = "memory" | "skill-read" | "skill-write";

export interface NativeToolExposureContext {
  memoryEnabled: boolean;
  chatMemory: boolean;
  skillEnabled: boolean;
  skillCapability: boolean;
  allowSkillWrite: boolean;
}

export type NativeToolValidationResult =
  | { ok: true; value: Record<string, JsonValue> }
  | { ok: false; message: string };

export interface NativeProxyToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  owner: "proxy";
  backend: NativeToolBackend;
  effect: NativeToolEffect;
  route: string;
  exposure: NativeToolExposure;
  validate(input: unknown): NativeToolValidationResult;
}

export interface NativeProxyToolRegistry {
  list(): readonly NativeProxyToolDefinition[];
  visibleFor(context: NativeToolExposureContext): readonly NativeProxyToolDefinition[];
  get(name: string): NativeProxyToolDefinition | undefined;
  require(name: string): NativeProxyToolDefinition;
  owns(name: string): boolean;
}

type InputRecord = Record<string, unknown>;
type Normalize = (input: InputRecord) => NativeToolValidationResult;

const stringProperty = (description: string, maxLength = 2_000): Record<string, unknown> => ({
  type: "string", minLength: 1, maxLength, description,
});

const integerProperty = (minimum: number, maximum: number, defaultValue?: number): Record<string, unknown> => ({
  type: "integer", minimum, maximum,
  ...(defaultValue === undefined ? {} : { default: defaultValue }),
});

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length === 0 ? {} : { required }),
  };
}

function strictObject(
  input: unknown,
  allowed: readonly string[],
): { ok: true; value: InputRecord } | { ok: false; message: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "input must be an object" };
  }
  const value = input as InputRecord;
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  return unknown
    ? { ok: false, message: `unknown input field: ${unknown}` }
    : { ok: true, value };
}

function stringValue(
  input: InputRecord,
  key: string,
  options: { required?: boolean; max?: number; allowEmpty?: boolean } = {},
): { ok: true; value?: string } | { ok: false; message: string } {
  const raw = input[key];
  if (raw === undefined) {
    return options.required ? { ok: false, message: `${key} is required` } : { ok: true };
  }
  if (typeof raw !== "string") return { ok: false, message: `${key} must be a string` };
  const value = options.allowEmpty ? raw : raw.trim();
  if (!options.allowEmpty && value.length === 0) return { ok: false, message: `${key} must not be empty` };
  if (value.length > (options.max ?? 2_000)) return { ok: false, message: `${key} is too long` };
  return { ok: true, value };
}

function integerValue(
  input: InputRecord,
  key: string,
  minimum: number,
  maximum: number,
  defaultValue?: number,
): { ok: true; value?: number } | { ok: false; message: string } {
  const raw = input[key] ?? defaultValue;
  if (raw === undefined) return { ok: true };
  if (!Number.isInteger(raw) || (raw as number) < minimum || (raw as number) > maximum) {
    return { ok: false, message: `${key} must be an integer between ${minimum} and ${maximum}` };
  }
  return { ok: true, value: raw as number };
}

function booleanValue(
  input: InputRecord,
  key: string,
  defaultValue?: boolean,
): { ok: true; value?: boolean } | { ok: false; message: string } {
  const raw = input[key] ?? defaultValue;
  if (raw === undefined) return { ok: true };
  return typeof raw === "boolean"
    ? { ok: true, value: raw }
    : { ok: false, message: `${key} must be a boolean` };
}

function enumValue(
  input: InputRecord,
  key: string,
  values: readonly string[],
): { ok: true; value?: string } | { ok: false; message: string } {
  const raw = input[key];
  if (raw === undefined) return { ok: true };
  return typeof raw === "string" && values.includes(raw)
    ? { ok: true, value: raw }
    : { ok: false, message: `${key} must be one of ${values.join(", ")}` };
}

function validate(input: unknown, allowed: readonly string[], normalize: Normalize): NativeToolValidationResult {
  const object = strictObject(input, allowed);
  return object.ok ? normalize(object.value) : object;
}

function success(entries: Array<[string, JsonValue | undefined]>): NativeToolValidationResult {
  return {
    ok: true,
    value: Object.fromEntries(entries.filter((entry): entry is [string, JsonValue] => entry[1] !== undefined)),
  };
}

function queryValidator(input: unknown): NativeToolValidationResult {
  return validate(input, ["query", "limit"], (record) => {
    const query = stringValue(record, "query", { required: true });
    if (!query.ok) return query;
    const limit = integerValue(record, "limit", 1, 20, 5);
    return limit.ok ? success([["query", query.value], ["limit", limit.value]]) : limit;
  });
}

function idValidator(input: unknown): NativeToolValidationResult {
  return validate(input, ["skill_id"], (record) => {
    const id = stringValue(record, "skill_id", { required: true });
    return id.ok ? success([["skill_id", id.value]]) : id;
  });
}

function validateResource(value: unknown): { ok: true; value: Record<string, JsonValue> } | { ok: false; message: string } {
  const object = strictObject(value, ["path", "content", "encoding", "mime_type", "is_executable"]);
  if (!object.ok) return object;
  const path = stringValue(object.value, "path", { required: true, max: 1_024 });
  if (!path.ok) return path;
  const content = stringValue(object.value, "content", { required: true, max: 1_048_576, allowEmpty: true });
  if (!content.ok) return content;
  const encoding = enumValue(object.value, "encoding", ["utf-8", "base64"]);
  if (!encoding.ok) return encoding;
  const mime = stringValue(object.value, "mime_type", { max: 128 });
  if (!mime.ok) return mime;
  const executable = booleanValue(object.value, "is_executable");
  if (!executable.ok) return executable;
  return success([
    ["path", path.value], ["content", content.value], ["encoding", encoding.value ?? "utf-8"],
    ["mime_type", mime.value], ["is_executable", executable.value],
  ]) as { ok: true; value: Record<string, JsonValue> };
}

function resourceArray(
  input: InputRecord,
  key: string,
  required: boolean,
): { ok: true; value?: JsonValue[] } | { ok: false; message: string } {
  const raw = input[key];
  if (raw === undefined) return required ? { ok: false, message: `${key} is required` } : { ok: true };
  if (!Array.isArray(raw) || (required && raw.length === 0) || raw.length > 64) {
    return { ok: false, message: `${key} must contain between ${required ? 1 : 0} and 64 files` };
  }
  const result: JsonValue[] = [];
  for (const value of raw) {
    const resource = validateResource(value);
    if (!resource.ok) return { ok: false, message: `${key}: ${resource.message}` };
    result.push(resource.value);
  }
  return { ok: true, value: result };
}

function pathArray(input: InputRecord): { ok: true; value: JsonValue[] } | { ok: false; message: string } {
  const raw = input.paths;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 64) {
    return { ok: false, message: "paths must contain between 1 and 64 paths" };
  }
  const result: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 1_024) {
      return { ok: false, message: "paths must contain non-empty strings no longer than 1024 characters" };
    }
    result.push(value.trim());
  }
  return { ok: true, value: result };
}

function definition(value: Omit<NativeProxyToolDefinition, "owner">): NativeProxyToolDefinition {
  return Object.freeze({ owner: "proxy" as const, ...value });
}

const resourceSchema = objectSchema({
  path: stringProperty("Skill 资源中的相对路径", 1_024),
  content: { type: "string", maxLength: 1_048_576 },
  encoding: { type: "string", enum: ["utf-8", "base64"], default: "utf-8" },
  mime_type: { type: "string", maxLength: 128 },
  is_executable: { type: "boolean" },
}, ["path", "content"]);

const TOOLS: readonly NativeProxyToolDefinition[] = Object.freeze([
  definition({
    name: "tdai_memory_search",
    description: "搜索已提炼的长期记忆，用于偏好、身份、规则和历史结论；查原始消息应使用 tdai_conversation_search。",
    inputSchema: objectSchema({ query: stringProperty("检索问题或关键词"), limit: integerProperty(1, 20, 5) }, ["query"]),
    backend: "memory", effect: "read", route: "atomic/search", exposure: "memory", validate: queryValidator,
  }),
  definition({
    name: "tdai_atomic_query",
    description: "按已知类型、时间范围和分页条件读取 L1 原子记忆，不执行语义搜索。",
    inputSchema: objectSchema({
      type: { type: "string", enum: ["episodic", "persona", "instruction"] },
      limit: integerProperty(1, 100, 20), offset: integerProperty(0, 100_000, 0),
      time_start: { type: "string", format: "date-time" }, time_end: { type: "string", format: "date-time" },
    }),
    backend: "memory", effect: "read", route: "atomic/query", exposure: "memory",
    validate: (input) => validate(input, ["type", "limit", "offset", "time_start", "time_end"], (record) => {
      const type = enumValue(record, "type", ["episodic", "persona", "instruction"]); if (!type.ok) return type;
      const limit = integerValue(record, "limit", 1, 100, 20); if (!limit.ok) return limit;
      const offset = integerValue(record, "offset", 0, 100_000, 0); if (!offset.ok) return offset;
      const start = stringValue(record, "time_start", { max: 64 }); if (!start.ok) return start;
      const end = stringValue(record, "time_end", { max: 64 }); if (!end.ok) return end;
      if (start.value && !Number.isFinite(Date.parse(start.value))) return { ok: false, message: "time_start must be an ISO timestamp" };
      if (end.value && !Number.isFinite(Date.parse(end.value))) return { ok: false, message: "time_end must be an ISO timestamp" };
      return success([["type", type.value], ["limit", limit.value], ["offset", offset.value], ["time_start", start.value], ["time_end", end.value]]);
    }),
  }),
  definition({
    name: "tdai_conversation_search",
    description: "在 L0 原始对话中检索具体消息原文、上下文和时间线；稳定偏好或结论优先使用 tdai_memory_search。",
    inputSchema: objectSchema({ query: stringProperty("检索问题或关键词"), limit: integerProperty(1, 20, 5), session_id: stringProperty("可选的历史会话标识") }, ["query"]),
    backend: "memory", effect: "read", route: "conversation/search", exposure: "memory",
    validate: (input) => validate(input, ["query", "limit", "session_id"], (record) => {
      const query = stringValue(record, "query", { required: true }); if (!query.ok) return query;
      const limit = integerValue(record, "limit", 1, 20, 5); if (!limit.ok) return limit;
      const session = stringValue(record, "session_id"); if (!session.ok) return session;
      return success([["query", query.value], ["limit", limit.value], ["session_id", session.value]]);
    }),
  }),
  definition({
    name: "tdai_conversation_query",
    description: "按已知 Session 顺序读取 L0 历史消息；跨会话语义查找应使用 tdai_conversation_search。",
    inputSchema: objectSchema({ session_id: stringProperty("需要读取的会话标识"), limit: integerProperty(1, 200, 50), offset: integerProperty(0, 100_000, 0) }, ["session_id"]),
    backend: "memory", effect: "read", route: "conversation/query", exposure: "memory",
    validate: (input) => validate(input, ["session_id", "limit", "offset"], (record) => {
      const session = stringValue(record, "session_id", { required: true }); if (!session.ok) return session;
      const limit = integerValue(record, "limit", 1, 200, 50); if (!limit.ok) return limit;
      const offset = integerValue(record, "offset", 0, 100_000, 0); if (!offset.ok) return offset;
      return success([["session_id", session.value], ["limit", limit.value], ["offset", offset.value]]);
    }),
  }),
  definition({
    name: "tdai_scenario_ls",
    description: "列出 L2 场景路径和摘要索引，不读取完整正文。",
    inputSchema: objectSchema({ path_prefix: { type: "string", maxLength: 1_024 } }),
    backend: "memory", effect: "read", route: "scenario/ls", exposure: "memory",
    validate: (input) => validate(input, ["path_prefix"], (record) => {
      const prefix = stringValue(record, "path_prefix", { max: 1_024, allowEmpty: true });
      return prefix.ok ? success([["path_prefix", prefix.value]]) : prefix;
    }),
  }),
  definition({
    name: "tdai_read_scene",
    description: "读取一个已从场景索引或 tdai_scenario_ls 得到的 L2 场景路径全文。",
    inputSchema: objectSchema({ path: stringProperty("场景路径", 1_024) }, ["path"]),
    backend: "memory", effect: "read", route: "scenario/read", exposure: "memory",
    validate: (input) => validate(input, ["path"], (record) => {
      const path = stringValue(record, "path", { required: true, max: 1_024 });
      return path.ok ? success([["path", path.value]]) : path;
    }),
  }),
  definition({
    name: "skill_search",
    description: "在当前用户有权访问的团队 Skill 中检索匹配项。",
    inputSchema: objectSchema({ query: stringProperty("Skill 关键词") }, ["query"]),
    backend: "skill", effect: "read", route: "search", exposure: "skill-read",
    validate: (input) => validate(input, ["query"], (record) => {
      const query = stringValue(record, "query", { required: true });
      return query.ok ? success([["query", query.value]]) : query;
    }),
  }),
  definition({
    name: "skill_view",
    description: "按稳定 skill_id 读取 SKILL.md 全文和资源目录。",
    inputSchema: objectSchema({ skill_id: stringProperty("Skill 标识") }, ["skill_id"]),
    backend: "skill", effect: "read", route: "get", exposure: "skill-read",
    validate: (input) => validate(input, ["skill_id"], (record) => {
      const id = stringValue(record, "skill_id", { required: true });
      return id.ok ? success([["skill_id", id.value], ["include_content", true], ["include_manifest", true]]) : id;
    }),
  }),
  definition({
    name: "skill_files_read",
    description: "读取 skill_view 资源目录中已知路径的单个文件，内容受结果大小限制。",
    inputSchema: objectSchema({ skill_id: stringProperty("Skill 标识"), path: stringProperty("资源相对路径", 1_024), encoding: { type: "string", enum: ["utf-8", "base64"], default: "utf-8" } }, ["skill_id", "path"]),
    backend: "skill", effect: "read", route: "files/read", exposure: "skill-read",
    validate: (input) => validate(input, ["skill_id", "path", "encoding"], (record) => {
      const id = stringValue(record, "skill_id", { required: true }); if (!id.ok) return id;
      const path = stringValue(record, "path", { required: true, max: 1_024 }); if (!path.ok) return path;
      const encoding = enumValue(record, "encoding", ["utf-8", "base64"]); if (!encoding.ok) return encoding;
      return success([["skill_id", id.value], ["path", path.value], ["encoding", encoding.value ?? "utf-8"]]);
    }),
  }),
  definition({
    name: "skill_extract",
    description: "归档当前会话并异步触发一次 Skill 抽取。仅在完整可复用流程已经形成时使用。",
    inputSchema: objectSchema({ reason: { type: "string", maxLength: 2_000 } }),
    backend: "skill", effect: "archive", route: "extract", exposure: "skill-read",
    validate: (input) => validate(input, ["reason"], (record) => {
      const reason = stringValue(record, "reason");
      return reason.ok ? success([["reason", reason.value]]) : reason;
    }),
  }),
  definition({
    name: "skill_create",
    description: "为当前 Agent 创建新的云端 Skill。",
    inputSchema: objectSchema({ name: stringProperty("Skill 名称", 64), content: stringProperty("完整 SKILL.md", 262_144), resources: { type: "array", maxItems: 64, items: resourceSchema } }, ["name", "content"]),
    backend: "skill", effect: "write", route: "create", exposure: "skill-write",
    validate: (input) => validate(input, ["name", "content", "resources"], (record) => {
      const name = stringValue(record, "name", { required: true, max: 64 }); if (!name.ok) return name;
      const content = stringValue(record, "content", { required: true, max: 262_144 }); if (!content.ok) return content;
      const resources = resourceArray(record, "resources", false); if (!resources.ok) return resources;
      return success([["name", name.value], ["content", content.value], ["resources", resources.value]]);
    }),
  }),
  definition({
    name: "skill_update",
    description: "替换已有 Skill 的 SKILL.md；版本锁由 Proxy 自动补充。",
    inputSchema: objectSchema({ skill_id: stringProperty("Skill 标识"), content: stringProperty("新的完整 SKILL.md", 262_144) }, ["skill_id", "content"]),
    backend: "skill", effect: "write", route: "update", exposure: "skill-write",
    validate: (input) => validate(input, ["skill_id", "content"], (record) => {
      const id = stringValue(record, "skill_id", { required: true }); if (!id.ok) return id;
      const content = stringValue(record, "content", { required: true, max: 262_144 }); if (!content.ok) return content;
      return success([["skill_id", id.value], ["content", content.value]]);
    }),
  }),
  definition({
    name: "skill_patch",
    description: "对已有 Skill 的 SKILL.md 做受版本锁保护的字符串替换。",
    inputSchema: objectSchema({ skill_id: stringProperty("Skill 标识"), old_string: stringProperty("待替换文本", 262_144), new_string: { type: "string", maxLength: 262_144 }, replace_all: { type: "boolean", default: false } }, ["skill_id", "old_string", "new_string"]),
    backend: "skill", effect: "write", route: "patch", exposure: "skill-write",
    validate: (input) => validate(input, ["skill_id", "old_string", "new_string", "replace_all"], (record) => {
      const id = stringValue(record, "skill_id", { required: true }); if (!id.ok) return id;
      const oldText = stringValue(record, "old_string", { required: true, max: 262_144 }); if (!oldText.ok) return oldText;
      const newText = stringValue(record, "new_string", { required: true, max: 262_144, allowEmpty: true }); if (!newText.ok) return newText;
      const replaceAll = booleanValue(record, "replace_all", false); if (!replaceAll.ok) return replaceAll;
      return success([["skill_id", id.value], ["old_string", oldText.value], ["new_string", newText.value], ["replace_all", replaceAll.value]]);
    }),
  }),
  definition({
    name: "skill_delete",
    description: "软删除当前 Agent 拥有的 Skill；版本锁由 Proxy 自动补充。",
    inputSchema: objectSchema({ skill_id: stringProperty("Skill 标识") }, ["skill_id"]),
    backend: "skill", effect: "write", route: "delete", exposure: "skill-write", validate: idValidator,
  }),
  definition({
    name: "skill_files_write",
    description: "新增或修改 Skill 资源文件；版本锁由 Proxy 自动补充。",
    inputSchema: objectSchema({ skill_id: stringProperty("Skill 标识"), files: { type: "array", minItems: 1, maxItems: 64, items: resourceSchema } }, ["skill_id", "files"]),
    backend: "skill", effect: "write", route: "files/write", exposure: "skill-write",
    validate: (input) => validate(input, ["skill_id", "files"], (record) => {
      const id = stringValue(record, "skill_id", { required: true }); if (!id.ok) return id;
      const files = resourceArray(record, "files", true); if (!files.ok) return files;
      return success([["skill_id", id.value], ["files", files.value]]);
    }),
  }),
  definition({
    name: "skill_files_remove",
    description: "删除 Skill 中的资源文件；版本锁由 Proxy 自动补充。",
    inputSchema: objectSchema({ skill_id: stringProperty("Skill 标识"), paths: { type: "array", minItems: 1, maxItems: 64, items: stringProperty("资源相对路径", 1_024) } }, ["skill_id", "paths"]),
    backend: "skill", effect: "write", route: "files/remove", exposure: "skill-write",
    validate: (input) => validate(input, ["skill_id", "paths"], (record) => {
      const id = stringValue(record, "skill_id", { required: true }); if (!id.ok) return id;
      const paths = pathArray(record); if (!paths.ok) return paths;
      return success([["skill_id", id.value], ["paths", paths.value]]);
    }),
  }),
]);

class DefaultNativeProxyToolRegistry implements NativeProxyToolRegistry {
  private readonly toolsByName = new Map(TOOLS.map((tool) => [tool.name, tool]));

  list(): readonly NativeProxyToolDefinition[] { return TOOLS; }

  visibleFor(context: NativeToolExposureContext): readonly NativeProxyToolDefinition[] {
    return TOOLS.filter((tool) => {
      if (tool.exposure === "memory") return context.memoryEnabled && context.chatMemory;
      if (!context.skillEnabled || !context.skillCapability) return false;
      return tool.exposure === "skill-read" || context.allowSkillWrite;
    });
  }

  get(name: string): NativeProxyToolDefinition | undefined { return this.toolsByName.get(name); }

  require(name: string): NativeProxyToolDefinition {
    const tool = this.get(name);
    if (!tool) throw new Error(`Unknown Native Proxy Tool: ${name}`);
    return tool;
  }

  owns(name: string): boolean { return this.toolsByName.has(name); }
}

export function createDefaultNativeProxyToolRegistry(): NativeProxyToolRegistry {
  return new DefaultNativeProxyToolRegistry();
}
