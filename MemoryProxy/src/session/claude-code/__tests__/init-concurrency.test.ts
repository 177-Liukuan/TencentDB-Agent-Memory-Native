import { describe, expect, it, vi } from "vitest";
import type { MetadataClient } from "../../../meta/client.js";
import type { SessionInitConfig } from "../../../types.js";
import { SessionStore } from "../../store.js";
import { handleSessionInit } from "../init.js";

const config: SessionInitConfig = {
  enabled: true, maxRetries: 3, injectAgentContext: true, injectTaskContext: true,
  headerAutoSelect: { enabled: true, teamHeader: "x-team-id", agentHeader: "x-agent-id", taskHeader: "x-task-id", onMismatch: "bypass" },
};
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function client() {
  return {
    listTeams: async () => [{ team_id: "team", name: "Team" }],
    listAgents: async () => [{ agent_id: "agent", team_id: "team", name: "Agent" }],
    listTasks: async () => [{ task_id: "task", team_id: "team", title: "Task" }],
    getAgent: async () => ({ agent_id: "agent", team_id: "team", name: "Agent", prompt: "Project guidance" }),
    getTask: async () => ({ task_id: "task", team_id: "team", title: "Task" }),
    appendParticipationLog: async () => ({ id: "log" }),
  };
}
function run(store: SessionStore, metadata: ReturnType<typeof client>, session = "session", text = "request") {
  return handleSessionInit(session, "user", [{ role: "user", content: text }], config, store,
    { stream: true, modelId: "test", protocol: "anthropic" }, metadata as unknown as MetadataClient,
    "test-key", "space", { teamId: "team", agentId: "agent", taskId: "task" });
}
describe("同一 Session 的初始化并发", () => {
  it("成功初始化不会被另一请求的迟到超时覆盖，且各请求保留自己的消息", async () => {
    const store = new SessionStore();
    const started = gate(), success = gate(), timeout = gate();
    const metadata = client();
    let calls = 0;
    metadata.listTeams = async () => {
      if (++calls === 1) { started.release(); await success.promise; return [{ team_id: "team", name: "Team" }]; }
      await timeout.promise;
      throw new Error("metadata timeout");
    };
    const first = run(store, metadata);
    await started.promise;
    const second = run(store, metadata, "session", "second request");
    success.release();
    await first;
    timeout.release();
    const result = await second;
    expect(store.get("claude-code:session")).toMatchObject({ status: "initialized", sessionInfo: { agent_id: "agent" } });
    expect(store.get("claude-code:session")?.bypassed).not.toBe(true);
    expect(result.systemAppend).toContain("Project guidance");
    expect(result.messages).toEqual([{ role: "user", content: "second request" }]);
    expect(calls).toBe(1);
  });
  it("不同 Session 不会被一个慢请求阻塞", async () => {
    const store = new SessionStore(), started = gate(), finish = gate();
    const slow = client();
    slow.listTeams = async () => { started.release(); await finish.promise; return [{ team_id: "team", name: "Team" }]; };
    const pending = run(store, slow, "slow");
    await started.promise;
    try {
      expect((await run(store, client(), "fast")).sessionInfo?.session_id).toBe("fast");
    } finally { finish.release(); await pending; }
  });
  it("异常退出也会释放排队请求", async () => {
    const store = new SessionStore();
    const set = vi.spyOn(store, "set").mockRejectedValueOnce(new Error("storage failed"));
    await expect(run(store, client())).rejects.toThrow("storage failed");
    set.mockRestore();
    expect((await run(store, client())).sessionInfo?.agent_id).toBe("agent");
  });
});
