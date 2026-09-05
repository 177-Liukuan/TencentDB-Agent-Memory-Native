import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../config.js";
import { observeToolRequest, toolObservationStatus } from "../tool-observation.js";

const directories: string[] = [];
afterEach(() => { for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "tool-observation-")); directories.push(directory);
  const config = { ...DEFAULT_CONFIG, evalToolObservation: { enabled: true, directory } };
  return { config, directory };
}
describe("Bridge 发起记录", () => {
  it("不记录参数，同名调用不按名称合并，Native callId 可供重试去重", () => {
    const { config, directory } = setup();
    observeToolRequest(config, { sessionId: "session-1", family: "memory", subpath: "atomic/search", callId: "call-1" });
    observeToolRequest(config, { sessionId: "session-1", family: "memory", subpath: "atomic/search", callId: "call-2" });
    const events = readFileSync(join(directory, "session-1.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(events.map(e => [e.tool_name, e.call_id])).toEqual([["tdai_memory_search", "call-1"], ["tdai_memory_search", "call-2"]]);
    expect(events[0].event_id).not.toEqual(events[1].event_id);
    expect(events[0]).not.toHaveProperty("arguments");
    expect(toolObservationStatus(config).healthy).toBe(true);
  });
  it("默认关闭且拒绝把 sessionId 当作任意文件路径", () => {
    expect(toolObservationStatus(DEFAULT_CONFIG).enabled).toBe(false);
    const { config } = setup();
    observeToolRequest(config, { sessionId: "../escape", family: "skill", subpath: "search" });
    expect(toolObservationStatus(config).healthy).toBe(false);
  });
  it("文件写入失败不抛给业务，但健康检查必须显示采集失败", () => {
    const { config, directory } = setup();
    toolObservationStatus(config);
    writeFileSync(join(directory, "session-2.jsonl"), "placeholder");
    rmSync(directory, { recursive: true });
    writeFileSync(directory, "not a directory");
    expect(() => observeToolRequest(config, { sessionId: "session-2", family: "skill", subpath: "get-by-name" })).not.toThrow();
    expect(toolObservationStatus(config)).toMatchObject({ enabled: true, healthy: false });
  });
  it("资源下载也统一为 skill_files_read，不把后台接口当成工具", () => {
    const { config, directory } = setup();
    observeToolRequest(config, { sessionId: "session-3", family: "skill", subpath: "files/download" });
    const event = JSON.parse(readFileSync(join(directory, "session-3.jsonl"), "utf8"));
    expect(event.tool_name).toBe("skill_files_read");
    observeToolRequest(config, { sessionId: "session-3", family: "skill", subpath: "internal" });
    expect(readFileSync(join(directory, "session-3.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });
});

