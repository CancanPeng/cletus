import type { AgentTool, ToolResult } from "@cletus/agent";
import type { Model } from "@cletus/ai";
import type { PermissionPolicy } from "../permissions/policy.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createFindTool } from "./find.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createReadTool } from "./read.js";
import { createTaskTool, type SubagentRequest } from "./task.js";
import { createWriteTool } from "./write.js";

export type CoreToolDeps = {
  cwd: string;
  policy: PermissionPolicy;
  home: string;
  model: Model;
  sessionId: string;
};

export function createCoreTools(deps: CoreToolDeps): AgentTool[] {
  return [
    createReadTool({ policy: deps.policy, cwd: deps.cwd }),
    createWriteTool({ policy: deps.policy }),
    createEditTool({ policy: deps.policy }),
    createBashTool({
      policy: deps.policy,
      cwd: deps.cwd,
      home: deps.home,
      model: `${deps.model.provider}/${deps.model.id}`,
      sessionId: deps.sessionId,
    }),
    createGrepTool({ policy: deps.policy, cwd: deps.cwd }),
    createFindTool({ policy: deps.policy, cwd: deps.cwd }),
    createLsTool({ policy: deps.policy, cwd: deps.cwd }),
  ];
}

export function createBuiltInTools(
  opts: CoreToolDeps & {
    spawnSubagent: (req: SubagentRequest) => Promise<ToolResult>;
  },
): AgentTool[] {
  return [
    ...createCoreTools(opts),
    createTaskTool({ spawnSubagent: opts.spawnSubagent }),
  ];
}

export type { SubagentRequest };
export { createTaskTool };