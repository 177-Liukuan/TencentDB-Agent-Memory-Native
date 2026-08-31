import { ResponsesStreamParser, type ResponsesStreamSnapshot } from "../injection/adapters/responses-stream.js";
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

export type ResponsesToolLoopRoundInput = OpenAIToolLoopRoundInput;
export type ResponsesToolLoopDecision = OpenAIToolLoopDecision;
export type ResponsesToolLoopCoordinatorOptions = Omit<OpenAIToolLoopCoordinatorOptions, "codec">;

function asResponses(snapshot: ToolStreamSnapshot): ResponsesStreamSnapshot {
  if (!("outputItems" in snapshot) || !Array.isArray(snapshot.outputItems)) {
    throw new TypeError("Responses Tool Loop received a non-Responses stream snapshot");
  }
  return snapshot as ResponsesStreamSnapshot;
}

/** Durable OpenAI Responses Tool Loop using the protocol-neutral execution runtime. */
export class ResponsesToolLoopCoordinator {
  private readonly delegate: OpenAIToolLoopCoordinator;

  constructor(options: ResponsesToolLoopCoordinatorOptions) {
    this.delegate = new OpenAIToolLoopCoordinator({
      ...options,
      codec: {
        protocol: "responses",
        createParser: (registry) => new ResponsesStreamParser(registry),
        assistantSkeleton: (snapshot) => structuredClone(asResponses(snapshot).outputItems),
        buildToolMessages: (snapshot, slots) => buildResponsesToolInputItems(asResponses(snapshot).outputItems, slots),
        buildClientVisibleSse: buildClientVisibleResponsesSse,
      },
    });
  }

  handleRound(input: ResponsesToolLoopRoundInput): Promise<ResponsesToolLoopDecision> {
    return this.delegate.handleRound(input);
  }
}
