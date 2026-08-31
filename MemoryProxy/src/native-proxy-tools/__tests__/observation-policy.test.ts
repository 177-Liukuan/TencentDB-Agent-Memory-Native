import { describe, expect, it } from "vitest";

import { isLogicalFinalToolLoopDecision } from "../observation-policy.js";

describe("Native Tool observation policy", () => {
  it.each([
    ["replay", true],
    ["final", true],
    ["client_dispatch", false],
    ["error", false],
  ] as const)("treats %s logical-final=%s", (kind, expected) => {
    expect(isLogicalFinalToolLoopDecision(kind)).toBe(expected);
  });
});
