import { describe, expect, it } from "vitest";

import {
  createInMemoryToolExecutionBackend,
  InMemoryToolExecutionStorageAdapter,
} from "../in-memory-tool-execution-storage-adapter.js";
import {
  TOOL_EXECUTION_STATE_BYTE_LIMITS,
  REENTRY_STATE_EXPIRY_GRACE_MS,
  ToolExecutionConflictError,
  ToolExecutionValidationError,
  validateToolExecutionContext,
  type ToolExecutionStorageAdapter,
} from "../tool-execution-storage-adapter.js";
import type {
  JsonValue,
  ToolCallSlot,
  ToolExecutionContext,
  ToolExecutionScope,
  ToolExecutionStateKey,
} from "../../native-proxy-tools/types.js";

interface ContractHarness {
  primary: ToolExecutionStorageAdapter;
  secondary: ToolExecutionStorageAdapter;
  now(): Date;
  advance(milliseconds: number): void;
}

type ContractHarnessFactory = () => Promise<ContractHarness> | ContractHarness;

const scope: ToolExecutionScope = {
  spaceId: "space-1",
  userId: "user-1",
  agentSource: "claude-code",
  sessionId: "session-1",
  contextVersion: "v1",
};

const key: ToolExecutionStateKey = {
  ...scope,
  toolBatchId: "batch-1",
};

function proxySlot(overrides: Partial<ToolCallSlot> = {}): ToolCallSlot {
  return {
    callId: "p1",
    slotIndex: 0,
    contentBlockIndex: 0,
    toolName: "tdai_memory_search",
    owner: "proxy",
    input: { query: "rules", limit: 5 },
    argumentsComplete: true,
    status: "pending",
    executionAttempt: 0,
    ...overrides,
  };
}

function clientSlot(overrides: Partial<ToolCallSlot> = {}): ToolCallSlot {
  return {
    callId: "c1",
    slotIndex: 1,
    contentBlockIndex: 1,
    toolName: "client_shell",
    owner: "client",
    input: { command: "pwd" },
    argumentsComplete: true,
    status: "pending",
    executionAttempt: 0,
    ...overrides,
  };
}

function pendingContext(
  now: Date,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  const createdAt = now.toISOString();
  return {
    key,
    turnSeq: 1,
    protocol: "anthropic",
    round: 1,
    totalCalls: 1,
    assistantSkeleton: [],
    slots: [proxySlot()],
    responseStreamStatus: "streaming",
    clientDispatchStatus: "none",
    upstreamSnapshot: {
      protocol: "anthropic",
      baseMessages: [{ role: "user", content: "hello" }],
      system: "injected system",
      tools: [{ name: "tdai_memory_search" }],
      requestParameters: { model: "claude-test", max_tokens: 1_024, stream: true },
      target: {
        id: "agent:claude-code",
        url: "https://upstream.example/v1/messages",
        model: "claude-test",
        authSource: "client",
      },
    },
    revision: 0,
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

describe("validateToolExecutionContext durable replay boundary", () => {
  it("rejects malformed or unsafe persisted response headers with a validation error", () => {
    const context = pendingContext(new Date(), {
      clientDispatchStatus: "completed",
      reentryOutcome: {
        kind: "final",
        status: 200,
        headers: null as unknown as Record<string, string>,
        bodyBase64: "ZmluYWw=",
      },
    });

    expect(() => validateToolExecutionContext(context))
      .toThrow(ToolExecutionValidationError);

    context.reentryOutcome!.headers = { "set-cookie": "session=unsafe" };
    expect(() => validateToolExecutionContext(context))
      .toThrow(ToolExecutionValidationError);
  });

  it("requires Client dispatch outcomes to reference a child batch in the same scope", () => {
    const context = pendingContext(new Date(), {
      clientDispatchStatus: "completed",
      reentryOutcome: {
        kind: "client_dispatch",
        status: 200,
        headers: { "content-type": "text/event-stream" },
        bodyBase64: "ZmluYWw=",
      },
    });

    expect(() => validateToolExecutionContext(context))
      .toThrow(ToolExecutionValidationError);

    context.reentryOutcome!.childStateKey = {
      ...key,
      sessionId: "other-session",
      toolBatchId: "child-batch",
    };
    expect(() => validateToolExecutionContext(context))
      .toThrow(ToolExecutionValidationError);
  });

  it("rejects non-allowlisted fields in persisted response snapshots", () => {
    const context = pendingContext(new Date(), {
      clientDispatchStatus: "pending",
      clientDispatchOutcome: {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        bodyBase64: "ZmluYWw=",
      },
    });
    (context.clientDispatchOutcome as unknown as Record<string, unknown>).authorization = "secret";

    expect(() => validateToolExecutionContext(context))
      .toThrow(ToolExecutionValidationError);
  });

  it("allows only scope-bound, credential-free observation intent", () => {
    const context = pendingContext(new Date());
    context.upstreamSnapshot.requestFingerprint = `sha256:${"a".repeat(64)}`;
    context.upstreamSnapshot.observationIntent = {
      version: 1,
      agentSource: "claude-code",
      identity: {
        spaceId: "space-1",
        teamId: "team-1",
        userId: "user-1",
        agentId: "agent-1",
        sessionId: "session-1",
      },
      effects: { tdai: true, skill: true },
    };
    expect(() => validateToolExecutionContext(context)).not.toThrow();

    (context.upstreamSnapshot.observationIntent.identity as unknown as Record<string, unknown>)
      .userKey = "secret";
    expect(() => validateToolExecutionContext(context))
      .toThrow(ToolExecutionValidationError);
    delete (context.upstreamSnapshot.observationIntent.identity as unknown as Record<string, unknown>)
      .userKey;
    context.upstreamSnapshot.observationIntent.identity.userId = "other-user";
    expect(() => validateToolExecutionContext(context))
      .toThrow(ToolExecutionValidationError);
  });
});

export function runToolExecutionStorageContract(
  name: string,
  createHarness: ContractHarnessFactory,
): void {
  describe(name, () => {
    it("persists JSON snapshots by value across Adapter instances", async () => {
      const harness = await createHarness();
      const original = pendingContext(harness.now());
      await harness.primary.create(original);
      (original.slots[0].input as Record<string, JsonValue>).query = "mutated";

      const firstRead = await harness.secondary.get(key);
      expect(firstRead?.slots[0].input).toEqual({ query: "rules", limit: 5 });
      (firstRead!.slots[0].input as Record<string, JsonValue>).query = "mutated read";
      await expect(harness.primary.get(key)).resolves.toMatchObject({
        slots: [{ input: { query: "rules", limit: 5 } }],
      });
    });

    it("rejects duplicate batch creation", async () => {
      const harness = await createHarness();
      await harness.primary.create(pendingContext(harness.now()));

      await expect(harness.secondary.create(pendingContext(harness.now())))
        .rejects.toBeInstanceOf(ToolExecutionConflictError);
    });

    it("admits exactly one concurrent creator for the same batch key", async () => {
      const harness = await createHarness();
      const settled = await Promise.allSettled([
        harness.primary.create(pendingContext(harness.now())),
        harness.secondary.create(pendingContext(harness.now())),
      ]);

      expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejection = settled.find((result) => result.status === "rejected");
      expect(rejection).toMatchObject({
        status: "rejected",
        reason: expect.any(ToolExecutionConflictError),
      });
    });

    it("rejects credential-bearing fields outside the persisted snapshot allowlist", async () => {
      const harness = await createHarness();
      const unsafe = pendingContext(harness.now());
      (unsafe.upstreamSnapshot as unknown as Record<string, unknown>).headers = {
        authorization: "Bearer secret",
      };

      await expect(harness.primary.create(unsafe))
        .rejects.toBeInstanceOf(ToolExecutionValidationError);
      await expect(harness.secondary.get(key)).resolves.toBeNull();
    });

    it("rejects oversized persisted slot values before writing state", async () => {
      const harness = await createHarness();
      const oversized = pendingContext(harness.now(), {
        slots: [proxySlot({
          input: { query: "x".repeat(TOOL_EXECUTION_STATE_BYTE_LIMITS.slotValue + 1) },
        })],
      });

      await expect(harness.primary.create(oversized))
        .rejects.toBeInstanceOf(ToolExecutionValidationError);
      await expect(harness.secondary.get(key)).resolves.toBeNull();
    });

    it("allows exactly one concurrent execution lease owner", async () => {
      const harness = await createHarness();
      await harness.primary.create(pendingContext(harness.now()));
      const leaseUntil = new Date(harness.now().getTime() + 10_000).toISOString();

      const [first, second] = await Promise.all([
        harness.primary.tryClaimSlotExecution({
          key,
          callId: "p1",
          expectedRevision: 0,
          leaseOwner: "worker-a",
          leaseUntil,
        }),
        harness.secondary.tryClaimSlotExecution({
          key,
          callId: "p1",
          expectedRevision: 0,
          leaseOwner: "worker-b",
          leaseUntil,
        }),
      ]);

      expect([first, second].filter(Boolean)).toHaveLength(1);
      const stored = await harness.primary.get(key);
      expect(stored).toMatchObject({
        revision: 1,
        slots: [{ status: "running", executionAttempt: 1 }],
      });
      expect(["worker-a", "worker-b"]).toContain(stored!.slots[0].executionLeaseOwner);
    });

    it("does not steal an active lease and reclaims it after expiry", async () => {
      const harness = await createHarness();
      await harness.primary.create(pendingContext(harness.now(), {
        slots: [proxySlot({
          status: "running",
          executionAttempt: 1,
          executionLeaseOwner: "worker-old",
          executionLeaseUntil: new Date(harness.now().getTime() + 5_000).toISOString(),
        })],
      }));

      await expect(harness.secondary.tryClaimSlotExecution({
        key,
        callId: "p1",
        expectedRevision: 0,
        leaseOwner: "worker-new",
        leaseUntil: new Date(harness.now().getTime() + 15_000).toISOString(),
      })).resolves.toBe(false);

      harness.advance(5_001);
      await expect(harness.secondary.tryClaimSlotExecution({
        key,
        callId: "p1",
        expectedRevision: 0,
        leaseOwner: "worker-new",
        leaseUntil: new Date(harness.now().getTime() + 10_000).toISOString(),
      })).resolves.toBe(true);
      await expect(harness.primary.get(key)).resolves.toMatchObject({
        revision: 1,
        slots: [{
          status: "running",
          executionAttempt: 2,
          executionLeaseOwner: "worker-new",
        }],
      });
    });

    it("accepts a slot result exactly once from the current lease owner", async () => {
      const harness = await createHarness();
      await harness.primary.create(pendingContext(harness.now()));
      await harness.primary.tryClaimSlotExecution({
        key,
        callId: "p1",
        expectedRevision: 0,
        leaseOwner: "worker-a",
        leaseUntil: new Date(harness.now().getTime() + 10_000).toISOString(),
      });

      await expect(harness.secondary.compareAndSetSlotResult({
        key,
        callId: "p1",
        expectedRevision: 1,
        leaseOwner: "worker-b",
        result: { secret: "wrong owner" },
        isError: false,
      })).resolves.toBe(false);
      await expect(harness.primary.compareAndSetSlotResult({
        key,
        callId: "p1",
        expectedRevision: 1,
        leaseOwner: "worker-a",
        result: { memories: ["rule-1"] },
        isError: false,
      })).resolves.toBe(true);
      await expect(harness.secondary.compareAndSetSlotResult({
        key,
        callId: "p1",
        expectedRevision: 2,
        leaseOwner: "worker-a",
        result: { memories: ["overwritten"] },
        isError: false,
      })).resolves.toBe(false);
      await expect(harness.primary.get(key)).resolves.toMatchObject({
        revision: 2,
        slots: [{
          status: "succeeded",
          result: { memories: ["rule-1"] },
          isError: false,
        }],
      });
    });

    it("guards stream snapshots with revision CAS and preserves execution state", async () => {
      const harness = await createHarness();
      await harness.primary.create(pendingContext(harness.now(), {
        slots: [proxySlot({
          status: "running",
          executionAttempt: 1,
          executionLeaseOwner: "worker-a",
          executionLeaseUntil: new Date(harness.now().getTime() + 10_000).toISOString(),
        })],
      }));

      await expect(harness.primary.compareAndSetStreamSnapshot({
        key,
        expectedRevision: 0,
        assistantSkeleton: [{ type: "tool_use", id: "p1" }],
        slots: [proxySlot(), clientSlot()],
        responseStreamStatus: "completed",
      })).resolves.toBe(true);
      await expect(harness.secondary.compareAndSetStreamSnapshot({
        key,
        expectedRevision: 0,
        assistantSkeleton: [],
        slots: [],
        responseStreamStatus: "completed",
      })).resolves.toBe(false);

      await expect(harness.primary.get(key)).resolves.toMatchObject({
        revision: 1,
        responseStreamStatus: "completed",
        assistantSkeleton: [{ type: "tool_use", id: "p1" }],
        slots: [
          {
            callId: "p1",
            status: "running",
            executionLeaseOwner: "worker-a",
            executionAttempt: 1,
          },
          { callId: "c1", status: "pending" },
        ],
      });
    });

    it("enforces ordered Client dispatch transitions with CAS", async () => {
      const harness = await createHarness();
      await harness.primary.create(pendingContext(harness.now(), {
        slots: [proxySlot(), clientSlot()],
      }));

      const dispatchOutcome = {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        bodyBase64: "ZGlzcGF0Y2g=",
      };

      await expect(harness.primary.compareAndSetClientDispatchStatus({
        key,
        expectedRevision: 0,
        expectedStatus: "none",
        nextStatus: "pending",
        dispatchOutcome,
      })).resolves.toBe(true);
      await expect(harness.secondary.compareAndSetClientDispatchStatus({
        key,
        expectedRevision: 1,
        expectedStatus: "none",
        nextStatus: "dispatched",
      })).resolves.toBe(false);
      await expect(harness.secondary.compareAndSetClientDispatchStatus({
        key,
        expectedRevision: 1,
        expectedStatus: "pending",
        nextStatus: "dispatched",
      })).resolves.toBe(true);
      await expect(harness.primary.get(key)).resolves.toMatchObject({
        revision: 2,
        clientDispatchStatus: "dispatched",
        clientDispatchOutcome: dispatchOutcome,
      });
    });

    it("round-trips a child continuation link without crossing execution scope", async () => {
      const harness = await createHarness();
      const parentStateKey = { ...key, toolBatchId: "parent-batch" };
      await harness.primary.create(pendingContext(harness.now(), {
        parentStateKey,
        parentReentryAttempt: 2,
        slots: [clientSlot()],
      }));

      await expect(harness.secondary.get(key)).resolves.toMatchObject({
        parentStateKey,
        parentReentryAttempt: 2,
      });

      const invalid = pendingContext(harness.now(), {
        key: { ...key, toolBatchId: "invalid-child" },
        parentStateKey: { ...parentStateKey, userId: "other-user" },
        parentReentryAttempt: 1,
      });
      await expect(harness.primary.create(invalid))
        .rejects.toBeInstanceOf(ToolExecutionValidationError);
    });

    it("renews and fences Client re-entry, then atomically persists its replay outcome", async () => {
      const harness = await createHarness();
      await harness.primary.create(pendingContext(harness.now(), {
        clientDispatchStatus: "dispatched",
        responseStreamStatus: "completed",
        slots: [clientSlot({ status: "succeeded", result: "ok", isError: false })],
      }));
      const firstLease = new Date(harness.now().getTime() + 10_000).toISOString();

      const [first, second] = await Promise.all([
        harness.primary.tryClaimReentry({
          key,
          expectedRevision: 0,
          leaseOwner: "resume-a",
          leaseUntil: firstLease,
        }),
        harness.secondary.tryClaimReentry({
          key,
          expectedRevision: 0,
          leaseOwner: "resume-b",
          leaseUntil: firstLease,
        }),
      ]);

      expect([first, second].filter(Boolean)).toHaveLength(1);
      const claimed = (await harness.primary.get(key))!;
      expect(claimed).toMatchObject({
        revision: 1,
        clientDispatchStatus: "resuming",
        reentryAttempt: 1,
      });
      const firstOwner = claimed.reentryLeaseOwner!;
      harness.advance(5_000);
      const renewedUntil = new Date(harness.now().getTime() + 20_000).toISOString();
      await expect(harness.primary.renewReentry({
        key,
        expectedRevision: claimed.revision,
        leaseOwner: firstOwner,
        leaseUntil: renewedUntil,
      })).resolves.toBe(true);
      const renewed = (await harness.primary.get(key))!;
      expect(renewed).toMatchObject({
        revision: 2,
        clientDispatchStatus: "resuming",
        reentryLeaseOwner: firstOwner,
        reentryLeaseUntil: renewedUntil,
      });

      await expect(harness.secondary.tryClaimReentry({
        key,
        expectedRevision: renewed.revision,
        leaseOwner: "resume-c",
        leaseUntil: new Date(harness.now().getTime() + 20_000).toISOString(),
      })).resolves.toBe(false);

      harness.advance(20_001);
      await expect(harness.secondary.tryClaimReentry({
        key,
        expectedRevision: renewed.revision,
        leaseOwner: "resume-c",
        leaseUntil: new Date(harness.now().getTime() + 10_000).toISOString(),
      })).resolves.toBe(true);
      const reclaimed = (await harness.primary.get(key))!;
      expect(reclaimed).toMatchObject({
        revision: 3,
        clientDispatchStatus: "resuming",
        reentryAttempt: 2,
        reentryLeaseOwner: "resume-c",
      });

      const outcome = {
        kind: "final" as const,
        status: 200,
        headers: { "content-type": "text/event-stream" },
        bodyBase64: "ZmluYWw=",
      };

      await expect(harness.primary.completeReentry({
        key,
        expectedRevision: reclaimed.revision,
        leaseOwner: firstOwner,
        outcome,
      })).resolves.toBe(false);
      await expect(harness.secondary.completeReentry({
        key,
        expectedRevision: reclaimed.revision,
        leaseOwner: "resume-c",
        outcome,
      })).resolves.toBe(true);
      await expect(harness.primary.get(key)).resolves.toMatchObject({
        revision: 4,
        clientDispatchStatus: "completed",
        observationStatus: "pending",
        observationOutcome: {
          status: 200,
          bodyBase64: "ZmluYWw=",
        },
        reentryOutcome: {
          kind: "final",
          status: 200,
          bodyBase64: "ZmluYWw=",
        },
      });
    });

    it("atomically prepares a pure-Native final response observation outbox", async () => {
      const harness = await createHarness();
      await harness.primary.create(pendingContext(harness.now(), {
        responseStreamStatus: "completed",
        slots: [proxySlot({
          status: "succeeded",
          result: { memories: ["rule-1"] },
          isError: false,
        })],
      }));
      const outcome = {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        bodyBase64: "ZmluYWw=",
      };

      await expect(harness.primary.prepareObservation({
        key,
        expectedRevision: 0,
        outcome,
      })).resolves.toBe(true);
      await expect(harness.secondary.prepareObservation({
        key,
        expectedRevision: 0,
        outcome,
      })).resolves.toBe(false);
      await expect(harness.secondary.get(key)).resolves.toMatchObject({
        revision: 1,
        clientDispatchStatus: "none",
        observationStatus: "pending",
        observationOutcome: outcome,
      });
    });

    it("extends logical state expiry beyond every Client re-entry lease", async () => {
      const harness = await createHarness();
      const originalExpiry = new Date(harness.now().getTime() + 1_000).toISOString();
      await harness.primary.create(pendingContext(harness.now(), {
        expiresAt: originalExpiry,
        clientDispatchStatus: "dispatched",
        responseStreamStatus: "completed",
        slots: [clientSlot({ status: "succeeded", result: "ok", isError: false })],
      }));
      const leaseUntil = new Date(harness.now().getTime() + 60_000).toISOString();

      await expect(harness.primary.tryClaimReentry({
        key,
        expectedRevision: 0,
        leaseOwner: "long-response-owner",
        leaseUntil,
      })).resolves.toBe(true);
      const claimed = (await harness.primary.get(key))!;
      expect(Date.parse(claimed.expiresAt)).toBeGreaterThanOrEqual(
        Date.parse(leaseUntil) + REENTRY_STATE_EXPIRY_GRACE_MS,
      );

      harness.advance(2_000);
      await expect(harness.secondary.get(key)).resolves.not.toBeNull();
      const renewedUntil = new Date(harness.now().getTime() + 120_000).toISOString();
      await expect(harness.secondary.renewReentry({
        key,
        expectedRevision: claimed.revision,
        leaseOwner: "long-response-owner",
        leaseUntil: renewedUntil,
      })).resolves.toBe(true);
      const renewed = (await harness.primary.get(key))!;
      expect(Date.parse(renewed.expiresAt)).toBeGreaterThanOrEqual(
        Date.parse(renewedUntil) + REENTRY_STATE_EXPIRY_GRACE_MS,
      );
    });

    it("leases a durable logical-final observation outbox and fences completion", async () => {
      const harness = await createHarness();
      await harness.primary.create(pendingContext(harness.now(), {
        clientDispatchStatus: "resuming",
        responseStreamStatus: "completed",
        reentryLeaseOwner: "resume-owner",
        reentryLeaseUntil: new Date(harness.now().getTime() + 10_000).toISOString(),
        reentryAttempt: 1,
        slots: [clientSlot({ status: "succeeded", result: "ok", isError: false })],
      }));
      await expect(harness.primary.completeReentry({
        key,
        expectedRevision: 0,
        leaseOwner: "resume-owner",
        outcome: {
          kind: "final",
          status: 200,
          headers: { "content-type": "text/event-stream" },
          bodyBase64: "ZmluYWw=",
        },
      })).resolves.toBe(true);
      await expect(harness.secondary.get(key)).resolves.toMatchObject({
        observationStatus: "pending",
        observationOutcome: {
          status: 200,
          bodyBase64: "ZmluYWw=",
        },
      });

      const leaseUntil = new Date(harness.now().getTime() + 20_000).toISOString();
      const current = (await harness.primary.get(key))!;
      const [first, second] = await Promise.all([
        harness.primary.tryClaimObservation({
          key,
          expectedRevision: current.revision,
          leaseOwner: "observer-a",
          leaseUntil,
        }),
        harness.secondary.tryClaimObservation({
          key,
          expectedRevision: current.revision,
          leaseOwner: "observer-b",
          leaseUntil,
        }),
      ]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      const claimed = (await harness.primary.get(key))!;
      expect(claimed).toMatchObject({
        observationStatus: "running",
        observationAttempt: 1,
      });
      const owner = claimed.observationLeaseOwner!;
      await expect(harness.secondary.completeObservation({
        key,
        expectedRevision: claimed.revision,
        leaseOwner: owner === "observer-a" ? "observer-b" : "observer-a",
      })).resolves.toBe(false);
      await expect(harness.primary.completeObservation({
        key,
        expectedRevision: claimed.revision,
        leaseOwner: owner,
      })).resolves.toBe(true);
      await expect(harness.secondary.get(key)).resolves.toMatchObject({
        observationStatus: "completed",
      });
    });

    it("stores Client results without a Native lease and rejects unknown call IDs", async () => {
      const harness = await createHarness();
      await harness.primary.create(pendingContext(harness.now(), {
        totalCalls: 2,
        slots: [proxySlot(), clientSlot()],
      }));

      await expect(harness.primary.compareAndSetSlotResult({
        key,
        callId: "unknown",
        expectedRevision: 0,
        result: "unknown",
        isError: false,
      })).resolves.toBe(false);
      await expect(harness.primary.compareAndSetSlotResult({
        key,
        callId: "c1",
        expectedRevision: 0,
        result: [{ type: "text", text: "client result" }],
        isError: false,
      })).resolves.toBe(true);
      await expect(harness.secondary.compareAndSetSlotResult({
        key,
        callId: "c1",
        expectedRevision: 1,
        result: "duplicate",
        isError: false,
      })).resolves.toBe(false);
    });

    it("finds call IDs only inside the trusted active scope", async () => {
      const harness = await createHarness();
      await harness.primary.create(pendingContext(harness.now(), {
        slots: [proxySlot(), clientSlot()],
      }));

      await expect(harness.secondary.findByCallId(scope, "c1"))
        .resolves.toMatchObject({ key: { toolBatchId: "batch-1" } });
      await expect(harness.secondary.findByCallId({ ...scope, userId: "other" }, "c1"))
        .resolves.toBeNull();
      await expect(harness.secondary.findByCallId(scope, "missing"))
        .resolves.toBeNull();
      await expect(harness.secondary.findActiveBySession(scope))
        .resolves.toHaveLength(1);
    });

    it("hides logically expired state before physical deletion", async () => {
      const harness = await createHarness();
      await harness.primary.create(pendingContext(harness.now()));
      harness.advance(60_001);

      await expect(harness.secondary.get(key)).resolves.toBeNull();
      await expect(harness.secondary.findByCallId(scope, "p1")).resolves.toBeNull();
      await expect(harness.secondary.findByCallId(scope, "p1", { includeExpired: true }))
        .resolves.toMatchObject({ key: { toolBatchId: "batch-1" } });
      await expect(harness.secondary.findActiveBySession(scope)).resolves.toEqual([]);
      await expect(harness.secondary.tryClaimSlotExecution({
        key,
        callId: "p1",
        expectedRevision: 0,
        leaseOwner: "worker-late",
        leaseUntil: new Date(harness.now().getTime() + 10_000).toISOString(),
      })).resolves.toBe(false);
    });

    it("marks only an active stream aborted with revision CAS", async () => {
      const harness = await createHarness();
      await harness.primary.create(pendingContext(harness.now()));

      await expect(harness.primary.markAborted(key, 1)).resolves.toBe(false);
      await expect(harness.primary.markAborted(key, 0)).resolves.toBe(true);
      await expect(harness.secondary.markAborted(key, 1)).resolves.toBe(false);
      await expect(harness.primary.get(key)).resolves.toMatchObject({
        revision: 1,
        responseStreamStatus: "aborted",
      });
    });
  });
}

runToolExecutionStorageContract("In-memory ToolExecutionStorageAdapter contract", () => {
  const backend = createInMemoryToolExecutionBackend();
  let currentTime = Date.parse("2026-08-31T00:00:00.000Z");
  const now = () => new Date(currentTime);
  return {
    primary: new InMemoryToolExecutionStorageAdapter({ backend, now }),
    secondary: new InMemoryToolExecutionStorageAdapter({ backend, now }),
    now,
    advance(milliseconds: number) {
      currentTime += milliseconds;
    },
  };
});
