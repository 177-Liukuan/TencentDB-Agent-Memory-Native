/**
 * 回归验证跨用户请求的调用顺序，不访问模型或数据库。
 * Native 记录只保存前置客户端调用 ID，不复制客户端的参数和结果；错序时以退出码 1 报告。
 */
import { reconstructAnthropicToolLedger } from "../../src/native-proxy-tools/tool-history-reconstructor.js";
import type { JsonValue, NativeToolLedgerRound } from "../../src/native-proxy-tools/types.js";

const messages: JsonValue[] = [{ role: "user", content: "question" }];
for (const id of ["client-1", "client-2"]) {
  messages.push(
    { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: "pwd" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "/workspace" }] },
  );
}
messages.push({ role: "assistant", content: [{ type: "text", text: "answer" }] });
const rounds: NativeToolLedgerRound[] = [1, 4].map((round, index) => ({
  ledgerId: `round-${round}`,
  scope: { spaceId: "test", userId: "user", agentSource: "claude-code", sessionId: "test" },
  contextEpoch: 0, turnSeq: 1, round, clientProtocol: "anthropic",
  blocks: [{ kind: "native_tool", blockIndex: 0, callId: `native-${index + 1}`, toolName: "tdai_memory_search", input: { query: "rules" } }],
  nativeResults: [{ callId: `native-${index + 1}`, value: "memory", isError: false }],
  createdAt: "2026-09-05T00:00:00.000Z",
  previousClientToolCallId: index === 0 ? null : "client-2",
}));
const restored = reconstructAnthropicToolLedger({ messages, rounds, turns: [{ turnSeq: 1, insertAfterItem: 1 }] });
const actual: string[] = [];
for (const message of restored) {
  if (!message || typeof message !== "object" || Array.isArray(message) || !Array.isArray(message.content)) continue;
  for (const block of message.content) {
    if (block && typeof block === "object" && !Array.isArray(block) && block.type === "tool_use" && typeof block.id === "string") actual.push(block.id);
  }
}
const expected = ["native-1", "client-1", "client-2", "native-2"];
const passed = JSON.stringify(actual) === JSON.stringify(expected);
console.log(JSON.stringify({ passed, expected, actual }, null, 2));
process.exitCode = passed ? 0 : 1;
