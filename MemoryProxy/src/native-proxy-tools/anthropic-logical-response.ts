interface AnthropicLogicalResponse {
  outputText: string;
  toolUseCount: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sseDataPayloads(text: string): { payloads: string[]; sawData: boolean } {
  const payloads: string[] = [];
  let dataLines: string[] = [];
  let sawData = false;
  let lineStart = 0;

  const consumeLine = (line: string): void => {
    if (line.length === 0) {
      if (dataLines.length > 0) payloads.push(dataLines.join("\n"));
      dataLines = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== "data") return;
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    sawData = true;
    dataLines.push(value);
  };

  for (let cursor = 0; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (char !== "\r" && char !== "\n") continue;
    consumeLine(text.slice(lineStart, cursor));
    if (char === "\r" && text[cursor + 1] === "\n") cursor++;
    lineStart = cursor + 1;
  }
  if (lineStart < text.length) consumeLine(text.slice(lineStart));
  if (dataLines.length > 0) payloads.push(dataLines.join("\n"));
  return { payloads, sawData };
}

/** Extract only client-visible logical response data from persisted Anthropic bytes. */
export function extractAnthropicLogicalResponse(
  bytes: Uint8Array,
): AnthropicLogicalResponse {
  const text = new TextDecoder().decode(bytes);
  let outputText = "";
  let toolUseCount = 0;
  let parsedSseEvent = false;

  const sse = sseDataPayloads(text);
  for (const payload of sse.payloads) {
    if (!payload || payload === "[DONE]") continue;
    try {
      const event = asRecord(JSON.parse(payload));
      if (!event) continue;
      parsedSseEvent = true;
      if (event.type === "content_block_delta") {
        const delta = asRecord(event.delta);
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          outputText += delta.text;
        }
      } else if (event.type === "content_block_start") {
        const block = asRecord(event.content_block);
        if (block?.type === "tool_use") toolUseCount++;
        if (block?.type === "text" && typeof block.text === "string") {
          outputText += block.text;
        }
      }
    } catch {
      // Malformed telemetry data cannot introduce untrusted fallback text.
    }
  }

  if (parsedSseEvent || sse.sawData) return { outputText, toolUseCount };
  try {
    const response = asRecord(JSON.parse(text));
    if (!response || !Array.isArray(response.content)) return { outputText: "", toolUseCount: 0 };
    for (const value of response.content) {
      const block = asRecord(value);
      if (block?.type === "text" && typeof block.text === "string") outputText += block.text;
      if (block?.type === "tool_use") toolUseCount++;
    }
  } catch {
    return { outputText: "", toolUseCount: 0 };
  }
  return { outputText, toolUseCount };
}
