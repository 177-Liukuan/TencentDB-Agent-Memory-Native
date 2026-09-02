import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, buildConfig } from "../config.js";

const temporaryDirectories: string[] = [];

function buildConfigWithYaml(yaml: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), "native-proxy-tools-config-"));
  temporaryDirectories.push(directory);
  const configFile = join(directory, "config.yaml");
  writeFileSync(configFile, JSON.stringify(yaml), "utf8");
  return buildConfig({ configFile });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Native Proxy Tool configuration", () => {
  it("loads a Responses wire protocol for the Claude Code upstream", () => {
    const config = buildConfigWithYaml({
      upstream: {
        agents: {
          "claude-code": {
            url: "https://api.deepseek.com",
            apiKey: "server-key",
            protocol: "responses",
          },
        },
      },
    });

    expect(config.upstream.agents["claude-code"]).toEqual({
      url: "https://api.deepseek.com",
      apiKey: "server-key",
      protocol: "responses",
    });
  });

  it("retains a protocol-only agent entry so it can inherit the global upstream", () => {
    const config = buildConfigWithYaml({
      upstream: {
        url: "https://api.deepseek.com",
        apiKey: "server-key",
        agents: { "claude-code": { protocol: "responses" } },
      },
    });

    expect(config.upstream.agents["claude-code"]).toEqual({ protocol: "responses" });
  });

  it("rejects an unknown per-agent upstream protocol", () => {
    expect(() => buildConfigWithYaml({
      upstream: {
        agents: {
          "claude-code": {
            url: "https://api.deepseek.com",
            protocol: "chat_completions",
          },
        },
      },
    })).toThrow(/upstream\.agents\.claude-code\.protocol/);
  });

  it("defaults to a disabled, bounded ClickHouse state backend", () => {
    expect(DEFAULT_CONFIG.nativeProxyTools).toEqual({
      enabled: false,
      maxRounds: 5,
      maxCallsPerRound: 8,
      maxTotalCalls: 20,
      toolTimeoutMs: 20_000,
      maxResultBytes: 65_536,
      stateTtlSeconds: 1_800,
      stateStorage: {
        backend: "clickhouse",
        table: "native_proxy_tool_execution_state",
      },
      historyStorage: {
        backend: "clickhouse",
        table: "native_proxy_tool_history",
        checkpointTable: "native_proxy_tool_context_checkpoint",
        ttlDays: 30,
      },
    });
  });

  it("loads a valid Native Proxy Tool section without duplicating ClickHouse credentials", () => {
    const config = buildConfigWithYaml({
      clickhouse: {
        url: "http://clickhouse.internal:8123",
        database: "proxy_state",
        user: "proxy",
        password: "secret",
      },
      nativeProxyTools: {
        enabled: true,
        maxRounds: 4,
        maxCallsPerRound: 3,
        maxTotalCalls: 12,
        toolTimeoutMs: 7_500,
        maxResultBytes: 32_768,
        stateTtlSeconds: 3_600,
        stateStorage: {
          backend: "clickhouse",
          table: "tool_state_v1",
        },
        historyStorage: {
          backend: "clickhouse",
          table: "tool_history_v1",
          checkpointTable: "tool_checkpoint_v1",
          ttlDays: 45,
        },
      },
    });

    expect(config.nativeProxyTools).toEqual({
      enabled: true,
      maxRounds: 4,
      maxCallsPerRound: 3,
      maxTotalCalls: 12,
      toolTimeoutMs: 7_500,
      maxResultBytes: 32_768,
      stateTtlSeconds: 3_600,
      stateStorage: {
        backend: "clickhouse",
        table: "tool_state_v1",
      },
      historyStorage: {
        backend: "clickhouse",
        table: "tool_history_v1",
        checkpointTable: "tool_checkpoint_v1",
        ttlDays: 45,
      },
    });
    expect(config.clickhouse).toMatchObject({
      url: "http://clickhouse.internal:8123",
      database: "proxy_state",
      user: "proxy",
      password: "secret",
    });
  });

  it.each([
    [{ maxRounds: 0 }, "nativeProxyTools.maxRounds"],
    [{ maxCallsPerRound: 65 }, "nativeProxyTools.maxCallsPerRound"],
    [{ maxTotalCalls: 257 }, "nativeProxyTools.maxTotalCalls"],
    [{ toolTimeoutMs: 99 }, "nativeProxyTools.toolTimeoutMs"],
    [{ maxResultBytes: 1_048_577 }, "nativeProxyTools.maxResultBytes"],
    [{ stateTtlSeconds: 59 }, "nativeProxyTools.stateTtlSeconds"],
  ])("rejects an out-of-range value at its configuration path", (nativeProxyTools, path) => {
    expect(() => buildConfigWithYaml({ nativeProxyTools })).toThrow(path);
  });

  it("rejects a total call limit smaller than the per-round limit", () => {
    expect(() => buildConfigWithYaml({
      nativeProxyTools: {
        maxCallsPerRound: 9,
        maxTotalCalls: 8,
      },
    })).toThrow(/nativeProxyTools\.maxTotalCalls.*maxCallsPerRound/);
  });

  it.each(["state; DROP TABLE x", "db.state", "1state", "state-name"])(
    "rejects unsafe state table identifier %s",
    (table) => {
      expect(() => buildConfigWithYaml({
        nativeProxyTools: {
          stateStorage: { backend: "clickhouse", table },
        },
      })).toThrow(/nativeProxyTools\.stateStorage\.table/);
    },
  );

  it("rejects unsupported state backends instead of silently falling back", () => {
    expect(() => buildConfigWithYaml({
      nativeProxyTools: {
        stateStorage: { backend: "memory" },
      },
    })).toThrow(/nativeProxyTools\.stateStorage\.backend/);
  });

  it("inherits the ClickHouse TTL only when history TTL is omitted", () => {
    expect(buildConfigWithYaml({ clickhouse: { ttlDays: 12 } }).nativeProxyTools.historyStorage.ttlDays)
      .toBe(12);
    expect(buildConfigWithYaml({
      clickhouse: { ttlDays: 12 },
      nativeProxyTools: { historyStorage: { ttlDays: 0 } },
    }).nativeProxyTools.historyStorage.ttlDays).toBe(0);
  });

  it.each(["bad-name", "db.table", "1history"])(
    "rejects unsafe history table identifier %s",
    (table) => {
      expect(() => buildConfigWithYaml({
        nativeProxyTools: { historyStorage: { table } },
      })).toThrow(/nativeProxyTools\.historyStorage\.table/);
    },
  );
});
