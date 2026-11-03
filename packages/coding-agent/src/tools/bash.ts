import { spawn } from "node:child_process";
import { constants } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool, ToolResult } from "@cletus/agent";
import type { PermissionPolicy } from "../permissions/policy.js";
import { truncateTail } from "./truncate.js";

function signalNumber(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const table = constants.signals as Record<string, number>;
  return 128 + (table[signal] ?? 1);
}

export function createBashTool(deps: {
  policy: PermissionPolicy;
  cwd: string;
  home: string;
  model: string;
  sessionId: string;
}): AgentTool {
  return {
    name: "bash",
    snippet: "Execute bash commands",
    description: "Run a bash command and return combined stdout/stderr.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to run" },
        timeout: { type: "number", description: "Timeout in milliseconds" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(params, ctx): Promise<ToolResult> {
      const command = String(params["command"] ?? "");
      const timeout = Math.min(Math.max(Number(params["timeout"] ?? 120_000), 1), 600_000);
      return await new Promise<ToolResult>((resolve) => {
        const child = spawn("/bin/bash", ["-lc", command], {
          cwd: deps.cwd,
          env: {
            ...process.env,
            CLETUS_SESSION_ID: deps.sessionId,
            CLETUS_MODEL: deps.model,
            CLETUS_CWD: deps.cwd,
          },
          detached: true,
        });
        let output = "";
        let finished = false;
        const append = (chunk: Buffer): void => {
          output += chunk.toString("utf8");
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);

        const kill = (): void => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            // already exited
          }
        };
        const timer = setTimeout(() => {
          if (finished) return;
          finished = true;
          kill();
          const body = `Command timed out after ${Math.round(timeout / 1000)}s\n${output}`;
          resolve({
            isError: true,
            content: [{ type: "text", text: truncateTail(body).text }],
          });
        }, timeout);
        const onAbort = (): void => {
          if (finished) return;
          finished = true;
          kill();
          clearTimeout(timer);
          resolve({
            isError: true,
            content: [{ type: "text", text: `Command aborted\n${output}` }],
          });
        };
        ctx.signal.addEventListener("abort", onAbort, { once: true });

        child.on("error", (error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve({
            isError: true,
            content: [{ type: "text", text: `Failed to run command: ${error.message}` }],
          });
        });
        child.on("close", (code, signal) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", onAbort);
          const exitCode = code ?? signalNumber(signal);
          const truncated = truncateTail(output);
          let text = truncated.text;
          if (truncated.truncated) {
            const logPath = join(deps.home, "tmp", `bash-${ctx.toolCallId}.log`);
            void mkdir(join(deps.home, "tmp"), { recursive: true }).then(() =>
              writeFile(logPath, output, "utf8"),
            );
            text += `\nFull output: ${logPath}`;
          }
          text += `\nExit code: ${exitCode}`;
          resolve({
            isError: exitCode !== 0,
            content: [{ type: "text", text }],
          });
        });
      });
    },
  };
}