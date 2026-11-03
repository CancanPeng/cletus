import type { AssistantMessage, Message } from "@cletus/ai";
import type { AgentMessage, AgentTool, JsonValue, ToolResult } from "@cletus/agent";

export type ExtensionEvent =
  | { type: "session_start"; cwd: string }
  | { type: "input"; text: string }
  | { type: "before_tool_call"; toolName: string; args: Record<string, unknown> }
  | { type: "after_tool_call"; toolName: string; args: Record<string, unknown>; result: ToolResult }
  | { type: "turn_end"; message: AssistantMessage; toolResults: Message[] }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "session_shutdown" };

export type ExtensionHandlerResult = void | { block?: boolean; reason?: string };
export type ExtensionHandler = (
  event: ExtensionEvent,
) => ExtensionHandlerResult | Promise<ExtensionHandlerResult>;

export type ExtensionAPI = {
  on: (type: ExtensionEvent["type"], handler: ExtensionHandler) => void;
  registerTool: (tool: AgentTool) => void;
  registerCommand: (
    name: string,
    def: {
      description: string;
      run: (args: string, ctx: { notify: (msg: string) => void }) => Promise<void>;
    },
  ) => void;
  appendEntry: (customType: string, data: JsonValue) => void;
};

export type ExtensionModule = (api: ExtensionAPI) => void | Promise<void>;

export type ExtensionCommand = {
  name: string;
  description: string;
  run: (args: string, ctx: { notify: (msg: string) => void }) => Promise<void>;
};