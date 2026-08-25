import { describe, expect, it } from "vitest";

import { buildUpstreamBody } from "../../../anthropicHandler.js";
import type { MetadataClient } from "../../../meta/client.js";
import type { SessionInitConfig } from "../../../types.js";
import { appendBlockToAnthropicSystem } from "../../context-injector.js";
import { SessionStore } from "../../store.js";
import { handleSessionInit } from "../init.js";

describe("Claude Code Session Init forwarding boundary", () => {
  it("parses the form answer, persists the selected identity, and injects Agent/Task context before cleanup", async () => {
    const store = new SessionStore();
    const metadataClient = {
      listTeams: async () => [{ team_id: "team-1", name: "Rhino Team" }],
      listAgents: async () => [{
        agent_id: "agent-1",
        team_id: "team-1",
        name: "Native Agent",
        description: "Agent description",
        prompt: "Always answer with the native agent prompt.",
      }],
      listTasks: async () => [{
        task_id: "task-1",
        team_id: "team-1",
        title: "Native Tool Evaluation",
        description: "Evaluate the native-tool implementation.",
      }],
      getAgent: async () => ({
        agent_id: "agent-1",
        team_id: "team-1",
        name: "Native Agent",
        description: "Agent description",
        prompt: "Always answer with the native agent prompt.",
      }),
      getTask: async () => ({
        task_id: "task-1",
        team_id: "team-1",
        title: "Native Tool Evaluation",
        description: "Evaluate the native-tool implementation.",
      }),
      appendParticipationLog: async () => ({ id: "participation-1" }),
    } as unknown as MetadataClient;
    const config: SessionInitConfig = {
      enabled: true,
      maxRetries: 3,
      injectAgentContext: true,
      injectTaskContext: true,
    };
    const reqCtx = {
      stream: true,
      modelId: "deepseek-v4-pro",
      protocol: "anthropic" as const,
    };
    const originalUserMessage = { role: "user", content: "original request" };

    const form = await handleSessionInit(
      "session-1",
      "user-1",
      [originalUserMessage],
      config,
      store,
      reqCtx,
      metadataClient,
      "sk-mem-user",
      "rhino-ab",
    );

    expect(form.intercepted).toBe(true);
    expect(form.response?.status).toBe(200);
    expect(store.get("claude-code:session-1")?.status).toBe("pending_asset_confirm");

    const sessionInitToolUse = {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_cc_session_init_asset_confirm",
        name: "AskUserQuestion",
        input: {},
      }],
    };
    const formAnswer = {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_cc_session_init_asset_confirm",
        content: 'Your questions have been answered: "本次对话是否要关联团队资产？"="是，关联团队资产".',
      }],
    };
    const completeHistory = [originalUserMessage, sessionInitToolUse, formAnswer];

    const completed = await handleSessionInit(
      "session-1",
      "user-1",
      completeHistory,
      config,
      store,
      reqCtx,
      metadataClient,
      "sk-mem-user",
      "rhino-ab",
    );

    expect(completed.intercepted).toBe(false);
    expect(completed.justRegistered).toBe(true);
    expect(completed.messages).toBe(completeHistory);
    expect(completed.systemAppend).toContain("<session_context>");
    expect(completed.systemAppend).toContain("[Agent]");
    expect(completed.systemAppend).toContain("Always answer with the native agent prompt.");
    expect(completed.systemAppend).toContain("[Task]");
    expect(completed.systemAppend).toContain("Evaluate the native-tool implementation.");

    const state = store.get("claude-code:session-1");
    expect(state?.status).toBe("initialized");
    expect(state?.selectedTeamId).toBe("team-1");
    expect(state?.sessionInfo).toMatchObject({
      team_id: "team-1",
      agent_id: "agent-1",
      task_id: "task-1",
      user_id: "user-1",
      session_id: "session-1",
      space_id: "rhino-ab",
    });
    expect(state?.agentDetail?.prompt).toBe("Always answer with the native agent prompt.");
    expect(state?.taskDetail?.description).toBe("Evaluate the native-tool implementation.");

    const upstream = buildUpstreamBody(
      {
        model: "deepseek-v4-pro",
        thinking: { type: "enabled", budget_tokens: 4096 },
        system: appendBlockToAnthropicSystem("Claude Code system", completed.systemAppend!),
        messages: completed.messages,
      },
      {
        url: "https://api.deepseek.com/anthropic",
        model: "deepseek-v4-pro",
        authHeaders: null,
        bodyOverrides: null,
        retryTarget: null,
        turnSeq: 0,
        routedFrom: "",
      },
    ).body;

    expect(upstream.messages).toEqual([originalUserMessage]);
    expect((upstream.messages as unknown[])[0]).toBe(originalUserMessage);
    expect(upstream.system).toContain("Always answer with the native agent prompt.");
    expect(upstream.system).toContain("Evaluate the native-tool implementation.");
    expect(upstream.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });
});
