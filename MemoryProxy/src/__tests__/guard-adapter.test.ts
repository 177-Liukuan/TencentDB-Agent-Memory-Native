import { describe, expect, it } from "vitest";

import { joinUrl } from "../guard-adapter.js";

describe("joinUrl", () => {
  it("does not append the Responses endpoint twice when the configured base is already complete", () => {
    expect(joinUrl("https://api.deepseek.com/v1/responses", "/claude-code/v1/messages"))
      .toBe("https://api.deepseek.com/v1/responses");
  });

  it("maps an Anthropic client path to Responses when the caller selects a Responses request path", () => {
    expect(joinUrl("https://api.deepseek.com/v1", "/responses"))
      .toBe("https://api.deepseek.com/v1/responses");
  });
});
