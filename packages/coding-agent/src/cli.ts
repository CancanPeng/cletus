#!/usr/bin/env -S node --disable-warning=ExperimentalWarning --experimental-ffi
import { access, readFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import type { AgentEvent, AgentMessage } from "@cletus/agent";
import type { Model } from "@cletus/ai";
import type { TuiApp as TuiAppType, SlashCommand } from "@cletus/tui";
import {
  ConfigError,
  authPath,
  cletusHome,
  configPath,
  loadAuth,
  loadConfig,
  resolveApiKey,
  resolveModel,
  writeJsonAtomic,
  type AuthStore,
  type CletusConfig,
} from "./config.js";
import { importPi } from "./config/import-pi.js";
import { ResourceLoader } from "./resources/index.js";
import { buildSystemPrompt } from "./prompt/system.js";
import { ExtensionHost } from "./extensions/host.js";
import { McpManager } from "./mcp/manager.js";
import { loadMcpConfig } from "./mcp/config.js";
import { PermissionPolicy } from "./permissions/policy.js";
import { AgentSession } from "./session/session.js";
import { SessionManager } from "./session/manager.js";
import { expandTemplate } from "./resources/prompts.js";

const VERSION = "0.1.0";
const execFileAsync = promisify(execFile);
const BUILTIN_COMMANDS = [
  "help",
  "quit",
  "new",
  "resume",
  "compact",
  "model",
  "theme",
  "keys",
  "skills",
  "permissions",
  "yolo",
  "mcp",
  "reload",
];
const BUILTIN_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls", "web_search", "task"];

function helpText(): string {
  return `cletus ${VERSION}

Usage: cletus [prompt] [options]

Options:
  -p, --print            Run once and print the final text
      --json             Emit AgentEvent JSONL (implies --print)
      --model <ref>      Model reference (provider/id)
      --resume <id>      Resume a session by id
      --continue         Continue the most recent session in this cwd
      --yolo             Skip all permission confirmations
      --trust            Trust project .cletus resources
      --no-extensions    Do not load extensions
      --cwd <path>       Working directory
      --version          Print version
  -h, --help             Print help

Subcommands:
  cletus mcp add|list|remove
  cletus sessions list
  cletus skills list|enable|disable
  cletus permissions list|add|remove|reset
  cletus import-pi [--from <piHome>] [--force]`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value)) result[key] = entry;
  }
  return result;
}

async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function trustFile(home: string): string {
  return join(home, "trust.json");
}

async function readTrust(home: string): Promise<Record<string, boolean>> {
  try {
    return JSON.parse(await readFile(trustFile(home), "utf8")) as Record<string, boolean>;
  } catch {
    return {};
  }
}

async function projectHasResources(cwd: string): Promise<boolean> {
  return (
    (await exists(join(cwd, ".cletus", "extensions"))) ||
    (await exists(join(cwd, ".cletus", "skills"))) ||
    (await exists(join(cwd, ".cletus", "prompts"))) ||
    (await exists(join(cwd, ".cletus", "mcp.json")))
  );
}

async function decideTrust(
  cwd: string,
  home: string,
  tui: boolean,
  forceTrust: boolean,
): Promise<boolean> {
  if (forceTrust) return true;
  if (!(await projectHasResources(cwd))) return false;
  const trust = await readTrust(home);
  if (trust[cwd] !== undefined) return trust[cwd] === true;
  if (!tui) return false;
  const accepted = await askYesNo(`Trust project resources in ${cwd}?`);
  trust[cwd] = accepted;
  await writeJsonAtomic(trustFile(home), trust);
  return accepted;
}

async function gitBranch(cwd: string): Promise<string | undefined> {
  try {
    const branch = await execFileAsync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      timeout: 1000,
    });
    const name = String(branch.stdout).trim();
    if (name && name !== "HEAD") return name;
    const sha = await execFileAsync("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], {
      timeout: 1000,
    });
    return String(sha.stdout).trim() || undefined;
  } catch {
    return undefined;
  }
}

function shortTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function contextLabel(session: AgentSession): string {
  const usage = session.getContextUsage();
  const percent = usage.window > 0 ? Math.round((usage.used / usage.window) * 100) : 0;
  return `${shortTokens(usage.used)}/${shortTokens(usage.window)} ${Math.min(100, percent)}%`;
}

function headerFor(cwd: string, session: AgentSession, branch?: string): string {
  const home = homedir();
  const shortCwd = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  const parts = [
    "cletus",
    session.model.ref ?? `${session.model.provider}/${session.model.id}`,
    shortCwd,
  ];
  if (branch) parts.push(`git:${branch}`);
  parts.push(session.manager.sessionId.slice(0, 8));
  return parts.join(" · ");
}

function eventText(message: AgentMessage): string {
  if (message.role === "assistant") {
    return message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
  }
  return "";
}

async function createSessionFor(opts: {
  cwd: string;
  home: string;
  config: CletusConfig;
  auth: AuthStore;
  model: Model;
  manager: SessionManager;
  resources: ResourceLoader;
  policy: PermissionPolicy;
  mcp: McpManager;
  extensions: ExtensionHost;
  onNotice: (text: string, level?: "info" | "warn" | "error") => void;
}): Promise<AgentSession> {
  return AgentSession.create({
    cwd: opts.cwd,
    home: opts.home,
    config: opts.config,
    auth: opts.auth,
    model: opts.model,
    sessionManager: opts.manager,
    resources: opts.resources,
    permissions: opts.policy,
    mcp: opts.mcp,
    extensions: opts.extensions,
    onNotice: opts.onNotice,
  });
}

async function runTui(opts: {
  cwd: string;
  home: string;
  config: CletusConfig;
  auth: AuthStore;
  model: Model;
  manager: SessionManager;
  resources: ResourceLoader;
  mcp: McpManager;
  extensions: ExtensionHost;
  yolo: boolean;
}): Promise<number> {
  const { TuiApp, getTheme, KeybindingsManager } = await import("@cletus/tui");
  let app: TuiAppType | undefined;
  let session: AgentSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let assistantId: string | undefined;
  let assistantText = "";
  let blockCounter = 0;
  let branch = await gitBranch(opts.cwd);

  const refreshHeader = async (): Promise<void> => {
    branch = await gitBranch(opts.cwd);
    if (session) app?.setHeader(headerFor(opts.cwd, session, branch));
  };

  const confirm = async (req: { summary: string }): Promise<"allow" | "session" | "deny"> =>
    app ? app.confirm("Permission required", req.summary) : "deny";

  const policy = new PermissionPolicy({
    cwd: opts.cwd,
    readOnlyRoots: opts.resources.cached?.readOnlyRoots ?? [],
    allowWrite: opts.config.permissions.allowWrite,
    yolo: opts.yolo,
    interactive: !opts.yolo,
    confirm,
  });

  const mapEvent = (event: AgentEvent): void => {
    if (!app || !session) return;
    if (event.type === "message_start" && event.message.role === "assistant") {
      app.setStatus({
        busy: true,
        model: session.model.ref ?? session.model.id,
        tokens: "",
        queue: session.agent.queuedMessageCount,
        activity: "thinking",
        context: contextLabel(session),
      });
      assistantId = `a${blockCounter++}`;
      assistantText = "";
      app.appendBlock({ id: assistantId, kind: "assistant", text: "" });
    } else if (event.type === "message_update" && event.delta.type === "text") {
      if (!assistantId) {
        assistantId = `a${blockCounter++}`;
        app.appendBlock({ id: assistantId, kind: "assistant", text: "" });
      }
      assistantText += event.delta.text;
      app.updateBlock(assistantId, { kind: "assistant", text: assistantText });
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      const text = eventText(event.message);
      if (text) {
        assistantText = text;
        if (!assistantId) {
          assistantId = `a${blockCounter++}`;
          app.appendBlock({ id: assistantId, kind: "assistant", text });
        } else app.updateBlock(assistantId, { kind: "assistant", text });
      }
      if (event.message.stopReason === "error") {
        app.notify(event.message.errorMessage ?? "Model error", "error");
      }
    } else if (event.type === "tool_execution_start") {
      app.setStatus({
        busy: true,
        model: session.model.ref ?? session.model.id,
        tokens: "",
        queue: session.agent.queuedMessageCount,
        activity: `running ${event.toolName}`,
        context: contextLabel(session),
      });
      app.appendBlock({
        id: `t${event.toolCallId}`,
        kind: "tool",
        name: event.toolName,
        argsSummary: JSON.stringify(event.args).slice(0, 120),
        output: "",
        isError: false,
        expanded: false,
      });
    } else if (event.type === "tool_execution_update") {
      const text = event.partial.content.map((block) => block.text).join("");
      app.updateBlock(`t${event.toolCallId}`, { kind: "tool", output: text });
    } else if (event.type === "tool_execution_end") {
      const text = event.result.content.map((block) => block.text).join("");
      app.updateBlock(`t${event.toolCallId}`, {
        kind: "tool",
        output: text,
        isError: event.result.isError === true,
      });
      app.setStatus({
        busy: true,
        model: session.model.ref ?? session.model.id,
        tokens: "",
        queue: session.agent.queuedMessageCount,
        activity: "thinking",
        context: contextLabel(session),
      });
    } else if (event.type === "turn_end") {
      app.setStatus({
        busy: true,
        model: session.model.ref ?? session.model.id,
        tokens: String(event.message.usage.totalTokens),
        queue: session.agent.queuedMessageCount,
        activity: "thinking",
        context: contextLabel(session),
      });
    } else if (event.type === "agent_end") {
      app.setStatus({
        busy: false,
        model: session.model.ref ?? session.model.id,
        tokens: "",
        queue: 0,
        context: contextLabel(session),
      });
      assistantId = undefined;
    }
  };

  const attach = async (manager: SessionManager): Promise<void> => {
    policy.resetSession();
    policy.setYolo(opts.yolo);
    app?.setYolo(opts.yolo);
    if (session) {
      unsubscribe?.();
      await session.dispose();
    }
    session = await createSessionFor({
      cwd: opts.cwd,
      home: opts.home,
      config: opts.config,
      auth: opts.auth,
      model: opts.model,
      manager,
      resources: opts.resources,
      policy,
      mcp: opts.mcp,
      extensions: opts.extensions,
      onNotice: (text, level) => app?.notify(text, level),
    });
    unsubscribe = session.subscribe(mapEvent);
    app?.setHeader(headerFor(opts.cwd, session, branch));
  };

  const commands: SlashCommand[] = [
    { name: "quit", description: "Exit cletus", run: () => {
        session?.abort();
        app?.stop();
      } },
    {
      name: "new",
      description: "Start a new session",
      run: async () => {
        const manager = await SessionManager.create(opts.cwd, { home: opts.home });
        await attach(manager);
        app?.clearTranscript();
      },
    },
    {
      name: "resume",
      description: "Resume a session",
      run: async () => {
        const infos = await SessionManager.list(opts.cwd, { home: opts.home });
        const choice = await app?.select(
          "Resume session",
          infos.map((info) => ({
            label: `${new Date(info.timestamp).toLocaleString()} ${info.firstUserText.slice(0, 50)}`,
            value: info.filePath,
          })),
        );
        if (!choice) return;
        const manager = await SessionManager.open(choice);
        await attach(manager);
        app?.clearTranscript();
      },
    },
    {
      name: "compact",
      description: "Compact the conversation",
      run: async (args) => {
        if (!session) return;
        if (session.agent.state.isStreaming) {
          app?.notify("Cannot /compact while running", "warn");
          return;
        }
        await session.compact(args || undefined);
        app?.notify("Compaction complete");
      },
    },
    {
      name: "model",
      description: "Switch model",
      run: async (args) => {
        if (!session) return;
        if (args) {
          const model = resolveModel(opts.config, opts.auth, args);
          await session.switchModel(model);
          await refreshHeader();
          return;
        }
        const choice = await app?.select(
          "Select model",
          opts.config.models.map((model) => ({
            label: model.ref ?? `${model.provider}/${model.id}`,
            value: model.ref ?? `${model.provider}/${model.id}`,
          })),
        );
        if (!choice) return;
        const model = resolveModel(opts.config, opts.auth, choice);
        await session.switchModel(model);
        await refreshHeader();
      },
    },
    {
      name: "theme",
      description: "Switch theme",
      run: async (args) => {
        const names = ["dark", "light", "tokyo-night"] as const;
        const current = opts.config.tui.theme;
        const next = args
          ? names.find((name) => name === args)
          : names[(names.indexOf(current) + 1) % names.length];
        if (!next) {
          app?.notify(`Unknown theme: ${args}`, "warn");
          return;
        }
        opts.config.tui.theme = next;
        app?.setTheme(getTheme(next));
        await writeJsonAtomic(configPath(opts.home), opts.config);
      },
    },
    {
      name: "keys",
      description: "Show keybindings",
      run: () => {
        if (!app) return;
        const lines = app
          .getKeybindings()
          .list()
          .map((binding) => `${binding.action}: ${binding.keys.join(", ")}`)
          .join("\n");
        app.notify(lines);
      },
    },
    {
      name: "skills",
      description: "Manage skills",
      run: async () => {
        if (!session) return;
        if (session.agent.state.isStreaming) {
          app?.notify("Cannot manage skills while running", "warn");
          return;
        }
        for (;;) {
          const skills = opts.resources.cached?.skills ?? [];
          if (skills.length === 0) {
            app?.notify("No skills found", "warn");
            return;
          }
          const name = await app?.select(
            "Skills",
            skills.map((skill) => ({
              label: `[${skill.disableModelInvocation ? "off" : "on"}] ${skill.name} — ${skill.description}`,
              value: skill.name,
            })),
          );
          if (!name) return;
          const skill = skills.find((candidate) => candidate.name === name);
          if (!skill) return;
          const action = await app?.select(`Skill: ${name}`, [
            {
              label: skill.disableModelInvocation
                ? "Enable model invocation"
                : "Disable model invocation",
              value: "toggle",
            },
            { label: "Show path", value: "path" },
            { label: "Reload skills", value: "reload" },
          ]);
          if (!action) return;
          if (action === "toggle") {
            await opts.resources.setSkillDisabled(name, !skill.disableModelInvocation);
            await session.reload();
            app?.notify(
              `${skill.disableModelInvocation ? "Enabled" : "Disabled"} ${name} for model invocation`,
            );
          } else if (action === "path") {
            app?.notify(skill.path);
          } else if (action === "reload") {
            await session.reload();
            app?.notify("Skills reloaded");
          }
        }
      },
    },
    {
      name: "permissions",
      description: "Manage persistent write allowlist",
      run: async (args) => {
        const body = args.trim();
        const space = body.indexOf(" ");
        const action = space < 0 ? body || "list" : body.slice(0, space);
        const rule = space < 0 ? "" : body.slice(space + 1).trim();
        const rules = opts.config.permissions.allowWrite;
        if (action === "list") {
          app?.notify(
            rules.length === 0
              ? "No persistent write rules"
              : `Persistent write rules:\n${rules.map((item) => `  ${item}`).join("\n")}`,
          );
          return;
        }
        if (action === "add") {
          if (!rule) {
            app?.notify("Usage: /permissions add <glob>", "warn");
            return;
          }
          if (rules.includes(rule)) {
            app?.notify(`Already allowed: ${rule}`);
            return;
          }
          rules.push(rule);
        } else if (action === "remove") {
          if (!rule) {
            app?.notify("Usage: /permissions remove <glob>", "warn");
            return;
          }
          const index = rules.indexOf(rule);
          if (index < 0) {
            app?.notify(`Rule not found: ${rule}`, "warn");
            return;
          }
          rules.splice(index, 1);
        } else if (action === "reset") {
          rules.length = 0;
        } else {
          app?.notify("Usage: /permissions list|add|remove|reset", "warn");
          return;
        }
        await writeJsonAtomic(configPath(opts.home), opts.config);
        policy.setAllowWrite(rules);
        app?.notify(
          action === "add"
            ? `Allowed writes: ${rule}${opts.yolo ? " (yolo is enabled)" : ""}`
            : action === "remove"
              ? `Removed write rule: ${rule}`
              : "Reset persistent write rules",
        );
      },
    },
    {
      name: "yolo",
      description: "Toggle YOLO mode for this session",
      run: (args) => {
        const value = args.trim().toLowerCase();
        if (value && !["on", "off", "true", "false", "1", "0", "yes", "no"].includes(value)) {
          app?.notify("Usage: /yolo [on|off]", "warn");
          return;
        }
        const enabled = value
          ? ["on", "true", "1", "yes"].includes(value)
          : !policy.yolo;
        policy.setYolo(enabled);
        app?.setYolo(enabled);
        app?.notify(
          enabled
            ? "YOLO enabled: write and command confirmations are bypassed"
            : "YOLO disabled: confirmations restored",
          enabled ? "warn" : "info",
        );
      },
    },
    {
      name: "mcp",
      description: "Show MCP server status",
      run: () => {
        const status = opts.mcp.getStatus();
        app?.notify(
          status.length === 0
            ? "No MCP servers"
            : status
                .map((server) => `${server.name}: ${server.connected ? `${server.toolCount} tools` : server.error ?? "disconnected"}`)
                .join("\n"),
        );
      },
    },
    {
      name: "reload",
      description: "Reload resources, MCP, and extensions",
      run: async () => {
        if (!session) return;
        if (session.agent.state.isStreaming) {
          app?.notify("Cannot /reload while running", "warn");
          return;
        }
        await session.reload();
        app?.notify("Reloaded");
      },
    },
  ];

  for (const skill of opts.resources.cached?.skills ?? []) {
    commands.push({
      name: `skill:${skill.name}`,
      description: skill.description,
      run: async (args) => {
        if (!session) return;
        const content = await readFile(skill.path, "utf8");
        await session.prompt(
          `<skill name="${skill.name}" path="${skill.path}">\n${content}\n</skill>\n\n${args}`,
        );
      },
    });
  }
  for (const prompt of opts.resources.cached?.prompts ?? []) {
    commands.push({
      name: prompt.name,
      description: prompt.description,
      run: async (args) => {
        if (!session) return;
        await session.prompt(expandTemplate(prompt.template, args));
      },
    });
  }
  for (const command of opts.extensions.getCommands()) {
    commands.push({
      name: command.name,
      description: command.description,
      run: (args) =>
        command.run(args, { notify: (message) => app?.notify(message) }),
    });
  }

  const done = Promise.withResolvers<void>();
  const keybindings = new KeybindingsManager(opts.config.tui.keybindings);
  app = new TuiApp({
    header: "cletus",
    theme: getTheme(opts.config.tui.theme),
    keybindings,
    submit: async (text) => {
      if (!session) return;
      await refreshHeader();
      if (session.agent.state.isStreaming) {
        session.steer(text);
        return;
      }
      app?.setStatus({
        busy: true,
        model: session.model.ref ?? session.model.id,
        tokens: "",
        queue: session.agent.queuedMessageCount,
        activity: "thinking",
        context: contextLabel(session),
      });
      try {
        await session.prompt(text);
      } finally {
        app?.setStatus({
          busy: false,
          model: session.model.ref ?? session.model.id,
          tokens: "",
          queue: session.agent.queuedMessageCount,
          context: contextLabel(session),
        });
      }
    },
    followUp: (text) => session?.followUp(text),
    abort: () => session?.abort(),
    commands,
    history: [],
    onExit: () => done.resolve(),
  });

  await attach(opts.manager);
  await app.start();
  app.setYolo(opts.yolo);
  if (session) {
    app.setStatus({
      busy: false,
      model: session.model.ref ?? session.model.id,
      tokens: "",
      queue: 0,
      context: contextLabel(session),
    });
  }
  void opts.mcp
    .start()
    .then(() => {
      session?.refreshTools();
      const tools = opts.mcp.getTools().length;
      if (tools > 0) app?.notify(`MCP ready · ${tools} tools`);
    })
    .catch((error: unknown) => {
      app?.notify(
        `MCP startup failed: ${error instanceof Error ? error.message : String(error)}`,
        "warn",
      );
    });
  await done.promise;
  unsubscribe?.();
  await session?.dispose();
  return 0;
}

async function runPrint(opts: {
  cwd: string;
  home: string;
  config: CletusConfig;
  auth: AuthStore;
  model: Model;
  manager: SessionManager;
  resources: ResourceLoader;
  mcp: McpManager;
  extensions: ExtensionHost;
  prompt: string;
  json: boolean;
  yolo: boolean;
}): Promise<number> {
  const policy = new PermissionPolicy({
    cwd: opts.cwd,
    readOnlyRoots: opts.resources.cached?.readOnlyRoots ?? [],
    allowWrite: opts.config.permissions.allowWrite,
    yolo: opts.yolo,
    interactive: false,
  });
  const session = await createSessionFor({
    ...opts,
    policy,
    onNotice: (text) => process.stderr.write(`${text}\n`),
  });
  let printed = "";
  let stopReason = "stop";
  const serialize = (event: AgentEvent): string => {
    const seen = new WeakSet<object>();
    try {
      return JSON.stringify(event, (_key, value: unknown) => {
        if (typeof value === "function") return "[unserializable]";
        if (value && typeof value === "object") {
          if (seen.has(value)) return "[unserializable]";
          seen.add(value);
        }
        return value;
      });
    } catch {
      return JSON.stringify({ type: "error", message: "Failed to serialize event" });
    }
  };
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn_end") stopReason = event.message.stopReason;
    if (opts.json) {
      process.stdout.write(`${serialize(event)}\n`);
      return;
    }
    if (event.type === "message_update" && event.delta.type === "text") {
      printed += event.delta.text;
      process.stdout.write(event.delta.text);
    } else if (event.type === "tool_execution_start") {
      process.stderr.write(`[tool] ${event.toolName} ${JSON.stringify(event.args)}\n`);
    } else if (event.type === "tool_execution_end" && event.result.isError) {
      const text = event.result.content.map((block) => block.text).join("");
      process.stderr.write(`[tool error] ${text}\n`);
    }
  });
  try {
    await session.prompt(opts.prompt);
    const final = session.getLastAssistantText();
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ type: "result", text: final, stopReason })}\n`,
      );
    } else if (final.startsWith(printed)) {
      process.stdout.write(final.slice(printed.length));
    } else if (!printed && final) {
      process.stdout.write(final);
    }
    process.stdout.write("\n");
    return stopReason === "aborted" ? 130 : stopReason === "error" ? 1 : 0;
  } finally {
    unsubscribe();
    await session.dispose();
  }
}

async function mcpCommand(argv: string[]): Promise<number> {
  const action = argv[0];
  const rest = argv.slice(1);
  const cwd = process.cwd();
  const home = cletusHome();
  const localFlag = rest.includes("--local");
  const path = localFlag ? join(cwd, ".cletus", "mcp.json") : join(home, "mcp.json");
  if (action === "list") {
    const configs = await loadMcpConfig(cwd, home, true);
    for (const [name, config] of Object.entries(configs)) {
      process.stdout.write(`${name}\t${config.command ?? config.url ?? ""}\n`);
    }
    return 0;
  }
  if (action === "add") {
    const name = rest.find((value) => !value.startsWith("-"));
    if (!name) throw new ConfigError("Usage: cletus mcp add <name> [--local] -- <command...>");
    const terminator = rest.indexOf("--");
    const commandArgs = terminator >= 0 ? rest.slice(terminator + 1) : [];
    const urlIndex = rest.indexOf("--url");
    const url = urlIndex >= 0 ? rest[urlIndex + 1] : undefined;
    const headers: Record<string, string> = {};
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === "--header") {
        const pair = rest[index + 1] ?? "";
        const eq = pair.indexOf("=");
        if (eq > 0) headers[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
    }
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    } catch {
      config = {};
    }
    const servers = asRecord(config["mcpServers"]);
    if (url) {
      servers[name] = { url, ...(Object.keys(headers).length ? { headers } : {}) };
    } else {
      if (commandArgs.length === 0) throw new ConfigError("mcp add requires a command after --");
      servers[name] = { command: commandArgs[0], args: commandArgs.slice(1) };
    }
    config["mcpServers"] = servers;
    await mkdir(dirname(path), { recursive: true });
    await writeJsonAtomic(path, config);
    return 0;
  }
  if (action === "remove") {
    const name = rest.find((value) => !value.startsWith("-"));
    if (!name) throw new ConfigError("Usage: cletus mcp remove <name> [--local]");
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    } catch {
      return 0;
    }
    const servers = asRecord(config["mcpServers"]);
    delete servers[name];
    config["mcpServers"] = servers;
    await writeJsonAtomic(path, config);
    return 0;
  }
  throw new ConfigError("Usage: cletus mcp add|list|remove");
}

async function sessionsCommand(argv: string[]): Promise<number> {
  if (argv[0] !== "list") throw new ConfigError("Usage: cletus sessions list");
  const infos = await SessionManager.list(process.cwd(), { home: cletusHome() });
  if (infos.length === 0) {
    process.stdout.write("No sessions\n");
    return 0;
  }
  for (const info of infos) {
    process.stdout.write(
      `${info.id}\t${info.timestamp}\t${info.messageCount}\t${info.firstUserText.replace(/\s+/g, " ").slice(0, 80)}\n`,
    );
  }
  return 0;
}

async function skillsCommand(argv: string[]): Promise<number> {
  const action = argv[0];
  const loader = new ResourceLoader(process.cwd(), cletusHome());
  const loaded = await loader.load();
  if (action === "list") {
    if (loaded.skills.length === 0) {
      process.stdout.write("No skills\n");
      return 0;
    }
    for (const skill of loaded.skills) {
      process.stdout.write(
        `${skill.disableModelInvocation ? "off" : "on"}\t${skill.name}\t${skill.path}\t${skill.description}\n`,
      );
    }
    return 0;
  }
  if (action === "enable" || action === "disable") {
    const name = argv[1];
    if (!name) throw new ConfigError(`Usage: cletus skills ${action} <name>`);
    await loader.setSkillDisabled(name, action === "disable");
    process.stdout.write(`${action === "enable" ? "Enabled" : "Disabled"} ${name}\n`);
    return 0;
  }
  throw new ConfigError("Usage: cletus skills list|enable|disable");
}

async function permissionsCommand(argv: string[]): Promise<number> {
  const home = cletusHome();
  const config = await loadConfig(home);
  const action = argv[0] ?? "list";
  const rule = argv.slice(1).join(" ").trim();
  const rules = config.permissions.allowWrite;
  if (action === "list") {
    if (rules.length === 0) process.stdout.write("No persistent write rules\n");
    else for (const item of rules) process.stdout.write(`${item}\n`);
    return 0;
  }
  if (action === "add") {
    if (!rule) throw new ConfigError("Usage: cletus permissions add <glob>");
    if (rules.includes(rule)) {
      process.stdout.write(`Already allowed: ${rule}\n`);
      return 0;
    }
    rules.push(rule);
  } else if (action === "remove") {
    if (!rule) throw new ConfigError("Usage: cletus permissions remove <glob>");
    const index = rules.indexOf(rule);
    if (index < 0) throw new ConfigError(`Rule not found: ${rule}`);
    rules.splice(index, 1);
  } else if (action === "reset") {
    rules.length = 0;
  } else {
    throw new ConfigError("Usage: cletus permissions list|add|remove|reset");
  }
  await writeJsonAtomic(configPath(home), config);
  process.stdout.write(
    `${action === "add" ? "Allowed" : action === "remove" ? "Removed" : "Reset"} ${rule || "write rules"}\n`,
  );
  return 0;
}

async function importCommand(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      from: { type: "string" },
      force: { type: "boolean" },
    },
  });
  const report = await importPi({
    home: cletusHome(),
    ...(parsed.values.from ? { piHome: parsed.values.from } : {}),
    force: parsed.values.force === true,
  });
  process.stdout.write(
    `Imported ${report.providers} providers, ${report.models} models; default ${report.defaultModel ?? "(none)"}\n`,
  );
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "mcp") return mcpCommand(argv.slice(1));
  if (argv[0] === "sessions") return sessionsCommand(argv.slice(1));
  if (argv[0] === "skills") return skillsCommand(argv.slice(1));
  if (argv[0] === "permissions") return permissionsCommand(argv.slice(1));
  if (argv[0] === "import-pi") return importCommand(argv.slice(1));

  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      print: { type: "boolean", short: "p" },
      json: { type: "boolean" },
      model: { type: "string" },
      resume: { type: "string" },
      continue: { type: "boolean" },
      yolo: { type: "boolean" },
      trust: { type: "boolean" },
      "no-extensions": { type: "boolean" },
      cwd: { type: "string" },
      version: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (parsed.values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (parsed.values.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }

  const cwd = resolve(parsed.values.cwd ?? process.cwd());
  const home = cletusHome();
  let config = await loadConfig(home);
  let auth = await loadAuth(authPath(home));
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !parsed.values.print && !parsed.values.json;
  const prompt = parsed.positionals.join(" ").trim();

  if (config.models.length === 0) {
    if (interactive) {
      if (await askYesNo("Import pi models from ~/.pi?")) {
        await importPi({ home });
        config = await loadConfig(home);
        auth = await loadAuth(authPath(home));
      }
    }
    if (config.models.length === 0) {
      process.stderr.write("No models configured. Run: cletus import-pi\n");
      return 2;
    }
  }

  const model = resolveModel(config, auth, parsed.values.model);
  const trustProject = await decideTrust(cwd, home, interactive, parsed.values.trust === true);
  const resources = new ResourceLoader(cwd, home);
  await resources.load();

  const extensions = new ExtensionHost({
    cwd,
    home,
    trustProject,
    builtinToolNames: BUILTIN_TOOLS,
    builtinCommands: BUILTIN_COMMANDS,
    notify: (text, level) => process.stderr.write(`${text}\n`),
  });
  if (!parsed.values["no-extensions"]) await extensions.load();
  const mcp = await McpManager.create(cwd, home, { trustProject });

  let manager: SessionManager;
  if (parsed.values.resume) {
    const infos = await SessionManager.list(cwd, { home });
    const found = infos.find((info) => info.id === parsed.values.resume || info.filePath === parsed.values.resume);
    if (!found) throw new ConfigError(`Session not found: ${parsed.values.resume}`);
    manager = await SessionManager.open(found.filePath);
  } else if (parsed.values.continue) {
    const infos = await SessionManager.list(cwd, { home });
    const latest = infos[0];
    if (!latest) throw new ConfigError("No sessions to continue");
    manager = await SessionManager.open(latest.filePath);
  } else {
    manager = await SessionManager.create(cwd, { home });
  }

  try {
    if (parsed.values.json || parsed.values.print || (!process.stdout.isTTY && prompt)) {
      if (!prompt) throw new ConfigError("No prompt and stdin is not a TTY");
      await mcp.start();
      return await runPrint({
        cwd,
        home,
        config,
        auth,
        model,
        manager,
        resources,
        mcp,
        extensions,
        prompt,
        json: parsed.values.json === true,
        yolo: parsed.values.yolo === true,
      });
    }
    if (!interactive) throw new ConfigError("No prompt and stdin is not a TTY");
    return await runTui({
      cwd,
      home,
      config,
      auth,
      model,
      manager,
      resources,
      mcp,
      extensions,
      yolo: parsed.values.yolo === true,
    });
  } finally {
    await mcp.dispose();
    await extensions.dispose();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = error instanceof ConfigError ? 2 : 1;
  });