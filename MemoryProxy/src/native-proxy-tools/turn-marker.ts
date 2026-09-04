import type { JsonValue } from "./types.js";

const TURN_MARKER = /^<tdai-native-turn token="([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})"\/>$/i;

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
    const directToken = markerToken(message.content);
    if (directToken) {
      markers.push({ token: directToken, insertAfterItem: messages.length });
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
      const token = block?.type === "text" ? markerToken(block.text) : null;
      if (token) found.push(token);
      else retained.push(rawBlock);
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
