import { spawn } from "node:child_process";
import { constants } from "node:os";
import { StringDecoder } from "node:string_decoder";
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
      const rawTimeout = Number(params["timeout"] ?? 120_000);
      const timeout = Number.isFinite(rawTimeout)
        ? Math.min(Math.max(rawTimeout, 1), 600_000)
        : 120_000;
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
        const decoder = new StringDecoder("utf8");
        // Retain only the tail: truncateTail keeps the end, and unbounded
        // output from a chatty command must not grow without limit.
        const MAX_OUTPUT = 1_000_000;
        let output = "";
        let outputCapped = false;
        let finished = false;
        let lastUpdate = 0;
        const pushUpdate = (): void => {
          if (finished) return;
          const now = Date.now();
          if (now - lastUpdate < 100) return;
          lastUpdate = now;
          const text = output.length > 20_000 ? truncateTail(output).text : output;
          ctx.onUpdate({
            content: [{ type: "text", text }],
            details: { streaming: true },
          });
        };
        const append = (chunk: Buffer): void => {
          output += decoder.write(chunk);
          if (output.length > MAX_OUTPUT) {
            output = output.slice(-MAX_OUTPUT);
            outputCapped = true;
          }
          pushUpdate();
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
        const cleanup = (): void => {
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", onAbort);
        };
        const onAbort = (): void => {
          if (finished) return;
          finished = true;
          cleanup();
          kill();
          resolve({
            isError: true,
            content: [{ type: "text", text: `Command aborted\n${output}` }],
          });
        };
        const timer = setTimeout(() => {
          if (finished) return;
          finished = true;
          cleanup();
          kill();
          const body = `Command timed out after ${Math.round(timeout / 1000)}s\n${output}`;
          resolve({
            isError: true,
            content: [{ type: "text", text: truncateTail(body).text }],
          });
        }, timeout);
        ctx.signal.addEventListener("abort", onAbort, { once: true });

        child.on("error", (error) => {
          if (finished) return;
          finished = true;
          cleanup();
          resolve({
            isError: true,
            content: [{ type: "text", text: `Failed to run command: ${error.message}` }],
          });
        });
        child.on("close", (code, signal) => {
          if (finished) return;
          finished = true;
          cleanup();
          output += decoder.end();
          const exitCode = code ?? signalNumber(signal);
          const truncated = truncateTail(output);
          void (async () => {
            let text = truncated.text;
            if (truncated.truncated) {
              const logPath = join(deps.home, "tmp", `bash-${ctx.toolCallId}.log`);
              try {
                await mkdir(join(deps.home, "tmp"), { recursive: true });
                await writeFile(logPath, output, "utf8");
                text += `\nFull output: ${logPath}`;
              } catch {
                // Best effort: the truncated output is still returned.
              }
            }
            if (outputCapped) text += "\n[output capped at 1MB; earliest output dropped]";
            text += `\nExit code: ${exitCode}`;
            resolve({
              isError: exitCode !== 0,
              content: [{ type: "text", text }],
            });
          })();
        });
      });
    },
  };
}