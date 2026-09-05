import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../config.js";
import { NativeProxyToolDispatcher } from "../../native-proxy-tools/native-proxy-tool-dispatcher.js";
import { createDefaultNativeProxyToolRegistry } from "../../native-proxy-tools/tool-registry.js";
it("Native 重试透传原 callId，访问多个 Memory 来源不增加发起记录", async () => {
  const directory = mkdtempSync(join(tmpdir(), "native-observation-"));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.evalToolObservation = { enabled: true, directory };
    config.nativeProxyTools.toolTimeoutMs = 5000;
    let fetches = 0;
    const dispatcher = new NativeProxyToolDispatcher({
      config, registry: createDefaultNativeProxyToolRegistry(),
      bridgeDeps: {
        loadSessionIdentity: async () => ({user_id:"user",team_id:"team",agent_id:"self",session_id:"session",space_id:"space"}),
        resolveMemoryContexts: async () => [
          {teamId:"team",userId:"user",agentId:"self",agentName:"self",isSelf:true},
          {teamId:"team",userId:"user",agentId:"borrowed",agentName:"borrowed",isSelf:false},
        ],
        fetcher: async () => {
          fetches++;
          return new Response('{"code":503,"message":"unavailable"}', {status:503});
        },
        emitTelemetry: () => {},
      },
    });
    await dispatcher.execute({
      callId:"call-1",toolName:"tdai_memory_search",owner:"proxy",slotIndex:0,contentBlockIndex:0,
      argumentsComplete:true,input:{query:"rules"},
    },{spaceId:"space",userId:"user",agentSource:"claude-code",sessionId:"session",contextVersion:"v1"});
    const events=readFileSync(join(directory,"session.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
    expect(fetches).toBe(4);
    expect(events.map(e=>e.call_id)).toEqual(["call-1","call-1"]);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

