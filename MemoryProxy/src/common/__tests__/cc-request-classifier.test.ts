import { describe, expect, it } from "vitest";

import { classifyCcRequest } from "../cc-request-classifier.js";

describe("Claude Code request classifier", () => {
  it("treats the internal WebSearch provider request as a side query", () => {
    expect(classifyCcRequest({
      model: "deepseek-v4-flash",
      stream: true,
      system: "You are an assistant for performing a web search tool use",
      messages: [{ role: "user", content: "Perform a web search for the query: Shenzhen weather" }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      tool_choice: { type: "auto" },
    })).toBe("sidequery");
  });

  it("keeps the client-visible WebSearch tool in a cached main request", () => {
    expect(classifyCcRequest({
      messages: [{
        role: "user",
        content: [{ type: "text", text: "Search Shenzhen weather", cache_control: { type: "ephemeral" } }],
      }],
      tools: [{
        name: "WebSearch",
        description: "Search the web",
        input_schema: { type: "object", properties: { query: { type: "string" } } },
      }],
      thinking: { type: "adaptive" },
    })).toBe("main");
  });
});
