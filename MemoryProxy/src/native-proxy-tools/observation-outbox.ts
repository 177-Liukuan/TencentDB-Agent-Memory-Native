import { createHash, randomUUID } from "node:crypto";

import {
  serializeToolExecutionStateKey,
  type ToolExecutionStorageAdapter,
} from "../db/tool-execution-storage-adapter.js";
import type { ToolExecutionStateKey } from "./types.js";

export class ToolObservationOutboxError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ToolObservationOutboxError";
  }
}

export interface ToolObservationClaim {
  leaseOwner: string;
  idempotencyKey: string;
}

export function toolObservationIdempotencyKey(key: ToolExecutionStateKey): string {
  const digest = createHash("sha256")
    .update(`native-tool-logical-observation:v1:${serializeToolExecutionStateKey(key)}`)
    .digest("hex");
  return `native-tool-observation-${digest}`;
}

export async function claimToolObservation(input: {
  storage: ToolExecutionStorageAdapter;
  key: ToolExecutionStateKey;
  leaseMs: number;
  now?: () => Date;
  createId?: () => string;
  maxStorageAttempts?: number;
}): Promise<ToolObservationClaim> {
  const now = input.now ?? (() => new Date());
  const createId = input.createId ?? randomUUID;
  const maxStorageAttempts = input.maxStorageAttempts ?? 8;
  const leaseOwner = `native-tool-observer-${createId()}`;
  const leaseUntil = new Date(now().getTime() + Math.max(1, input.leaseMs)).toISOString();

  for (let attempt = 0; attempt < maxStorageAttempts; attempt++) {
    const context = await input.storage.get(input.key);
    if (!context) {
      throw new ToolObservationOutboxError(
        "native_tool_observation_state_unavailable",
        "Native Tool observation state is unavailable",
      );
    }
    if (context.observationStatus === "completed") {
      throw new ToolObservationOutboxError(
        "native_tool_observation_completed",
        "Native Tool observation is already complete",
      );
    }
    if (context.observationStatus === "running"
      && context.observationLeaseUntil
      && Date.parse(context.observationLeaseUntil) > now().getTime()) {
      throw new ToolObservationOutboxError(
        "native_tool_observation_in_progress",
        "Native Tool observation is already in progress",
      );
    }
    if (context.observationStatus !== "pending" && context.observationStatus !== "running") {
      throw new ToolObservationOutboxError(
        "native_tool_observation_not_pending",
        "Native Tool observation is not pending",
      );
    }
    if (await input.storage.tryClaimObservation({
      key: input.key,
      expectedRevision: context.revision,
      leaseOwner,
      leaseUntil,
    })) {
      return {
        leaseOwner,
        idempotencyKey: toolObservationIdempotencyKey(input.key),
      };
    }
  }
  throw new ToolObservationOutboxError(
    "native_tool_observation_conflict",
    "Native Tool observation could not be claimed",
  );
}

export async function completeToolObservation(
  storage: ToolExecutionStorageAdapter,
  key: ToolExecutionStateKey,
  leaseOwner: string,
  maxStorageAttempts = 8,
): Promise<void> {
  for (let attempt = 0; attempt < maxStorageAttempts; attempt++) {
    const context = await storage.get(key);
    if (!context) {
      throw new ToolObservationOutboxError(
        "native_tool_observation_state_unavailable",
        "Native Tool observation state is unavailable",
      );
    }
    if (
      context.observationStatus === "completed"
      && context.observationLeaseOwner === leaseOwner
    ) return;
    if (
      context.observationStatus !== "running"
      || context.observationLeaseOwner !== leaseOwner
    ) {
      throw new ToolObservationOutboxError(
        "native_tool_observation_lease_lost",
        "Native Tool observation lease was lost",
      );
    }
    if (await storage.completeObservation({
      key,
      expectedRevision: context.revision,
      leaseOwner,
    })) return;
  }
  throw new ToolObservationOutboxError(
    "native_tool_observation_conflict",
    "Native Tool observation could not be completed",
  );
}
