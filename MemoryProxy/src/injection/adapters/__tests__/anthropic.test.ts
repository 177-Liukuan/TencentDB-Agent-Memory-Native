import { describe, expect, it } from "vitest";

import type { AgentContextMetadata } from "../../types.js";
import { AnthropicAdapter } from "../anthropic.js";

const metadata: AgentContextMetadata = {
  protocol: "anthropic",
  traceId: "test-trace",
  keyId: "test-key",
  modelId: "test-model",
  stream: false,
  agentSource: "claude-code",
};

describe("AnthropicAdapter tool round-trip", () => {
  it("preserves an Anthropic server tool without fabricating an input schema", () => {
    const webSearchTool = {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 5,
      allowed_domains: ["example.com"],
    };
    const body = {
      model: "test-model",
      messages: [{ role: "user", content: "Search the web" }],
      tools: [webSearchTool],
    };

    const serialized = new AnthropicAdapter().serialize(
      new AnthropicAdapter().parse(body, metadata),
    );

    expect(serialized.tools).toEqual([webSearchTool]);
  });

  it("keeps the canonical fields of a normal custom tool", () => {
    const customTool = {
      name: "get_weather",
      description: "Get current weather",
      input_schema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
      cache_control: { type: "ephemeral" },
    };
    const body = {
      model: "test-model",
      messages: [{ role: "user", content: "Weather" }],
      tools: [customTool],
    };

    const serialized = new AnthropicAdapter().serialize(
      new AnthropicAdapter().parse(body, metadata),
    );

    expect(serialized.tools).toEqual([customTool]);
  });
});
