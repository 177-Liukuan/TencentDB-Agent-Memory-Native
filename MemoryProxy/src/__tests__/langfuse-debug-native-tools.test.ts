import { describe, expect, it } from "vitest";

import { buildRequestDebugMetadata } from "../common/langfuse-debug.js";

describe("Langfuse debug Native Tool redaction", () => {
  it("omits Proxy-owned definitions while retaining Client Tool fingerprints", () => {
    const metadata = buildRequestDebugMetadata({
      debug: true,
      body: {
        tools: [
          {
            name: "client_shell",
            description: "Run a client command",
          },
          {
            name: "tdai_memory_search",
            description: "internal Native Registry description",
          },
        ],
      },
      hiddenToolNames: ["tdai_memory_search"],
    });

    expect(metadata).toMatchObject({
      tools_len: 1,
      tools_summary: [{ name: "client_shell", desc: "Run a client command" }],
    });
    expect(JSON.stringify(metadata)).not.toContain("tdai_memory_search");
    expect(JSON.stringify(metadata)).not.toContain("internal Native Registry description");
  });
});
