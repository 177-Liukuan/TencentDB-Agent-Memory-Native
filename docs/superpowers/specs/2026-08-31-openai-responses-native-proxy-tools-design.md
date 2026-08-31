# OpenAI Responses Native Proxy Tool Design

## Scope

Add an OpenAI Responses protocol closed loop to the existing Native Proxy Tool runtime and connect it to the Codex and WorkBuddy HTTP SSE handlers. Reuse the existing Memory/Skill registry, dispatcher, identity injection, limits, ClickHouse storage, leases, result truncation, observation outbox, and exact-target policy. Knowledge tools and OpenAI Realtime/WebSocket remain out of scope.

## Protocol boundary

`responses` is a distinct protocol, not an alias for Chat Completions. A Responses adapter owns:

- request `input[]`, `instructions`, and flat function `tools[]` conversion;
- incremental `response.*` SSE parsing;
- native/client/provider ownership classification;
- client-visible SSE reconstruction;
- hidden `function_call` plus `function_call_output` replay for internal re-entry.

Only a `type=function_call` whose name was injected and is owned by the registry can be a Proxy Tool. Other function calls are Client Tools. Built-in/provider item types never enter Proxy/Client slots and are preserved byte-for-byte unless an enclosing final response must be rebuilt to remove Proxy items.

## Streaming state machine

Calls are keyed by `output_index`, `item_id`, and `call_id`. Arguments accumulate from `response.function_call_arguments.delta`. A call becomes complete at `response.function_call_arguments.done`, or conservatively at `response.output_item.done` when a compatible upstream omits the argument-done event. JSON parseability is never used as a completion signal.

Read-only Native calls are persisted and may start executing as soon as their call boundary is complete. Client calls are collected until `response.completed`. Write/archive Native calls wait for the complete response boundary. Interrupted, failed, or incomplete streams never execute an uncompleted call.

## Visibility and re-entry

Proxy-owned events and final `response.output[]` entries are removed from client-visible output. Client calls, text, reasoning, usage, unknown fields, and provider tool items are retained in order. Visible `output_index` values are compacted consistently. Native names, IDs, arguments, results, and errors are scanned before returning bytes.

Internal re-entry reuses the exact successful target and first-request tool definitions. It appends the hidden Responses `function_call` items and matching `function_call_output` items to the persisted base `input[]`; it does not rerun session initialization or injection.

## Durable state and resume

The persisted protocol discriminator gains `responses`. Existing `baseMessages` storage is interpreted as Responses `input[]` for this discriminator to avoid a ClickHouse schema rewrite. The raw assistant skeleton stores complete Responses output items. Client result resume extracts the latest `function_call_output` batch by `call_id`, validates duplicates/unknown IDs, persists results with CAS, waits for Native results, and re-enters exactly once. Context compression reconstructs hidden Responses items before `/responses/compact` and checkpoints only after success.

## Handler integration

Codex and WorkBuddy keep independent authentication, session IDs, auxiliary classification, Langfuse, and archive behavior. Their main streamed `/responses` requests run the Responses injection adapter and Tool Loop. Auxiliary endpoints, non-streaming requests, Realtime/WebSocket, untrusted sessions, and disabled Native configuration remain pass-through without Fake Tool fallback.

## Verification

White-box tests cover adapter round-trips, flat tool schemas, fragmented and interleaved SSE, completion fallbacks, provider pass-through, mixed calls, zero leakage, re-entry, duplicate/unknown client results, restart persistence, compression, limits, and interruption. Black-box tests start an HTTP MemoryProxy-compatible app with a fake Responses upstream and verify request injection, Native execution, hidden re-entry, client-visible SSE, mixed client dispatch/resume, and auxiliary pass-through for both Codex and WorkBuddy routes.
