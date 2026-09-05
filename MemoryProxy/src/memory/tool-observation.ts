import { appendFileSync, constants, mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProxyConfig } from "../types.js";
import { log } from "../report/log.js";

type ObservationConfig = { enabled: boolean; directory: string };
type Status = { enabled: boolean; healthy: boolean; started_at: string; error?: string };
const states = new WeakMap<ProxyConfig, Status>();
const routes: Record<string, string> = {
  "memory:atomic/search": "tdai_memory_search", "memory:atomic/query": "tdai_atomic_query",
  "memory:conversation/search": "tdai_conversation_search", "memory:conversation/query": "tdai_conversation_query",
  "memory:scenario/ls": "tdai_scenario_ls", "memory:scenario/read": "tdai_read_scene",
  "skill:search": "skill_search", "skill:get": "skill_view", "skill:get-by-name": "skill_view",
  "skill:files/read": "skill_files_read", "skill:files/download": "skill_files_read",
  "skill:create": "skill_create", "skill:update": "skill_update", "skill:delete": "skill_delete",
  "skill:files/write": "skill_files_write", "skill:files/delete": "skill_files_delete",
  "skill:extract": "skill_extract",
};

export function parseToolObservation(raw?: Partial<ObservationConfig>): ObservationConfig {
  const enabled = raw?.enabled ?? false;
  const directory = raw?.directory ?? "";
  if (typeof enabled !== "boolean" || typeof directory !== "string" || (enabled && !isAbsolute(directory))) {
    throw new Error("evalToolObservation requires a boolean enabled and an absolute directory");
  }
  return { enabled, directory };
}

/** 只影响评测有效性，不因日志失败改变真实工具的结果。失败保持到进程重启，防止被误算成零调用。 */
function failed(status: Status): void {
  status.healthy = false;
  status.error = "tool_observation_write_failed";
  log.error("eval.tool_observation.write_failed", { evaluationInvalid: true });
}

export function toolObservationStatus(config: ProxyConfig): Status {
  const existing = states.get(config);
  if (existing) return { ...existing };
  const options = config.evalToolObservation;
  const status: Status = { enabled: options?.enabled === true, healthy: true, started_at: new Date().toISOString() };
  states.set(config, status);
  if (status.enabled) {
    try {
      if (!options || !isAbsolute(options.directory)) throw new Error("invalid directory");
      mkdirSync(options.directory, { recursive: true, mode: 0o700 });
      // Runner 读取此文件确认宿主机目录确实对应这个 Proxy，而不只是一个同名空目录。
      writeFileSync(join(options.directory, "observer.json"), JSON.stringify(status), { mode: 0o600 });
    } catch { failed(status); }
  }
  return { ...status };
}

export function observeToolRequest(config: ProxyConfig, input: {
  sessionId: string; family: "memory" | "skill"; subpath: string; callId?: string;
}): void {
  if (!config.evalToolObservation?.enabled) return;
  toolObservationStatus(config);
  const status = states.get(config)!;
  if (!status.healthy) return;
  const toolName = routes[input.family + ":" + input.subpath];
  if (!toolName) return;
  try {
    // 会话 ID 只是文件名，不允许路径穿越；日志中不保存用户参数、身份凭据和工具结果。
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(input.sessionId)) throw new Error("invalid session");
    const event = {
      event_id: randomUUID(), session_id: input.sessionId, tool_name: toolName,
      tool_family: input.family, timestamp: new Date().toISOString(), call_id: input.callId ?? null,
    };
    // 一行同步追加，没有异步发送队列；客户端结束后可直接读取。禁止跟随同名符号链接。
    const fd = openSync(join(config.evalToolObservation.directory, input.sessionId + ".jsonl"),
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { appendFileSync(fd, JSON.stringify(event) + "\n"); } finally { closeSync(fd); }
  } catch { failed(status); }
}
