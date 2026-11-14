export type ThinkingLevel = "off" | "low" | "medium" | "high";
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted" | "maxTurns";

export type TextContent = { type: "text"; text: string };
export type ImageAttachment = { mediaType: "image/png" | "image/jpeg"; path: string };
export type ImageContent = { type: "image"; mediaType: "image/png" | "image/jpeg"; path: string };
export type ToolContent = TextContent | ImageContent;
export type ThinkingContent = { type: "thinking"; thinking: string; signature?: string };
export type ToolCallContent = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};
export type AssistantContent = TextContent | ThinkingContent | ToolCallContent;

export type Usage = {
  /**
   * Input tokens excluding cache reads/writes for Anthropic; OpenAI reports
   * prompt_tokens including cached tokens, so cacheRead overlaps input there.
   */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

export type AssistantMessage = {
  role: "assistant";
  content: AssistantContent[];
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
};

export type Message =
  | { role: "system"; content: string; timestamp: number }
  | { role: "user"; content: string; timestamp: number; images?: ImageAttachment[] }
  | AssistantMessage
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: ToolContent[];
      isError: boolean;
      timestamp: number;
    };

export type JsonSchema = Record<string, unknown>;
export type ToolDeclaration = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export type LlmContext = {
  systemPrompt: string;
  messages: Message[];
  tools: ToolDeclaration[];
};

export type Model = {
  provider: "openai" | "anthropic";
  id: string;
  name?: string;
  /** Unique reference; defaults to `${provider}/${id}`. */
  ref?: string;
  baseUrl: string;
  /** Environment variable name; takes precedence over apiKeyId. */
  apiKeyEnv?: string;
  /** Key name in ~/.cletus/auth.json. */
  apiKeyId?: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsThinking?: boolean;
  thinkingLevel?: ThinkingLevel;
  supportsImages?: boolean;
};

export type AssistantStreamEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "toolcall_start"; index: number; id: string; name: string }
  | { type: "toolcall_delta"; index: number; delta: string }
  | { type: "toolcall_end"; index: number; toolCall: ToolCallContent }
  | { type: "done"; message: AssistantMessage }
  | { type: "error"; message: AssistantMessage; error: string };

export type StreamOptions = {
  signal?: AbortSignal;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  thinkingLevel?: ThinkingLevel;
};

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

export function assistantMessage(
  model: Model,
  content: AssistantContent[],
  stopReason: StopReason,
  usage: Usage = emptyUsage(),
  errorMessage?: string,
): AssistantMessage {
  const message: AssistantMessage = {
    role: "assistant",
    content,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason,
    timestamp: Date.now(),
  };
  if (errorMessage !== undefined) message.errorMessage = errorMessage;
  return message;
}

export function textOf(content: AssistantContent[]): string {
  return content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
}