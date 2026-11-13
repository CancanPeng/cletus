export type ThinkingLevel = "off" | "low" | "medium" | "high";
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export type TextContent = { type: "text"; text: string };
export type ThinkingContent = { type: "thinking"; thinking: string; signature?: string };
export type ToolCallContent = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};
export type ServerToolUseContent = {
  type: "serverToolUse";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type WebSearchResultItem = {
  title?: string;
  url?: string;
  pageAge?: string | null;
  encryptedContent?: string;
};
export type WebSearchResultContent = {
  type: "webSearchResult";
  toolUseId: string;
  results: WebSearchResultItem[];
  errorCode?: string;
};
export type AssistantContent =
  | TextContent
  | ThinkingContent
  | ToolCallContent
  | ServerToolUseContent
  | WebSearchResultContent;

export type Usage = {
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
  | { role: "user"; content: string; timestamp: number }
  | AssistantMessage
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: TextContent[];
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
  /** Enable provider-hosted web search (Anthropic Messages `web_search` server tool). */
  webSearch?: boolean;
  webSearchMaxUses?: number;
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
  sessionId?: string;
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