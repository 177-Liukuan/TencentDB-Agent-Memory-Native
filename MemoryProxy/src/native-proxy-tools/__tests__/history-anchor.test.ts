import { describe, expect, it } from "vitest";

import {
  buildHistoryAnchors,
  createHistoryAnchor,
  createLogicalTurnId,
} from "../history-anchor.js";

describe("Native Tool history anchors", () => {
  it("ignores transport-only cache_control fields at every nesting level", () => {
    const original = [{
      role: "user",
      content: [{
        type: "text",
        text: "remember this",
        cache_control: { type: "ephemeral" },
      }],
      cache_control: { type: "ephemeral" },
    }];
    const retransmitted = [{ role: "user", content: [{ type: "text", text: "remember this" }] }];

    expect(createHistoryAnchor(original)).toEqual(createHistoryAnchor(retransmitted));
  });

  it("changes the digest when effective history content changes", () => {
    const before = createHistoryAnchor([{ role: "user", content: "question one" }]);
    const after = createHistoryAnchor([{ role: "user", content: "question two" }]);

    expect(before.itemCount).toBe(1);
    expect(after.itemCount).toBe(1);
    expect(before.prefixDigest).not.toBe(after.prefixDigest);
  });

  it("builds deterministic prefix anchors including the empty prefix", () => {
    const anchors = buildHistoryAnchors([
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ]);

    expect(anchors.map((anchor) => anchor.itemCount)).toEqual([0, 1, 2]);
    expect(anchors).toEqual(buildHistoryAnchors([
      { content: "one", role: "user" },
      { content: "two", role: "assistant" },
    ]));
  });

  it("derives the same logical turn id for a retried request", () => {
    const input = {
      scope: { spaceId: "s", userId: "u", agentSource: "claude-code", sessionId: "session" },
      clientProtocol: "anthropic" as const,
      anchor: createHistoryAnchor([{ role: "user", content: "question" }]),
      requestFingerprint: "request-digest",
    };

    expect(createLogicalTurnId(input)).toBe(createLogicalTurnId(structuredClone(input)));
  });
});
