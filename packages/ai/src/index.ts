import { streamAnthropic } from "./anthropic.js";
import { streamOpenAI } from "./openai.js";
import type { LlmContext, Model, StreamOptions } from "./types.js";
import type { AssistantEventStream, StreamFn } from "./event-stream.js";

export * from "./types.js";
export { AssistantEventStream, errorStream } from "./event-stream.js";
export type { StreamFn } from "./event-stream.js";
export { parseSse } from "./sse.js";
export { streamOpenAI } from "./openai.js";
export { streamAnthropic } from "./anthropic.js";
export { estimateTokens, estimateMessageTokens, estimateContextTokens, toolContentText } from "./tokens.js";

export const streamSimple: StreamFn = (
  model: Model,
  context: LlmContext,
  options?: StreamOptions,
): AssistantEventStream => {
  if (model.provider === "openai") return streamOpenAI(model, context, options);
  return streamAnthropic(model, context, options);
};