import os from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import {
  __resetInjectionPipelineForTests,
  getInjectionPipeline,
} from "../index.js";

describe("injection proxy base URL fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __resetInjectionPipelineForTests();
  });

  it("keeps an explicitly loopback-bound proxy reachable from local curl tools", async () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      eth0: [{
        address: "172.31.220.70",
        netmask: "255.255.240.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "172.31.220.70/20",
      }],
    });

    const config = structuredClone(DEFAULT_CONFIG);
    config.server = { ...config.server, host: "127.0.0.1", port: 18096 };
    config.injection = {
      ...config.injection,
      enabled: true,
      injectors: ["skill"],
      externalGatewayUrl: undefined,
    };
    const result = await getInjectionPipeline(config).process(
      {
        model: "test-model",
        system: "base system prompt",
        messages: [{ role: "user", content: "recall my history" }],
      },
      {
        protocol: "anthropic",
        traceId: "trace-loopback-fallback",
        keyId: "test-key",
        modelId: "test-model",
        stream: false,
        agentSource: "claude-code",
      },
    );

    const systemText = Array.isArray(result.system)
      ? result.system
        .map((block) => (block as { text?: string }).text ?? "")
        .join("\n")
      : String(result.system);

    expect(systemText).toContain(
      "http://127.0.0.1:18096/skill-bridge/v3/skill/search",
    );
    expect(systemText).not.toContain("172.31.220.70:18096");
  });
});
