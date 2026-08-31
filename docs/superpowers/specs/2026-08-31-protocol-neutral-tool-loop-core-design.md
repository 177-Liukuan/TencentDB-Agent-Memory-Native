# Protocol-neutral Tool Loop Core Design

## Goal

Reduce behavioral duplication between Anthropic Messages, OpenAI-compatible
Chat Completions, and OpenAI Responses without sacrificing lossless protocol
handling.

## Boundary

The shared core owns behavior that must remain identical across protocols:

- Native call limits;
- conversion from completed unified calls to durable ordered slots;
- durable batch creation and stream-snapshot CAS updates;
- Native execution lease claims and result persistence;
- Client dispatch transitions;
- final-observation preparation;
- interrupted-stream abort transitions; and
- replay-safe response snapshot persistence.

Protocol coordinators continue to own behavior that is inherently wire
specific:

- SSE framing and terminal-event detection;
- the moment at which a call is complete enough to execute;
- assistant skeleton reconstruction;
- Tool Result message encoding;
- client-visible SSE reconstruction; and
- protocol-specific error envelopes.

## Architecture

`ToolLoopExecutionCore` is a protocol-neutral service constructed from the
existing storage adapter, dispatcher, registry-independent limits, clock, and
ID generator. Both `AnthropicToolLoopCoordinator` and
`OpenAIToolLoopCoordinator` delegate durable execution/state transitions to
this service. `ResponsesToolLoopCoordinator` continues to provide a Responses
codec to `OpenAIToolLoopCoordinator`, and therefore uses the same core.

The core accepts already-normalized `UnifiedToolCall` values and opaque
`JsonValue[]` assistant skeletons. It never parses or serializes a model
protocol.

## Persistence

The existing `ToolExecutionContext` remains the durable format. Slots and
state-machine fields stay protocol neutral, while `protocol`,
`assistantSkeleton`, and `upstreamSnapshot` retain the protocol-native
envelope required for exact replay. No ClickHouse schema migration is needed.

## Compatibility

The refactor must preserve:

- Anthropic execution immediately after a Native call becomes complete;
- conservative Chat Completions execution at the round boundary;
- Responses execution after its single-call completion signal;
- Client-only and mixed Client/Native dispatch behavior;
- retry, lease, TTL, loop-limit, interruption, and zero-leak behavior; and
- existing public coordinator constructor and decision types.

## Verification

A new core contract suite covers limits, batch persistence, CAS snapshot
updates, single-lease execution, error-result mapping, Client dispatch,
observation idempotency, and abort behavior. Existing protocol coordinator,
HTTP integration, resume, persistence, and compression suites remain the
behavioral regression oracle. Final verification enables the real ClickHouse
integration suite so no environment-gated tests are skipped.
