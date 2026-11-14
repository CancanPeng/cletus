import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
export type SkillVisibility = "on" | "name-only" | "user-invocable-only" | "off";

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
  /** Turns before the agent stops for breath; it auto-continues past this. */
  maxTurns: number;
  /** Extra turn batches granted each time `maxTurns` is reached. */
  maxAutoContinues: number;
  webSearch: WebSearchConfig;
  skillOverrides: Record<string, SkillVisibility>;
  permissions: { allowWrite: string[] };
  tui: {
    showThinking: boolean;
    theme: "dark" | "light" | "tokyo-night";
    keybindings: Record<string, string | string[]>;
    symbols: {
      preset: "unicode" | "nerd" | "ascii";
      overrides: Record<string, string>;
    };
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
    maxTurns: 500,
    maxAutoContinues: 3,
    webSearch: {
      enabled: true,
      order: ["parallel", "exa", "firecrawl", "brave", "tavily", "searxng", "duckduckgo"],
      timeoutSeconds: 30,
    },
    skillOverrides: {},
    permissions: { allowWrite: [] },
    tui: {
      showThinking: true,
      theme: "dark",
      keybindings: {},
      symbols: { preset: "nerd", overrides: {} },
    },
  };
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  mode?: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    // Create with the final mode so secrets are never world-readable,
    // even briefly, and clean up the temp file on failure.
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      ...(mode !== undefined ? { mode } : {}),
    });
    if (mode !== undefined) await chmod(temp, mode);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config must be a JSON object");
    }
    if (parsed.models !== undefined && !Array.isArray(parsed.models)) {
      throw new Error("config.models must be an array");
    }
    const defaults = createDefaultConfig();
    return {
      ...defaults,
      ...parsed,
      providers: {
        openai: { ...defaults.providers.openai, ...parsed.providers?.openai },
        anthropic: { ...defaults.providers.anthropic, ...parsed.providers?.anthropic },
      },
      compaction: { ...createDefaultConfig().compaction, ...parsed.compaction },
      webSearch: { ...createDefaultConfig().webSearch, ...parsed.webSearch },
      skillOverrides: { ...createDefaultConfig().skillOverrides, ...parsed.skillOverrides },
      permissions: { ...createDefaultConfig().permissions, ...parsed.permissions },
      tui: {
        ...createDefaultConfig().tui,
        ...parsed.tui,
        symbols: {
          ...createDefaultConfig().tui.symbols,
          ...parsed.tui?.symbols,
          overrides: {
            ...createDefaultConfig().tui.symbols.overrides,
            ...parsed.tui?.symbols?.overrides,
          },
        },
      },
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

/**
 * Accepts every spelling a model is referred to by: the configured `ref`,
 * `provider/id`, or a bare `id`. The bash tool exports `CLETUS_MODEL` as
 * `provider/id`, so nested cletus runs depend on that form resolving.
 */
function findModel(
  config: CletusConfig,
  wanted: string,
  keyOf: (model: CletusConfig["models"][number]) => string,
): CletusConfig["models"][number] | undefined {
  const byRef = config.models.find((model) => keyOf(model) === wanted);
  if (byRef) return byRef;
  const byProvider = config.models.find(
    (model) => `${model.provider}/${model.id}` === wanted,
  );
  if (byProvider) return byProvider;
  const byId = config.models.filter((model) => model.id === wanted);
  if (byId.length === 1) return byId[0];
  if (byId.length > 1) {
    const refs = byId.map((model) => keyOf(model)).join(", ");
    throw new ConfigError(`Ambiguous model: ${wanted} (matches ${refs})`);
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
  const source = wanted ? findModel(config, wanted, keyOf) : config.models[0];
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
  if (source.supportsImages !== undefined) model.supportsImages = source.supportsImages;
  return model;
}