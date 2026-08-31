import { ResponsesStreamParser, type ResponsesStreamSnapshot } from "../injection/adapters/responses-stream.js";
import { convertResponsesSseBytesToAnthropic } from "../protocol-bridge/responses-anthropic-response.js";
import {
  OpenAIToolLoopCoordinator,
  type OpenAIToolLoopCoordinatorOptions,
  type OpenAIToolLoopDecision,
  type OpenAIToolLoopRoundInput,
  type ToolStreamSnapshot,
} from "./openai-tool-loop-coordinator.js";
import {
  buildClientVisibleResponsesSse,
  buildResponsesToolInputItems,
} from "./responses-response-rebuilder.js";

export interface AnthropicClientResponsesToolLoopCoordinatorOptions
  extends Omit<OpenAIToolLoopCoordinatorOptions, "codec"> {
  model: string;
}

function asResponses(snapshot: ToolStreamSnapshot): ResponsesStreamSnapshot {
  if (!("outputItems" in snapshot) || !Array.isArray(snapshot.outputItems)) {
    throw new TypeError("Anthropic client Responses Tool Loop received an invalid snapshot");
  }
  return snapshot as ResponsesStreamSnapshot;
}

function anthropicError(code: string, message: string, status: number): {
  bytes: Uint8Array;
  headers: Headers;
} {
  return {
    bytes: new TextEncoder().encode(JSON.stringify({
      type: "error",
      error: {
        type: status >= 500 ? "api_error" : "invalid_request_error",
        code,
        message,
      },
    })),
    headers: new Headers({ "content-type": "application/json" }),
  };
}

/**
 * Responses-native durable Tool Loop with an Anthropic-only client boundary.
 * Persisted request/skeleton state stays Responses; every replayable client
 * byte sequence is converted before the execution core saves or returns it.
 */
export class AnthropicClientResponsesToolLoopCoordinator {
  private readonly delegate: OpenAIToolLoopCoordinator;

  constructor(options: AnthropicClientResponsesToolLoopCoordinatorOptions) {
    const { model, ...delegateOptions } = options;
    this.delegate = new OpenAIToolLoopCoordinator({
      ...delegateOptions,
      codec: {
        protocol: "responses",
        createParser: (registry) => new ResponsesStreamParser(registry),
        assistantSkeleton: (snapshot) => structuredClone(asResponses(snapshot).outputItems),
        buildToolMessages: (snapshot, slots) => (
          buildResponsesToolInputItems(asResponses(snapshot).outputItems, slots)
        ),
        buildClientVisibleSse: (rawBytes, proxyIndexes) => convertResponsesSseBytesToAnthropic(
          [buildClientVisibleResponsesSse(rawBytes, proxyIndexes)],
          { model },
        ),
        buildReplaySse: (rawBytes) => convertResponsesSseBytesToAnthropic([rawBytes], { model }),
        buildError: anthropicError,
      },
    });
  }

  handleRound(input: OpenAIToolLoopRoundInput): Promise<OpenAIToolLoopDecision> {
    return this.delegate.handleRound(input);
  }
}
