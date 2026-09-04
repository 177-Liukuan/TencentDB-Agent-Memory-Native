type Raw = Record<string, unknown>;

export class AnthropicResponsesConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicResponsesConversionError";
  }
}

function isRecord(value: unknown): value is Raw {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AnthropicResponsesConversionError(`${field} must be a non-empty string`);
  }
  return value;
}

function systemText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    throw new AnthropicResponsesConversionError("Anthropic system must be a string or text block array");
  }
  return value.map((block, index) => {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      throw new AnthropicResponsesConversionError(`Anthropic system block ${index} cannot be represented in Responses`);
    }
    return block.text;
  }).join("\n");
}

function imagePart(block: Raw): Raw {
  if (!isRecord(block.source)) {
    throw new AnthropicResponsesConversionError("Anthropic image source is missing");
  }
  const source = block.source;
  if (source.type === "base64") {
    const mediaType = requireString(source.media_type, "image.source.media_type");
    const data = requireString(source.data, "image.source.data");
    return { type: "input_image", image_url: `data:${mediaType};base64,${data}` };
  }
  if (source.type === "url") {
    return { type: "input_image", image_url: requireString(source.url, "image.source.url") };
  }
  throw new AnthropicResponsesConversionError("Anthropic image source type cannot be represented in Responses");
}

function toolOutput(block: Raw): unknown {
  const content = block.content;
  let converted: unknown;
  if (typeof content === "string") {
    converted = content;
  } else if (Array.isArray(content)) {
    const parts = content.map((part, index) => {
      if (!isRecord(part)) {
        throw new AnthropicResponsesConversionError(`tool_result content block ${index} is invalid`);
      }
      if (part.type === "text" && typeof part.text === "string") {
        return { type: "input_text", text: part.text };
      }
      if (part.type === "image") return imagePart(part);
      throw new AnthropicResponsesConversionError(`tool_result content block ${index} cannot be represented in Responses`);
    });
    converted = parts.length === 1 && parts[0].type === "input_text" ? parts[0].text : parts;
  } else if (content === undefined || content === null) {
    converted = "";
  } else {
    converted = JSON.stringify(content);
  }
  return block.is_error === true
    ? JSON.stringify({ is_error: true, content: converted })
    : converted;
}

function pushMessage(
  output: Raw[],
  role: "user" | "assistant",
  parts: Raw[],
): void {
  if (parts.length === 0) return;
  output.push({ type: "message", role, content: parts.splice(0) });
}

function convertMessages(value: unknown): Raw[] {
  if (!Array.isArray(value)) {
    throw new AnthropicResponsesConversionError("Anthropic messages must be an array");
  }
  const output: Raw[] = [];
  for (const [messageIndex, valueMessage] of value.entries()) {
    if (!isRecord(valueMessage) || (valueMessage.role !== "user" && valueMessage.role !== "assistant")) {
      throw new AnthropicResponsesConversionError(`Anthropic message ${messageIndex} has an invalid role`);
    }
    const role = valueMessage.role;
    const content = typeof valueMessage.content === "string"
      ? [{ type: "text", text: valueMessage.content }]
      : valueMessage.content;
    if (!Array.isArray(content)) {
      throw new AnthropicResponsesConversionError(`Anthropic message ${messageIndex} content must be text or blocks`);
    }
    const parts: Raw[] = [];
    for (const [blockIndex, valueBlock] of content.entries()) {
      if (!isRecord(valueBlock) || typeof valueBlock.type !== "string") {
        throw new AnthropicResponsesConversionError(`Anthropic message ${messageIndex} block ${blockIndex} is invalid`);
      }
      const block = valueBlock;
      if (block.type === "text") {
        parts.push({
          type: role === "assistant" ? "output_text" : "input_text",
          text: typeof block.text === "string" ? block.text : "",
        });
        continue;
      }
      if (block.type === "image" && role === "user") {
        parts.push(imagePart(block));
        continue;
      }
      pushMessage(output, role, parts);
      if (block.type === "tool_use" && role === "assistant") {
        output.push({
          type: "function_call",
          call_id: requireString(block.id, "tool_use.id"),
          name: requireString(block.name, "tool_use.name"),
          arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
        });
        continue;
      }
      if (block.type === "tool_result" && role === "user") {
        output.push({
          type: "function_call_output",
          call_id: requireString(block.tool_use_id, "tool_result.tool_use_id"),
          output: toolOutput(block),
        });
        continue;
      }
      if (block.type === "thinking" && role === "assistant") {
        const thinking = typeof block.thinking === "string" ? block.thinking : "";
        output.push({
          type: "reasoning",
          ...(typeof block.signature === "string" && block.signature.length > 0
            ? { id: block.signature }
            : {}),
          content: [{ type: "reasoning_text", text: thinking }],
        });
        continue;
      }
      throw new AnthropicResponsesConversionError(
        `Anthropic ${role} block type '${block.type}' cannot be represented in Responses`,
      );
    }
    pushMessage(output, role, parts);
  }
  return output;
}

function convertTools(value: unknown): Raw[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AnthropicResponsesConversionError("Anthropic tools must be an array");
  }
  return value.map((valueTool, index) => {
    if (!isRecord(valueTool) || !isRecord(valueTool.input_schema)) {
      throw new AnthropicResponsesConversionError(`Anthropic tool ${index} is not a function tool`);
    }
    return {
      type: "function",
      name: requireString(valueTool.name, `tools[${index}].name`),
      description: typeof valueTool.description === "string" ? valueTool.description : "",
      parameters: structuredClone(valueTool.input_schema),
    };
  });
}

function convertToolChoice(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new AnthropicResponsesConversionError("Anthropic tool_choice is invalid");
  }
  if (value.type === "auto" || value.type === "none") return value.type;
  if (value.type === "any") return "required";
  if (value.type === "tool") {
    return { type: "function", name: requireString(value.name, "tool_choice.name") };
  }
  throw new AnthropicResponsesConversionError(`Anthropic tool_choice '${value.type}' is unsupported`);
}

function convertThinking(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new AnthropicResponsesConversionError("Anthropic thinking configuration is invalid");
  }
  if (value.type === "disabled") return { effort: "none" };
  if (value.type === "enabled" || value.type === "adaptive") return { effort: "high" };
  throw new AnthropicResponsesConversionError(`Anthropic thinking type '${value.type}' is unsupported`);
}

/**
 * 将已经完成注入和历史恢复的 Anthropic 请求转换为 Responses。
 * 无法等价表达的字段直接报错，不能为了转发成功而静默丢失语义。
 */
export function convertAnthropicRequestToResponses(body: Raw): Raw {
  for (const field of ["stop_sequences", "top_k"] as const) {
    if (body[field] !== undefined) {
      throw new AnthropicResponsesConversionError(
        `Anthropic request field '${field}' cannot be represented by the Responses upstream`,
      );
    }
  }
  const output: Raw = {};
  for (const name of ["model", "stream", "temperature", "top_p", "metadata", "service_tier"] as const) {
    if (body[name] !== undefined) output[name] = structuredClone(body[name]);
  }
  if (body.max_tokens !== undefined) output.max_output_tokens = body.max_tokens;
  const instructions = systemText(body.system);
  if (instructions !== undefined) output.instructions = instructions;
  output.input = convertMessages(body.messages);
  const tools = convertTools(body.tools);
  if (tools && tools.length > 0) output.tools = tools;
  const toolChoice = convertToolChoice(body.tool_choice);
  if (toolChoice !== undefined) output.tool_choice = toolChoice;
  const reasoning = convertThinking(body.thinking);
  if (reasoning !== undefined) output.reasoning = reasoning;
  return output;
}
