import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Model } from "@cletus/ai";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type CompactionConfig = { reserveTokens: number; keepRecentTokens: number };
export type WebSearchConfig = {
  enabled: boolean;
  order: string[];
  timeoutSeconds: number;
};

export type CletusConfig = {
  defaultModel?: string;
  providers: Record<"openai" | "anthropic", { baseUrl: string; apiKeyEnv?: string }>;
  models: Array<
    Omit<Model, "baseUrl" | "apiKeyEnv" | "apiKeyId"> & {
      baseUrl?: string;
      apiKeyEnv?: string;
      apiKeyId?: string;
    }
  >;
  compaction: CompactionConfig;
  webSearch: WebSearchConfig;
  permissions: { allowWrite: string[] };
  tui: {
    showThinking: boolean;
    theme: "dark" | "light" | "tokyo-night";
    keybindings: Record<string, string | string[]>;
  };
};

export type AuthStore = { keys: Record<string, string> };

export function cletusHome(): string {
  return process.env["CLETUS_HOME"] ?? join(homedir(), ".cletus");
}

export function configPath(home = cletusHome()): string {
  return join(home, "config.json");
}

export function authPath(home = cletusHome()): string {
  return join(home, "auth.json");
}

export function createDefaultConfig(): CletusConfig {
  return {
    providers: {
      openai: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" },
      anthropic: {
        baseUrl: "https://api.anthropic.com",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      },
    },
    models: [],
    compaction: { reserveTokens: 16384, keepRecentTokens: 20000 },
    webSearch: {
      enabled: true,
      order: ["brave", "tavily", "searxng", "duckduckgo"],
      timeoutSeconds: 30,
    },
    permissions: { allowWrite: [] },
    tui: { showThinking: true, theme: "dark", keybindings: {} },
  };
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  mode?: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (mode !== undefined) await chmod(temp, mode);
  await rename(temp, path);
}

export async function loadConfig(home = cletusHome(), path = configPath(home)): Promise<CletusConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const config = createDefaultConfig();
    await writeJsonAtomic(path, config);
    return config;
  }
  try {
    const parsed = JSON.parse(text) as CletusConfig;
    return {
      ...createDefaultConfig(),
      ...parsed,
      providers: { ...createDefaultConfig().providers, ...parsed.providers },
      compaction: { ...createDefaultConfig().compaction, ...parsed.compaction },
      webSearch: { ...createDefaultConfig().webSearch, ...parsed.webSearch },
      permissions: { ...createDefaultConfig().permissions, ...parsed.permissions },
      tui: { ...createDefaultConfig().tui, ...parsed.tui },
    };
  } catch (error) {
    throw new ConfigError(
      `Invalid config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function loadAuth(path = authPath()): Promise<AuthStore> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { keys: {} };
  }
  let parsed: AuthStore;
  try {
    parsed = JSON.parse(text) as AuthStore;
  } catch (error) {
    throw new ConfigError(
      `Invalid auth file at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const info = await stat(path);
    if ((info.mode & 0o777) !== 0o600) await chmod(path, 0o600);
  } catch (error) {
    process.stderr.write(
      `Warning: could not secure ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  return { keys: parsed.keys ?? {} };
}

export function resolveApiKey(
  config: CletusConfig,
  auth: AuthStore,
  model: Model,
): string | undefined {
  if (model.apiKeyEnv) {
    const value = process.env[model.apiKeyEnv];
    if (value) return value;
  }
  if (model.apiKeyId) {
    const value = auth.keys[model.apiKeyId];
    if (value) return value;
  }
  const providerEnv = config.providers[model.provider]?.apiKeyEnv;
  if (providerEnv) {
    const value = process.env[providerEnv];
    if (value) return value;
  }
  return undefined;
}

export function resolveModel(
  config: CletusConfig,
  _auth: AuthStore,
  ref?: string,
): Model {
  if (config.models.length === 0) {
    throw new ConfigError(
      `No models configured. Run cletus import-pi or edit ${configPath()}.`,
    );
  }
  const wanted = ref ?? process.env["CLETUS_MODEL"] ?? config.defaultModel;
  const keyOf = (model: CletusConfig["models"][number]): string =>
    model.ref ?? `${model.provider}/${model.id}`;
  const source = wanted
    ? config.models.find((model) => keyOf(model) === wanted)
    : config.models[0];
  if (!source) throw new ConfigError(`Unknown model: ${wanted}`);
  const provider = source.provider;
  const baseUrl = source.baseUrl ?? config.providers[provider].baseUrl;
  const model: Model = {
    provider,
    id: source.id,
    ref: keyOf(source),
    baseUrl,
    contextWindow: source.contextWindow,
    maxOutputTokens: source.maxOutputTokens,
  };
  if (source.name !== undefined) model.name = source.name;
  if (source.apiKeyEnv !== undefined) model.apiKeyEnv = source.apiKeyEnv;
  if (source.apiKeyId !== undefined) model.apiKeyId = source.apiKeyId;
  if (source.supportsThinking !== undefined) model.supportsThinking = source.supportsThinking;
  if (source.thinkingLevel !== undefined) model.thinkingLevel = source.thinkingLevel;
  return model;
}