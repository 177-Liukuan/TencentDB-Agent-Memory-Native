import { describe, expect, it } from "vitest";

import {
  createClaudeTurnMarker,
  extractClaudeTurnMarkers,
} from "../turn-marker.js";

describe("Claude Code turn marker", () => {
  it("removes only the private marker and keeps the user prompt and reminder unchanged", () => {
    const marker = createClaudeTurnMarker("018f0b9e-7d31-7a62-8ad8-a2676d86e201");
    const input = [
      {
        role: "user",
        content: [
          { type: "text", text: "检查当前项目" },
          { type: "text", text: "<system-reminder>keep this</system-reminder>" },
          { type: "text", text: marker },
        ],
      },
    ];

    const result = extractClaudeTurnMarkers(input);

    expect(result.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "检查当前项目" },
          { type: "text", text: "<system-reminder>keep this</system-reminder>" },
        ],
      },
    ]);
    expect(result.markers).toEqual([
      { token: "018f0b9e-7d31-7a62-8ad8-a2676d86e201", insertAfterItem: 1 },
    ]);
  });

  it("removes a marker-only user message and retains its insertion boundary", () => {
    const marker = createClaudeTurnMarker("018f0b9e-7d31-7a62-8ad8-a2676d86e202");
    const result = extractClaudeTurnMarkers([
      { role: "user", content: "第一轮" },
      { role: "assistant", content: [{ type: "text", text: "回答" }] },
      { role: "user", content: marker },
      { role: "user", content: "第二轮" },
    ]);

    expect(result.messages).toEqual([
      { role: "user", content: "第一轮" },
      { role: "assistant", content: [{ type: "text", text: "回答" }] },
      { role: "user", content: "第二轮" },
    ]);
    expect(result.markers).toEqual([
      { token: "018f0b9e-7d31-7a62-8ad8-a2676d86e202", insertAfterItem: 2 },
    ]);
  });

  it("does not treat user-authored lookalike text as a marker", () => {
    const input = [{ role: "user", content: "示例：<tdai-native-turn token=\"not-a-token\"/>" }];

    expect(extractClaudeTurnMarkers(input)).toEqual({ messages: input, markers: [] });
  });
});
