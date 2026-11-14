import type {
  ImageAttachment,
  JsonSchema,
  Message,
  Model,
  StreamFn,
  ToolContent,
  ToolCallContent,
} from "@cletus/ai";

export type PromptInput = { text: string; images?: ImageAttachment[] };

export type CustomMessage = {
  role: "custom";
  customType: string;
  content: string;
  display?: boolean;
  timestamp: number;
};
export type AgentMessage = Message | CustomMessage;
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

export type ToolResult = {
  content: ToolContent[];
  details?: unknown;
  isError?: boolean;
  terminate?: boolean;
};
export type ToolExecutionContext = {
  cwd: string;
  toolCallId: string;
  signal: AbortSignal;
  onUpdate: (partial: ToolResult) => void;
};
export type AgentTool<Params = Record<string, unknown>> = {
  name: string;
  snippet?: string;
  description: string;
  parameters: JsonSchema;
  execute: (params: Params, ctx: ToolExecutionContext) => Promise<ToolResult>;
};

export type ToolHooks = {
  beforeToolCall?: (
    call: ToolCallContent,
    args: unknown,
    signal: AbortSignal,
  ) => Promise<{ block?: boolean; reason?: string } | void>;
  afterToolCall?: (
    call: ToolCallContent,
    result: ToolResult,
  ) => Promise<Partial<ToolResult> | void>;
};

export type PrepareRequestContext = {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  model: Model;
};
export type PrepareRequestResult =
  | { systemPrompt?: string; messages?: AgentMessage[]; model?: Model }
  | void;

export type AgentOptions = {
  initialState?: {
    systemPrompt?: string;
    messages?: AgentMessage[];
    tools?: AgentTool[];
  };
  streamFn: StreamFn;
  model: Model;
  /** Working directory reported to tools; defaults to process.cwd(). */
  cwd?: string;
  getApiKey?: (model: Model) => string | undefined;
  convertToLlm?: (messages: AgentMessage[]) => Message[];
  beforeToolCall?: (
    call: ToolCallContent,
    args: unknown,
  ) => Promise<{ block?: boolean; reason?: string } | void>;
  afterToolCall?: (
    call: ToolCallContent,
    result: ToolResult,
  ) => Promise<Partial<ToolResult> | void>;
  prepareRequest?: (ctx: PrepareRequestContext) => Promise<PrepareRequestResult>;
  maxTurns?: number;
};

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "turn_start"; turn: number }
  | { type: "message_start"; message: AgentMessage }
  | {
      type: "message_update";
      message: AgentMessage;
      delta?:
        | { type: "text"; text: string }
        | { type: "thinking"; text: string }
        | { type: "toolcall"; index: number; delta: string };
    }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; partial: ToolResult }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResult }
  | { type: "turn_end"; message: Message & { role: "assistant" }; toolResults: Message[] }
  | { type: "agent_end"; messages: AgentMessage[] };

export type AgentLoopConfig = {
  model: Model;
  streamFn: StreamFn;
  getApiKey?: (model: Model) => string | undefined;
  tools: AgentTool[];
  cwd?: string;
  maxTurns?: number;
  convertToLlm: (messages: AgentMessage[]) => Message[];
  prepareRequest?: AgentOptions["prepareRequest"];
  beforeToolCall?: AgentOptions["beforeToolCall"];
  afterToolCall?: AgentOptions["afterToolCall"];
  drainSteering?: () => PromptInput[];
  drainFollowUp?: () => PromptInput[];
};

export type AgentState = {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  model: Model;
  isStreaming: boolean;
};