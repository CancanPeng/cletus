import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type McpServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
  enabled?: boolean;
};

export type McpConfig = { mcpServers: Record<string, McpServerConfig> };

function substitute(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const result = process.env[name];
    if (result === undefined) {
      process.stderr.write(`Warning: MCP env var ${name} is not set\n`);
      return "";
    }
    return result;
  });
}

function normalize(raw: McpServerConfig): McpServerConfig {
  const config: McpServerConfig = { ...raw };
  if (config.command !== undefined) config.command = substitute(config.command);
  if (config.args) config.args = config.args.map(substitute);
  if (config.cwd !== undefined) config.cwd = substitute(config.cwd);
  if (config.url !== undefined) config.url = substitute(config.url);
  if (config.env) {
    config.env = Object.fromEntries(
      Object.entries(config.env).map(([key, value]) => [key, substitute(value)]),
    );
  }
  if (config.headers) {
    config.headers = Object.fromEntries(
      Object.entries(config.headers).map(([key, value]) => [key, substitute(value)]),
    );
  }
  return config;
}

async function readConfig(path: string): Promise<McpConfig> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as McpConfig;
    return parsed && typeof parsed === "object" ? parsed : { mcpServers: {} };
  } catch {
    return { mcpServers: {} };
  }
}

export async function loadMcpConfig(
  cwd: string,
  home: string,
  trustProject: boolean,
): Promise<Record<string, McpServerConfig>> {
  const user = await readConfig(join(home, "mcp.json"));
  const project = trustProject ? await readConfig(join(cwd, ".cletus", "mcp.json")) : { mcpServers: {} };
  const merged: Record<string, McpServerConfig> = { ...user.mcpServers };
  for (const [name, config] of Object.entries(project.mcpServers)) {
    merged[name] = { ...(merged[name] ?? {}), ...config };
  }
  const valid: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(merged)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      process.stderr.write(`Warning: invalid MCP server name: ${name}\n`);
      continue;
    }
    if (config.enabled === false) continue;
    if (!config.command && !config.url) {
      process.stderr.write(`Warning: MCP server ${name} has neither command nor url\n`);
      continue;
    }
    valid[name] = normalize(config);
  }
  return valid;
}