# Anthropic Client / Responses Upstream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude Code speak Anthropic Messages to MemoryProxy while the proxy speaks OpenAI Responses to DeepSeek, including the durable Native/Client Tool loop.

**Architecture:** Add focused request/response protocol bridges at the Anthropic handler boundary and delegate upstream tool execution to the existing Responses coordinator. Persist `responses` as the upstream protocol so exact-target re-entry and restart recovery reuse the existing protocol-neutral state core without a schema migration.

**Tech Stack:** TypeScript, Hono, Web Streams, Vitest, ClickHouse integration tests, Docker Compose, DeepSeek Responses API

**Spec:** `docs/superpowers/specs/2026-08-31-anthropic-client-responses-upstream-design.md`

## Global Constraints

- Claude Code continues to receive valid Anthropic Messages JSON/SSE.
- Existing Anthropic-to-Anthropic behavior remains the default.
- Native Proxy Tool definitions, calls, arguments, and results never leak to Claude Code.
- Provider-only Responses tools are rejected when lossless Anthropic representation is impossible.
- No ClickHouse schema migration is introduced.
- Produce one final implementation commit, as requested by the user.

---

### Task 1: Configuration and request conversion

**Files:**
- Modify: `MemoryProxy/src/types.ts`
- Modify: `MemoryProxy/src/config.ts`
- Create: `MemoryProxy/src/protocol-bridge/anthropic-responses-request.ts`
- Test: `MemoryProxy/src/protocol-bridge/__tests__/anthropic-responses-request.test.ts`
- Test: `MemoryProxy/src/__tests__/config.test.ts`

**Interfaces:**
- Produces: `AgentUpstreamEntry.protocol?: "native" | "responses"`
- Produces: `convertAnthropicRequestToResponses(body): Record<string, unknown>`

- [ ] Write tests that parse `protocol: responses`, reject invalid values, and preserve the missing-field default.
- [ ] Run the focused tests and verify they fail because the configuration field is absent.
- [ ] Implement strict configuration parsing.
- [ ] Write request conversion tests for system text, text/image blocks, tool schemas, assistant tool calls, user tool results, model parameters, and unsupported blocks.
- [ ] Run the converter tests and verify they fail because the converter is absent.
- [ ] Implement the minimal lossless converter and run the focused tests to green.

### Task 2: Responses-to-Anthropic response bridge

**Files:**
- Create: `MemoryProxy/src/protocol-bridge/responses-anthropic-response.ts`
- Test: `MemoryProxy/src/protocol-bridge/__tests__/responses-anthropic-response.test.ts`

**Interfaces:**
- Produces: `createResponsesToAnthropicSseTransform(options): TransformStream<Uint8Array, Uint8Array>`
- Produces: `convertResponsesSseBytesToAnthropic(bytes, options): Uint8Array`
- Produces: `convertResponsesJsonToAnthropic(value): Record<string, unknown>`

- [ ] Write failing tests for message start, fragmented UTF-8/SSE, text/reasoning blocks, ordered/interleaved function calls, usage, stop reason, and failed/incomplete/unexpected-EOF streams.
- [ ] Implement an incremental semantic SSE decoder and Anthropic event encoder.
- [ ] Run the streaming tests to green.
- [ ] Write failing tests for non-streaming Responses message/function-call/error conversion.
- [ ] Implement JSON conversion and run all bridge tests to green.

### Task 3: Cross-protocol Tool Loop wrapper

**Files:**
- Create: `MemoryProxy/src/native-proxy-tools/anthropic-client-responses-tool-loop.ts`
- Test: `MemoryProxy/src/native-proxy-tools/__tests__/anthropic-client-responses-tool-loop.test.ts`
- Modify: `MemoryProxy/src/native-proxy-tools/exact-target-transport.ts`

**Interfaces:**
- Consumes: `ResponsesToolLoopCoordinator`, response bridge functions, and existing exact-target transport.
- Produces: a coordinator whose upstream rounds/snapshots use Responses while every returned or persisted response uses Anthropic bytes.

- [ ] Write a failing pure-Native test that executes, appends `function_call_output`, re-enters `/responses`, and returns Anthropic SSE without Native leakage.
- [ ] Write a failing mixed test that persists Anthropic client dispatch, accepts Anthropic `tool_result`, and resumes through Responses.
- [ ] Implement the wrapper, including conversion of nested `onClientDispatchPrepared` callbacks.
- [ ] Run focused Tool Loop, exact-target, and client-resume tests to green.

### Task 4: Anthropic handler integration

**Files:**
- Modify: `MemoryProxy/src/anthropicHandler.ts`
- Create/Modify: `MemoryProxy/src/__tests__/anthropic-responses-upstream.integration.test.ts`

**Interfaces:**
- Consumes: per-agent protocol selection, request converter, response bridge, and cross-protocol Tool Loop wrapper.
- Produces: `/claude-code/:spaceId/v1/messages` with an optional Responses upstream.

- [ ] Write a failing HTTP integration test asserting that an Anthropic request is forwarded to `/responses` with Responses JSON and returned as Anthropic SSE.
- [ ] Add failing cases for Client Tool, Native Tool, mixed Tool, non-streaming output, non-2xx error, and stream interruption.
- [ ] Integrate protocol selection after request preparation, normalize auth headers/target URL, and use the appropriate coordinator/response bridge.
- [ ] Run the integration suite and fix only failures caused by the new feature.

### Task 5: Documentation, real DeepSeek evaluation, and verification

**Files:**
- Modify: `MemoryProxy/config.example.yaml`
- Modify: `INSTALL_CN.md`
- Modify: `INSTALL.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Documents the exact production configuration and test commands.

- [ ] Document `upstream.agents.claude-code.protocol: responses`, endpoint normalization, limitations, and rollback.
- [ ] Run TypeScript type checking and the complete MemoryProxy Vitest suite.
- [ ] Run real ClickHouse integration tests without a skip flag while the project ClickHouse service is healthy.
- [ ] Rebuild and start the Native service with the DeepSeek Responses upstream.
- [ ] Send a real Anthropic streaming request through port 18096 and verify Anthropic SSE plus Langfuse protocol metadata.
- [ ] Review `git diff`, verify no secrets or unrelated changes are staged, and create one final commit.
