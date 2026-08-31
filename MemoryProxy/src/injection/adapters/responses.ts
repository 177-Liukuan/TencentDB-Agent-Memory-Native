import type { NativeProxyToolRegistry } from "../../native-proxy-tools/tool-registry.js";
import type { ProtocolAdapter } from "./interface.js";
import { ResponsesStreamParser } from "./responses-stream.js";
import type {
  AgentContext,
  AgentContextMetadata,
  AgentTool,
  ContextBlock,
  ContextMessage,
  MessageRole,
} from "../types.js";

type Raw = Record<string, unknown>;

const RAW_ITEM = "responsesRawItem";
const ORIGINAL_TEXT = "responsesOriginalText";

/** OpenAI Responses request adapter. This is intentionally separate from Chat Completions. */
export class ResponsesAdapter implements ProtocolAdapter {
  readonly protocol = "responses" as const;

  createStreamParser(registry: NativeProxyToolRegistry): ResponsesStreamParser {
    return new ResponsesStreamParser(registry);
  }

  parse(body: Raw, metadata: AgentContextMetadata): AgentContext {
    const messages: ContextMessage[] = [];
    if (body.instructions !== undefined) {
      const text = this.textOf(body.instructions);
      messages.push({
        role: "system",
        blocks: [{ type: "text", content: text }],
        metadata: { responsesInstructions: true, [ORIGINAL_TEXT]: text },
      });
    }

    if (typeof body.input === "string") {
      messages.push({
        role: "user",
        blocks: [{ type: "text", content: body.input }],
        metadata: { responsesInputString: true, [ORIGINAL_TEXT]: body.input },
      });
    } else if (Array.isArray(body.input)) {
      for (const item of body.input) messages.push(this.parseInputItem(item));
    }

    const tools = Array.isArray(body.tools)
      ? body.tools.filter((tool): tool is Raw => !!tool && typeof tool === "object" && !Array.isArray(tool))
        .map((tool, index) => this.parseTool(tool, index))
      : undefined;
    const requestParams: Raw = {};
    for (const [key, value] of Object.entries(body)) {
      if (key !== "instructions" && key !== "input" && key !== "tools") requestParams[key] = value;
    }
    return { messages, tools, requestParams, metadata };
  }

  serialize(ctx: AgentContext): Raw {
    const body: Raw = { ...ctx.requestParams };
    const system = ctx.messages.find((message) => message.metadata?.responsesInstructions === true);
    if (system) body.instructions = this.messageText(system);

    const inputMessages = ctx.messages.filter((message) => message !== system);
    if (inputMessages.length === 1 && inputMessages[0].metadata?.responsesInputString === true) {
      body.input = this.messageText(inputMessages[0]);
    } else if (inputMessages.length > 0) {
      body.input = inputMessages.map((message) => this.serializeInputItem(message));
    }
    if (ctx.tools && ctx.tools.length > 0) body.tools = ctx.tools.map((tool) => this.serializeTool(tool));
    return body;
  }

  private parseInputItem(value: unknown): ContextMessage {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { role: "user", blocks: [{ type: "custom", content: JSON.stringify(value) }], metadata: { [RAW_ITEM]: value } };
    }
    const raw = value as Raw;
    const isMessage = raw.type === "message" || (raw.type === undefined && typeof raw.role === "string");
    if (!isMessage) {
      return {
        role: "assistant",
        blocks: [{ type: "custom", content: JSON.stringify(raw), metadata: { original_type: raw.type } }],
        metadata: { [RAW_ITEM]: structuredClone(raw), responsesOpaque: true },
      };
    }
    const role = this.toRole(raw.role);
    const blocks = this.parseContent(raw.content);
    return {
      role,
      blocks,
      metadata: {
        [RAW_ITEM]: structuredClone(raw),
        [ORIGINAL_TEXT]: blocks.filter((block) => block.type === "text").map((block) => block.content).join(""),
      },
    };
  }

  private parseContent(content: unknown): ContextBlock[] {
    if (typeof content === "string") return [{ type: "text", content }];
    if (!Array.isArray(content)) return [];
    return content.map((part): ContextBlock => {
      if (part && typeof part === "object" && !Array.isArray(part)) {
        const raw = part as Raw;
        if ((raw.type === "input_text" || raw.type === "output_text") && typeof raw.text === "string") {
          return { type: "text", content: raw.text, metadata: { responsesContentType: raw.type, responsesRawPart: structuredClone(raw) } };
        }
      }
      return { type: "custom", content: JSON.stringify(part), metadata: { responsesRawPart: part } };
    });
  }

  private serializeInputItem(message: ContextMessage): unknown {
    const raw = message.metadata?.[RAW_ITEM];
    if (message.metadata?.responsesOpaque === true) return raw;
    const currentText = this.messageText(message, "");
    if (raw && currentText === message.metadata?.[ORIGINAL_TEXT]) return raw;
    const original = raw && typeof raw === "object" && !Array.isArray(raw) ? structuredClone(raw as Raw) : {};
    const contentWasString = typeof original.content === "string";
    const content = contentWasString
      ? currentText
      : message.blocks.map((block) => {
        if (block.type === "text") {
          const part = block.metadata?.responsesRawPart;
          return { ...(part && typeof part === "object" ? part as Raw : {}), type: block.metadata?.responsesContentType ?? (message.role === "assistant" ? "output_text" : "input_text"), text: block.content };
        }
        return block.metadata?.responsesRawPart ?? JSON.parse(block.content);
      });
    return { ...original, role: message.role, content };
  }

  private parseTool(raw: Raw, index: number): AgentTool {
    const isFunction = raw.type === "function";
    return {
      name: isFunction && typeof raw.name === "string" ? raw.name : `__responses_provider_${index}`,
      description: isFunction && typeof raw.description === "string" ? raw.description : "",
      parameters: isFunction && raw.parameters && typeof raw.parameters === "object" && !Array.isArray(raw.parameters) ? raw.parameters as Raw : {},
      rawDefinition: structuredClone(raw),
    };
  }

  private serializeTool(tool: AgentTool): Raw {
    if (tool.rawDefinition) return structuredClone(tool.rawDefinition);
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: true,
    };
  }

  private toRole(value: unknown): MessageRole {
    return value === "assistant" || value === "system" || value === "tool" ? value : "user";
  }

  private textOf(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n");
    return JSON.stringify(value ?? "");
  }

  private messageText(message: ContextMessage, separator = "\n"): string {
    return message.blocks.filter((block) => block.type === "text").map((block) => block.content).join(separator);
  }
}
