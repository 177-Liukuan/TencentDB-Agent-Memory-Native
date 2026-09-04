import type { JsonValue } from "./types.js";

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const TURN_MARKER = new RegExp(`^<tdai-native-turn token="(${UUID_PATTERN})"\\/>$`, "i");
// Claude Code 会在 Hook 的 additionalContext 前加固定说明，不能只匹配裸标记。
const CLAUDE_WRAPPED_TURN_MARKER = new RegExp(
  `UserPromptSubmit hook additional context:\\s*<tdai-native-turn token="(${UUID_PATTERN})"\\/>`,
  "gi",
);

export interface ClaudeTurnMarkerPosition {
  token: string;
  /** 删除标记后，该轮历史应从前多少条消息之后开始。 */
  insertAfterItem: number;
}

export function createClaudeTurnMarker(token: string): string {
  if (!TURN_MARKER.test(`<tdai-native-turn token="${token}"/>`)) {
    throw new Error("Claude turn token must be a UUID");
  }
  return `<tdai-native-turn token="${token}"/>`;
}

function markerToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return TURN_MARKER.exec(value)?.[1]?.toLowerCase() ?? null;
}

function extractMarkerText(value: string): { retained: string; tokens: string[] } {
  const direct = markerToken(value);
  if (direct) return { retained: "", tokens: [direct] };

  const tokens: string[] = [];
  const retained = value.replace(CLAUDE_WRAPPED_TURN_MARKER, (_match, token: string) => {
    tokens.push(token.toLowerCase());
    return "";
  });
  return {
    retained: tokens.length > 0 ? retained.trimEnd() : value,
    tokens,
  };
}

/**
 * 找出 UserPromptSubmit 写入的内部标记，并在转发给模型前删除。
 * 普通文本和 Claude Code 自己加入的 reminder 保持原样。
 */
export function extractClaudeTurnMarkers(input: readonly unknown[]): {
  messages: JsonValue[];
  markers: ClaudeTurnMarkerPosition[];
} {
  const messages: JsonValue[] = [];
  const markers: ClaudeTurnMarkerPosition[] = [];

  for (const raw of input) {
    const message = structuredClone(raw) as Record<string, JsonValue>;
    const direct = typeof message.content === "string"
      ? extractMarkerText(message.content)
      : null;
    if (direct?.tokens.length) {
      if (direct.retained.trim().length > 0) {
        message.content = direct.retained;
        messages.push(message);
      }
      const boundary = messages.length;
      for (const token of direct.tokens) markers.push({ token, insertAfterItem: boundary });
      continue;
    }

    if (!Array.isArray(message.content)) {
      messages.push(message);
      continue;
    }

    const retained: JsonValue[] = [];
    const found: string[] = [];
    for (const rawBlock of message.content) {
      const block = rawBlock as Record<string, JsonValue>;
      if (block?.type !== "text" || typeof block.text !== "string") {
        retained.push(rawBlock);
        continue;
      }
      const extracted = extractMarkerText(block.text);
      found.push(...extracted.tokens);
      if (extracted.retained.trim().length > 0) {
        block.text = extracted.retained;
        retained.push(block);
      }
    }

    if (retained.length > 0) {
      message.content = retained;
      messages.push(message);
    }
    const boundary = messages.length;
    for (const token of found) markers.push({ token, insertAfterItem: boundary });
  }

  return { messages, markers };
}
