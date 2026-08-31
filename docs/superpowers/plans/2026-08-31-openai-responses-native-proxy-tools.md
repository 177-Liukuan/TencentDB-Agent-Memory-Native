# OpenAI Responses Native Proxy Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline. Subagents are prohibited by the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable, zero-leak Native Proxy Tool closed loop for OpenAI Responses and enable it on Codex and WorkBuddy HTTP SSE routes.

**Architecture:** Reuse the existing protocol-neutral execution and storage services. Add a Responses request adapter, stream parser, response rebuilder, and coordinator, then extend exact-target re-entry, client-result resume, compression, and the two client handlers.

**Tech Stack:** TypeScript, Hono, Web Streams/SSE, Vitest, ClickHouse storage adapter.

**Spec:** `docs/superpowers/specs/2026-08-31-openai-responses-native-proxy-tools-design.md`

## Global Constraints

- No Knowledge Tool implementation.
- No Realtime/WebSocket Native Tool loop.
- No Fake Tool or curl fallback.
- Provider tool items must not enter Proxy/Client slots.
- Reuse exact successful upstream target and trusted identity.
- Perform one final git commit only.

---

### Task 1: Responses request and stream codecs

**Files:**
- Create: `MemoryProxy/src/injection/adapters/responses.ts`
- Create: `MemoryProxy/src/injection/adapters/responses-stream.ts`
- Modify: `MemoryProxy/src/injection/types.ts`
- Modify: `MemoryProxy/src/injection/index.ts`
- Modify: `MemoryProxy/src/native-proxy-tools/native-proxy-tools-injector.ts`
- Test: `MemoryProxy/src/injection/adapters/__tests__/responses.test.ts`
- Test: `MemoryProxy/src/injection/adapters/__tests__/responses-stream.test.ts`

**Interfaces:**
- Produces `ResponsesAdapter`, `ResponsesStreamParser`, and `ResponsesStreamSnapshot`.
- Emits existing `ProtocolStreamEvent` and `UnifiedToolCall` types.

- [x] Write failing adapter tests for `input[]`, `instructions`, flat tools, unknown-item preservation, and name collision.
- [x] Run the focused tests and confirm missing adapter failures.
- [x] Implement the minimal request adapter and register protocol `responses`.
- [x] Write failing parser tests for delta/done, fallback completion, interleaving, provider items, and interrupted SSE.
- [x] Run the parser tests and confirm missing parser failures.
- [x] Implement the incremental parser and make focused tests pass.

### Task 2: Responses visibility and hidden history

**Files:**
- Create: `MemoryProxy/src/native-proxy-tools/responses-response-rebuilder.ts`
- Test: `MemoryProxy/src/native-proxy-tools/__tests__/responses-response-rebuilder.test.ts`

**Interfaces:**
- Produces `buildResponsesToolInputItems(slots)` and `buildClientVisibleResponsesSse(rawBytes, proxyOutputIndexes)`.

- [x] Write failing tests for hidden function calls/results, mixed event filtering, output-index remapping, final-output filtering, provider preservation, and leak markers.
- [x] Run and confirm expected failures.
- [x] Implement the rebuilder and make focused tests pass.

### Task 3: Durable Responses Tool Loop

**Files:**
- Create: `MemoryProxy/src/native-proxy-tools/responses-tool-loop-coordinator.ts`
- Modify: `MemoryProxy/src/native-proxy-tools/types.ts`
- Modify: `MemoryProxy/src/native-proxy-tools/exact-target-transport.ts`
- Test: `MemoryProxy/src/native-proxy-tools/__tests__/responses-tool-loop-coordinator.test.ts`
- Test: `MemoryProxy/src/native-proxy-tools/__tests__/exact-target-transport.test.ts`

**Interfaces:**
- Produces `ResponsesToolLoopCoordinator` with the same decision contract as the Chat Completions coordinator.
- Exact transport serializes `baseMessages` as `input` when snapshot protocol is `responses`.

- [x] Write failing tests for pure Native, pure Client, mixed interleaving, early read execution, write deferral, limits, errors, interruption, and zero leakage.
- [x] Run and confirm expected failures.
- [x] Extend persisted protocol types and exact-target request building.
- [x] Implement the coordinator and make focused tests pass.

### Task 4: Client resume and context compression

**Files:**
- Modify: `MemoryProxy/src/native-proxy-tools/client-tool-resume.ts`
- Modify: `MemoryProxy/src/native-proxy-tools/context-compression.ts`
- Test: `MemoryProxy/src/native-proxy-tools/__tests__/client-tool-resume.test.ts`
- Test: `MemoryProxy/src/native-proxy-tools/__tests__/context-compression.test.ts`

**Interfaces:**
- Responses client results are `input[]` items with `type=function_call_output` and `call_id`.
- Responses hidden history is a sequence of output items followed by function-call outputs.

- [x] Write failing tests for result extraction, duplicate/unknown IDs, replay, restart, and Responses compression.
- [x] Run and confirm expected failures.
- [x] Implement protocol-specific skeleton validation, result messages, and compression reconstruction.
- [x] Run focused tests until green.

### Task 5: Codex and WorkBuddy HTTP integration

**Files:**
- Modify: `MemoryProxy/src/codexHandler.ts`
- Modify: `MemoryProxy/src/workbuddyHandler.ts`
- Create: `MemoryProxy/src/native-proxy-tools/responses-handler-runtime.ts`
- Test: `MemoryProxy/src/__tests__/responses-native-proxy-tool.integration.test.ts`

**Interfaces:**
- Shared handler runtime receives prepared request identity, exact target, headers, body, and upstream response.
- Client handlers retain their existing session, auxiliary, and telemetry hooks.

- [x] Write failing integration tests for flat schema injection, internal re-entry, mixed client resume, auxiliary pass-through, and both routes.
- [x] Run and confirm expected failures.
- [x] Connect direct Responses injection and the shared runtime to both handlers.
- [x] Make the integration tests pass without changing auxiliary behavior.

### Task 6: Full verification and one commit

**Files:**
- Modify: `INSTALL_CN.md` only if the verified support matrix needs clarification.

- [x] Run all Responses-focused white-box tests.
- [x] Run the HTTP black-box test suite against a fake Responses upstream.
- [x] Run `npm test` and confirm zero failures.
- [x] Run `npm run typecheck` and confirm exit code zero.
- [x] Inspect `git diff --check`, status, and the complete diff.
- [x] Create one final commit containing design, implementation, tests, and any documentation correction.
