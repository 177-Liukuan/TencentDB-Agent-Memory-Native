import type {
  JsonValue,
  NativeToolLedgerBlock,
  NativeToolLedgerRound,
} from "./types.js";
import type { NativeToolLedgerStorageAdapter } from "../db/native-tool-ledger-storage-adapter.js";
import { extractClaudeTurnMarkers } from "./turn-marker.js";

export class NativeToolLedgerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeToolLedgerConflictError";
  }
}

interface TurnPosition {
  turnSeq: number;
  insertAfterItem: number;
}

interface MixedRoundPosition {
  round: number;
  assistantIndex: number;
  resultIndex: number;
}

function record(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NativeToolLedgerConflictError("Native Tool history message is invalid");
  }
  return value as Record<string, JsonValue>;
}

function blocksAt(messages: JsonValue[], index: number): JsonValue[] {
  const content = record(messages[index]!).content;
  if (!Array.isArray(content)) {
    throw new NativeToolLedgerConflictError("Native Tool history requires block content");
  }
  return content;
}

function toolUse(block: JsonValue): { id: string; name: string } | null {
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const value = block as Record<string, JsonValue>;
  return value.type === "tool_use" && typeof value.id === "string" && typeof value.name === "string"
    ? { id: value.id, name: value.name }
    : null;
}

function toolResult(block: JsonValue): { id: string } | null {
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const value = block as Record<string, JsonValue>;
  return value.type === "tool_result" && typeof value.tool_use_id === "string"
    ? { id: value.tool_use_id }
    : null;
}

function assistantBlock(block: NativeToolLedgerBlock): JsonValue | null {
  if (block.kind === "client_tool_ref") return null;
  if (block.kind === "hidden_content") return structuredClone(block.value);
  return {
    type: "tool_use",
    id: block.callId,
    name: block.toolName,
    input: structuredClone(block.input),
  };
}

function nativeResult(round: NativeToolLedgerRound, callId: string): JsonValue {
  const result = round.nativeResults.find((candidate) => candidate.callId === callId);
  if (!result) {
    throw new NativeToolLedgerConflictError(`Native Tool result is missing for ${callId}`);
  }
  return {
    type: "tool_result",
    tool_use_id: callId,
    content: structuredClone(result.value),
    ...(result.isError ? { is_error: true } : {}),
  };
}

function clientRefs(round: NativeToolLedgerRound): Extract<NativeToolLedgerBlock, { kind: "client_tool_ref" }>[] {
  return round.blocks.filter((block): block is Extract<NativeToolLedgerBlock, { kind: "client_tool_ref" }> => (
    block.kind === "client_tool_ref"
  ));
}

function locateMixedRound(
  messages: JsonValue[],
  start: number,
  end: number,
  round: NativeToolLedgerRound,
): MixedRoundPosition {
  const refs = clientRefs(round);
  for (let index = start; index < end; index += 1) {
    const message = record(messages[index]!);
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const calls = new Map(message.content.map(toolUse).filter((value): value is { id: string; name: string } => !!value)
      .map((value) => [value.id, value.name]));
    if (!refs.every((ref) => calls.get(ref.callId) === ref.toolName)) continue;

    let resultIndex = -1;
    for (let candidate = index + 1; candidate < end; candidate += 1) {
      const resultMessage = record(messages[candidate]!);
      if (resultMessage.role === "assistant") break;
      if (!Array.isArray(resultMessage.content)) continue;
      const ids = new Set(resultMessage.content.map(toolResult).filter((value): value is { id: string } => !!value)
        .map((value) => value.id));
      if (refs.every((ref) => ids.has(ref.callId))) {
        resultIndex = candidate;
        break;
      }
    }
    if (resultIndex < 0) {
      throw new NativeToolLedgerConflictError(`Client Tool Result is missing for round ${round.round}`);
    }
    return { round: round.round, assistantIndex: index, resultIndex };
  }
  throw new NativeToolLedgerConflictError(`Client Tool Call is missing for round ${round.round}`);
}

function fillMixedRound(messages: JsonValue[], position: MixedRoundPosition, round: NativeToolLedgerRound): void {
  // Claude Code 已保存 Client Tool；这里只按原 blockIndex 补回隐藏块，避免复制一份客户端已有调用。
  const visibleBlocks = blocksAt(messages, position.assistantIndex);
  const existingIds = new Set(visibleBlocks.map(toolUse).filter((value): value is { id: string; name: string } => !!value)
    .map((value) => value.id));
  const insertions = round.blocks
    .filter((block) => block.kind !== "client_tool_ref")
    .sort((left, right) => left.blockIndex - right.blockIndex);
  for (const block of insertions) {
    if (block.kind === "native_tool" && existingIds.has(block.callId)) {
      throw new NativeToolLedgerConflictError(`Native Tool Call is duplicated: ${block.callId}`);
    }
    const value = assistantBlock(block);
    if (value === null || block.blockIndex < 0 || block.blockIndex > visibleBlocks.length) {
      throw new NativeToolLedgerConflictError(`Assistant block position is invalid for round ${round.round}`);
    }
    visibleBlocks.splice(block.blockIndex, 0, value);
  }
  record(messages[position.assistantIndex]!).content = visibleBlocks;

  const resultBlocks = blocksAt(messages, position.resultIndex);
  const existingResults = new Map<string, JsonValue>();
  let firstResult = -1;
  for (const [index, block] of resultBlocks.entries()) {
    const result = toolResult(block);
    if (!result) continue;
    if (existingResults.has(result.id)) {
      throw new NativeToolLedgerConflictError(`Tool Result is duplicated: ${result.id}`);
    }
    if (firstResult < 0) firstResult = index;
    existingResults.set(result.id, block);
  }
  const orderedResults = round.blocks
    .filter((block) => block.kind === "native_tool" || block.kind === "client_tool_ref")
    .sort((left, right) => left.blockIndex - right.blockIndex)
    .map((block) => {
      if (block.kind === "native_tool") return nativeResult(round, block.callId);
      const result = existingResults.get(block.callId);
      if (!result) throw new NativeToolLedgerConflictError(`Client Tool Result is missing for ${block.callId}`);
      return result;
    });
  const nonResults = resultBlocks.filter((block) => !toolResult(block));
  const beforeCount = resultBlocks.slice(0, firstResult).filter((block) => !toolResult(block)).length;
  record(messages[position.resultIndex]!).content = [
    ...nonResults.slice(0, beforeCount),
    ...orderedResults,
    ...nonResults.slice(beforeCount),
  ];
}

function pureRoundMessages(round: NativeToolLedgerRound): JsonValue[] {
  const assistantContent = round.blocks
    .slice()
    .sort((left, right) => left.blockIndex - right.blockIndex)
    .map(assistantBlock);
  if (assistantContent.some((block) => block === null)) {
    throw new NativeToolLedgerConflictError(`Pure Native round ${round.round} contains a Client Tool reference`);
  }
  const results = round.blocks
    .filter((block) => block.kind === "native_tool")
    .sort((left, right) => left.blockIndex - right.blockIndex)
    .map((block) => nativeResult(round, block.callId));
  return [
    { role: "assistant", content: assistantContent as JsonValue[] },
    { role: "user", content: results },
  ];
}

/**
 * Claude Code 保留可见消息，本函数只把它看不到的 Native 内容插回原轮次。
 * 不读取文本含义，也不根据 reminder 或摘要提示猜测消息类型。
 */
export function reconstructAnthropicToolLedger(input: {
  messages: readonly JsonValue[];
  turns: readonly TurnPosition[];
  rounds: readonly NativeToolLedgerRound[];
}): JsonValue[] {
  const messages = structuredClone([...input.messages]);
  const turns = [...input.turns].sort((left, right) => left.insertAfterItem - right.insertAfterItem);

  // 从后往前处理，避免前一轮插入消息后改变后一轮已经确定的位置。
  for (let turnPosition = turns.length - 1; turnPosition >= 0; turnPosition -= 1) {
    const turn = turns[turnPosition]!;
    const start = turn.insertAfterItem;
    const next = turns[turnPosition + 1];
    const end = next ? Math.max(start, next.insertAfterItem - 1) : messages.length;
    const rounds = input.rounds
      .filter((round) => round.turnSeq === turn.turnSeq)
      .sort((left, right) => left.round - right.round);
    if (rounds.length === 0) continue;

    const mixed = rounds.filter((round) => clientRefs(round).length > 0);
    const positions = mixed.map((round) => locateMixedRound(messages, start, end, round));
    for (const round of mixed) {
      fillMixedRound(messages, positions.find((position) => position.round === round.round)!, round);
    }

    const pure = rounds.filter((round) => clientRefs(round).length === 0);
    const insertions = new Map<number, NativeToolLedgerRound[]>();
    for (const round of pure) {
      const nextMixed = positions.find((position) => position.round > round.round);
      let insertionIndex: number;
      if (nextMixed) insertionIndex = nextMixed.assistantIndex;
      else {
        const previousMixed = positions.filter((position) => position.round < round.round).at(-1);
        const searchStart = previousMixed ? previousMixed.resultIndex + 1 : start;
        insertionIndex = end;
        for (let index = searchStart; index < end; index += 1) {
          if (record(messages[index]!).role === "assistant") {
            insertionIndex = index;
            break;
          }
        }
      }
      const grouped = insertions.get(insertionIndex) ?? [];
      grouped.push(round);
      insertions.set(insertionIndex, grouped);
    }
    for (const [index, grouped] of [...insertions.entries()].sort((left, right) => right[0] - left[0])) {
      const additions = grouped.sort((left, right) => left.round - right.round).flatMap(pureRoundMessages);
      messages.splice(index, 0, ...additions);
    }
  }
  return messages;
}

/** 从 Hook 记录取得真实 Turn，再恢复当前 Epoch 的 Claude Code 历史。 */
export async function materializeClaudeToolLedgerHistory(input: {
  messages: readonly JsonValue[];
  scope: import("./types.js").NativeToolSessionScope;
  storage: NativeToolLedgerStorageAdapter;
}): Promise<{
  messages: JsonValue[];
  turnSeq: number;
  currentEpoch: number;
  ledgerIds: string[];
}> {
  // 标记位置和历史插入必须基于同一份消息，否则 Claude Code 临时加入的
  // system 消息被协议适配器删掉后，旧工具记录会错插到下一轮用户问题之后。
  const extracted = extractClaudeTurnMarkers(input.messages);
  const context = await input.storage.getSessionContext(input.scope);
  if (context.compactStateError) {
    throw new NativeToolLedgerConflictError("Claude Code compact Hook state is incomplete");
  }

  const turns: TurnPosition[] = [];
  const seenTurns = new Set<number>();
  for (const marker of extracted.markers) {
    const turn = await input.storage.findTurnByToken(input.scope, marker.token);
    // 新 Session 可能携带父 Session 的标记；删除标记，但绝不读取父 Session 历史。
    if (!turn) continue;
    if (seenTurns.has(turn.turnSeq)) {
      throw new NativeToolLedgerConflictError(`Claude turn marker is duplicated for turn ${turn.turnSeq}`);
    }
    seenTurns.add(turn.turnSeq);
    turns.push({ turnSeq: turn.turnSeq, insertAfterItem: marker.insertAfterItem });
  }

  const latestVisibleTurn = turns.reduce((max, turn) => Math.max(max, turn.turnSeq), 0);
  if (context.currentTurnSeq > latestVisibleTurn) {
    throw new NativeToolLedgerConflictError("The latest UserPromptSubmit marker is missing");
  }

  // PostCompact 只推进 Epoch；查询当前 Epoch 即可让已进入摘要的旧记录停止参与后续恢复。
  const rounds = await input.storage.findRounds(input.scope, context.currentEpoch);
  for (const round of rounds) {
    if (!seenTurns.has(round.turnSeq)) {
      throw new NativeToolLedgerConflictError(`Claude history no longer contains turn ${round.turnSeq}`);
    }
  }

  return {
    messages: reconstructAnthropicToolLedger({ messages: extracted.messages, turns, rounds }),
    turnSeq: latestVisibleTurn,
    currentEpoch: context.currentEpoch,
    ledgerIds: rounds.map((round) => round.ledgerId),
  };
}
