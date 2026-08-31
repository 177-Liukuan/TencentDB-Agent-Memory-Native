# Anthropic Client / Responses Upstream Design

## Goal

Allow Claude Code to keep its Anthropic Messages contract while MemoryProxy sends the model request to an OpenAI Responses-compatible upstream. The first production target is DeepSeek `POST /responses`.

## Scope

- Add an opt-in per-agent upstream protocol: `upstream.agents.<agent>.protocol: responses`.
- Convert Anthropic Messages requests, tool definitions, tool calls, and tool results into Responses input items.
- Convert streamed and non-streamed Responses output back into valid Anthropic Messages responses.
- Reuse the existing Responses Native Proxy Tool coordinator, storage leases, result persistence, internal re-entry, limits, and leak checks.
- Preserve the existing Anthropic-to-Anthropic path as the default.
- Reject unsupported lossy cross-protocol constructs instead of silently dropping them.

OpenAI Responses built-in Provider Tools are outside this cross-protocol bridge. Claude Code client tools and Memory/Skill Native Proxy Tools are function tools and are supported.

## Configuration

`AgentUpstreamEntry` gains an optional `protocol` field:

```yaml
upstream:
  url: https://api.deepseek.com
  apiKey: ${DEEPSEEK_API_KEY}
  agents:
    claude-code:
      protocol: responses
```

The accepted values are `native` and `responses`. Missing or `native` preserves the current handler-native protocol. `responses` is accepted only for requests entering the Anthropic Messages handler. The Responses target URL is normalized to `/responses` rather than forwarding `/v1/messages`.
A protocol-only agent entry inherits the global URL and API key; an entry with its own URL retains the existing client-key-passthrough behavior when its API key is omitted.

## Architecture

### Request boundary

`AnthropicResponsesRequestConverter` receives the fully prepared, injected Anthropic body. It emits a Responses body:

- `system` becomes `instructions`.
- text/image messages become Responses message input items.
- assistant `tool_use` blocks become `function_call` items.
- user `tool_result` blocks become `function_call_output` items.
- Anthropic tools become Responses `function` tools (`input_schema` becomes `parameters`).
- `max_tokens` becomes `max_output_tokens` and Anthropic `tool_choice` is normalized.
- Anthropic-only cache markers and transport fields are removed.

Conversion runs after session init, injection, routing body overrides, and request preparation, so all existing Memory/Skill injection remains unchanged.

### Response boundary

`ResponsesAnthropicResponseBridge` incrementally parses semantic Responses SSE and emits Anthropic SSE:

- `response.created` emits `message_start`.
- output text and reasoning deltas create ordered Anthropic text/thinking blocks.
- `function_call` output creates `tool_use` blocks using Responses `call_id` as the Anthropic tool-use ID.
- the terminal Responses event emits any missing block stops, `message_delta`, and `message_stop`.
- failed/incomplete streams become Anthropic error events or matching stop reasons.

The bridge also converts non-streaming Responses JSON to an Anthropic message JSON object.

### Tool Loop

The persisted `UpstreamRequestSnapshot.protocol` remains the upstream wire protocol. Cross-protocol Claude Code rounds therefore store `responses`, Responses `input[]`, Responses tool definitions, and the exact `/responses` target. Existing client-result extraction already accepts Anthropic `tool_result` requests independently of persisted protocol, while persisted protocol selects the Responses skeleton and re-entry message builder.

`AnthropicClientResponsesToolLoop` wraps `ResponsesToolLoopCoordinator`. It converts every client-visible decision—including nested client-dispatch persistence callbacks—from Responses bytes to Anthropic bytes before returning or persisting it. Internal rounds remain Responses end-to-end.

### Headers and observability

Responses upstream authentication uses `Authorization: Bearer`, removes Anthropic-only headers, and preserves safe tracing headers. Client response headers remain SSE/JSON with the upstream request ID when present. Langfuse records the logical Anthropic client input and adds `upstream_protocol:responses` metadata/tags.

## Errors and safety

- Invalid configuration fails at startup.
- Unsupported request blocks return an Anthropic `400 invalid_request_error` before forwarding.
- Non-2xx Responses errors are converted to an Anthropic error envelope and never echo injected Native tool definitions.
- Unexpected EOF remains an error; a synthetic `message_stop` is not emitted for a truncated upstream stream.
- Native tool leak assertions run on the final Anthropic client bytes.
- Provider-only Responses output item types that cannot be represented in Anthropic are rejected explicitly.

## Testing

White-box tests cover configuration, request conversion, fragmented SSE, text, reasoning, multiple interleaved function calls, malformed events, non-streaming responses, headers, and terminal states.

Integration tests cover pure Client Tool, pure Native Tool, mixed Client/Native Tool, client result resume, exact Responses re-entry, duplicate/unknown call IDs, upstream error, and interruption.

The final black-box test starts the Native service with Claude Code configured as `protocol: responses`, sends an Anthropic `/v1/messages` request through MemoryProxy, and verifies DeepSeek `/responses` output is returned as Anthropic SSE. A forced Memory Native Tool call verifies bridge execution and internal re-entry when the live model reliably selects the tool; deterministic HTTP black-box fixtures cover the same closed loop regardless of model choice.
