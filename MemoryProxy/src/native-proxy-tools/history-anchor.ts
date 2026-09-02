import { createHash } from "node:crypto";

import type { HistoryAnchor, NativeToolHistoryScope, NativeToolProtocol } from "./types.js";

const HISTORY_DIGEST_SEED = "native-tool-history-anchor:v1";
const IGNORED_HISTORY_KEYS = new Set(["cache_control"]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, child]) => !IGNORED_HISTORY_KEYS.has(key) && child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function canonicalHistoryJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function buildHistoryAnchors(items: readonly unknown[]): HistoryAnchor[] {
  const anchors: HistoryAnchor[] = [{
    version: 1,
    prefixDigest: digest(HISTORY_DIGEST_SEED),
    itemCount: 0,
  }];
  for (const [index, item] of items.entries()) {
    const previous = anchors[index];
    anchors.push({
      version: 1,
      prefixDigest: digest(`${previous.prefixDigest}\n${canonicalHistoryJson(item)}`),
      itemCount: index + 1,
    });
  }
  return anchors;
}

export function createHistoryAnchor(items: readonly unknown[]): HistoryAnchor {
  return buildHistoryAnchors(items).at(-1)!;
}

export function createLogicalTurnId(input: {
  scope: NativeToolHistoryScope;
  clientProtocol: NativeToolProtocol;
  anchor: HistoryAnchor;
  requestFingerprint: string;
}): string {
  return digest(JSON.stringify(canonicalize({
    version: 1,
    scope: input.scope,
    clientProtocol: input.clientProtocol,
    anchor: input.anchor,
    requestFingerprint: input.requestFingerprint,
  })));
}
