import type { ToolLoopDecision } from "./tool-loop-coordinator.js";

/** Only a visible, terminal model answer may trigger per-turn L0/Skill effects. */
export function isLogicalFinalToolLoopDecision(
  kind: ToolLoopDecision["kind"],
): boolean {
  return kind === "replay" || kind === "final";
}
