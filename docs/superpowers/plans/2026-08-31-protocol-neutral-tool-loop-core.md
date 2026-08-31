# Protocol-neutral Tool Loop Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses share one protocol-neutral durable Tool Loop execution core.

**Architecture:** Extract state transitions and Native execution from the two protocol coordinators into `ToolLoopExecutionCore`. Keep parsing, completion timing, message reconstruction, and error envelopes in protocol-specific coordinators/codecs.

**Tech Stack:** TypeScript 5.8, Vitest 3, Web Streams, ClickHouse storage adapter.

**Spec:** `docs/superpowers/specs/2026-08-31-protocol-neutral-tool-loop-core-design.md`

## Global Constraints

- Preserve all existing external HTTP and SSE behavior.
- Preserve protocol-native snapshots for lossless replay.
- Do not change the ClickHouse schema.
- Do not use subagents.
- Create one implementation commit only after all verification passes.

---

### Task 1: Define the shared execution-core contract

**Files:**
- Create: `MemoryProxy/src/native-proxy-tools/tool-loop-execution-core.ts`
- Create: `MemoryProxy/src/native-proxy-tools/__tests__/tool-loop-execution-core.test.ts`

**Interfaces:**
- Consumes: `UnifiedToolCall`, `ToolExecutionStorageAdapter`, `NativeProxyToolDispatcher`, `NativeProxyToolsConfig`, and existing durable state types.
- Produces: `ToolLoopExecutionCore`, `ToolLoopCoreFailure`, `ToolLoopBatchInput`, `ToolLoopSnapshotInput`, `slotsFromUnifiedCalls`, and `persistToolLoopResponse`.

- [x] **Step 1: Write a failing contract test**

```ts
const core = new ToolLoopExecutionCore({ storage, dispatcher, limits, now, createId });
expect(core.limitFailure({ round: 1, totalCalls: 0, callsThisRound: 1 })).toBeNull();
await core.createBatch({ protocol: "anthropic", input, calls, assistantSkeleton, responseStreamStatus: "streaming" });
expect((await storage.findActiveBySession(scope))[0]?.slots).toHaveLength(1);
```

- [x] **Step 2: Verify RED**

Run: `npx vitest run src/native-proxy-tools/__tests__/tool-loop-execution-core.test.ts`

Expected: fail because `tool-loop-execution-core.ts` does not exist.

- [x] **Step 3: Implement the minimal core**

Implement explicit methods for limit checks, slot construction, batch
creation, stream persistence, execution/lease persistence, Client dispatch,
observation preparation, abort, and replay-safe response snapshot creation.
Use the existing eight-attempt CAS default and `nativeToolLeaseDurationMs`.

- [x] **Step 4: Verify GREEN**

Run: `npx vitest run src/native-proxy-tools/__tests__/tool-loop-execution-core.test.ts`

Expected: all execution-core tests pass.

### Task 2: Migrate Anthropic to the shared core

**Files:**
- Modify: `MemoryProxy/src/native-proxy-tools/tool-loop-coordinator.ts`
- Test: `MemoryProxy/src/native-proxy-tools/__tests__/tool-loop-coordinator.test.ts`

**Interfaces:**
- Consumes: `ToolLoopExecutionCore` methods from Task 1.
- Produces: the unchanged `AnthropicToolLoopCoordinator` public API.

- [x] **Step 1: Delegate protocol-neutral behavior**

Construct one core in the coordinator and replace its limit, batch, snapshot,
execution, dispatch, observation, abort, and response-persistence helpers.
Keep the Anthropic frame feeder, immediate execution scheduling, response
rebuilder, and error decision local.

- [x] **Step 2: Verify behavior remains GREEN**

Run: `npx vitest run src/native-proxy-tools/__tests__/tool-loop-coordinator.test.ts src/native-proxy-tools/__tests__/tool-loop-execution-core.test.ts`

Expected: both suites pass.

### Task 3: Migrate Chat Completions and Responses to the shared core

**Files:**
- Modify: `MemoryProxy/src/native-proxy-tools/openai-tool-loop-coordinator.ts`
- Test: `MemoryProxy/src/native-proxy-tools/__tests__/openai-tool-loop-coordinator.test.ts`
- Test: `MemoryProxy/src/native-proxy-tools/__tests__/responses-tool-loop-coordinator.test.ts`

**Interfaces:**
- Consumes: the same `ToolLoopExecutionCore` used by Anthropic.
- Produces: unchanged OpenAI and Responses public coordinator APIs and codec behavior.

- [x] **Step 1: Delegate protocol-neutral behavior**

Use the core for both the default Chat Completions codec and the Responses
codec delegate. Keep protocol stream parsing, Responses early scheduling,
message building, client-visible rebuilding, and protocol error JSON local.

- [x] **Step 2: Verify behavior remains GREEN**

Run: `npx vitest run src/native-proxy-tools/__tests__/openai-tool-loop-coordinator.test.ts src/native-proxy-tools/__tests__/responses-tool-loop-coordinator.test.ts src/native-proxy-tools/__tests__/tool-loop-execution-core.test.ts`

Expected: all three suites pass.

### Task 4: Verify and commit the unified implementation

**Files:**
- Review all modified files.

**Interfaces:**
- Consumes: the completed shared core and protocol coordinators.
- Produces: one verified repository commit.

- [x] **Step 1: Run targeted protocol integration tests**

Run:

```bash
npx vitest run \
  src/__tests__/anthropic-native-proxy-tool.integration.test.ts \
  src/__tests__/responses-native-proxy-tool.integration.test.ts \
  src/native-proxy-tools/__tests__/openai-tool-loop-coordinator.test.ts \
  src/native-proxy-tools/__tests__/responses-tool-loop-coordinator.test.ts \
  src/native-proxy-tools/__tests__/tool-loop-coordinator.test.ts
```

Expected: all targeted tests pass.

- [x] **Step 2: Run type checking**

Run: `npm run typecheck`

Expected: TypeScript exits with status 0.

- [x] **Step 3: Run the complete suite with real ClickHouse enabled**

Set `NATIVE_TOOL_CLICKHOUSE_TEST=1` and the local ClickHouse URL/database/user/password, then run `npm test`.

Expected: every test passes and zero tests are skipped.

- [x] **Step 4: Review repository state**

Run: `git diff --check && git diff --stat && git status --short`.

Expected: only the shared-core implementation, tests, and design/plan documents are changed.

- [x] **Step 5: Commit once**

```bash
git add MemoryProxy/src/native-proxy-tools docs/superpowers
git commit -m "refactor(memory-proxy): unify native tool loop execution"
```
