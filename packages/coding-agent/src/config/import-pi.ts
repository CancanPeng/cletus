import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  ConfigError,
  authPath,
  configPath,
  createDefaultConfig,
  loadAuth,
  type AuthStore,
  type CletusConfig,
  writeJsonAtomic,
} from "../config.js";

export type ImportReport = {
  configPath: string;
  authPath: string;
  providers: number;
  models: number;
  defaultModel?: string;
  skipped: string[];
};

type PiModel = {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
};

type PiProvider = {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: PiModel[];
};

type PiModels = { providers?: Record<string, PiProvider> };

type PiSettings = {
  defaultProvider?: string;
  defaultModel?: string;
  theme?: string;
  packages?: unknown;
  lastChangelogVersion?: string;
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readPiJson<T>(path: string): Promise<T> {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ConfigError(
      `Invalid pi config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function importPi(opts: {
  home: string;
  piHome?: string;
  force?: boolean;
}): Promise<ImportReport> {
  const piHome = opts.piHome ?? join(homedir(), ".pi");
  const modelsPath = join(piHome, "agent", "models.json");
  const settingsPath = join(piHome, "agent", "settings.json");
  const targetConfig = configPath(opts.home);
  const targetAuth = authPath(opts.home);

  if (!(await exists(modelsPath))) {
    throw new ConfigError(`Pi config not found: ${modelsPath}`);
  }
  if ((await exists(targetConfig)) && !opts.force) {
    throw new ConfigError(`Config already exists: ${targetConfig}; use --force`);
  }

  const piModels = await readPiJson<PiModels>(modelsPath);
  const settings = (await exists(settingsPath))
    ? await readPiJson<PiSettings>(settingsPath)
    : {};

  const config: CletusConfig = createDefaultConfig();
  const auth: AuthStore = { keys: {} };
  if (await exists(targetAuth)) {
    // Merge existing keys even with --force so re-imports never drop them.
    const existing = await loadAuth(targetAuth);
    Object.assign(auth.keys, existing.keys);
  }

  const skipped: string[] = [];
  let importedProviders = 0;
  const importedRefs = new Set<string>();

  for (const [providerName, provider] of Object.entries(piModels.providers ?? {})) {
    const api = provider.api;
    if (api !== "anthropic-messages" && api !== "openai-completions") {
      skipped.push(`${providerName}: unsupported api ${api ?? "(missing)"}`);
      continue;
    }
    const targetProvider = api === "anthropic-messages" ? "anthropic" : "openai";
    let providerImported = false;

    for (const model of provider.models ?? []) {
      if (!model.id) {
        skipped.push(`${providerName}: model without id`);
        continue;
      }
      const ref = `${providerName}/${model.id}`;
      if (model.input?.includes("image")) {
        skipped.push(`${ref}: image input ignored`);
      }
      const entry: CletusConfig["models"][number] = {
        provider: targetProvider,
        id: model.id,
        ref,
        contextWindow: model.contextWindow ?? 128000,
        maxOutputTokens: model.maxTokens ?? 8192,
      };
      if (model.name !== undefined) entry.name = model.name;
      if (model.reasoning !== undefined) entry.supportsThinking = model.reasoning;
      if (provider.baseUrl !== undefined) entry.baseUrl = provider.baseUrl;

      const apiKey = provider.apiKey;
      if (apiKey?.startsWith("$")) {
        entry.apiKeyEnv = apiKey.slice(1);
      } else if (apiKey) {
        auth.keys[providerName] = apiKey;
        entry.apiKeyId = providerName;
      }
      config.models.push(entry);
      importedRefs.add(ref);
      providerImported = true;
    }
    if (providerImported) importedProviders += 1;
  }

  let defaultModel: string | undefined;
  if (settings.defaultProvider && settings.defaultModel) {
    const ref = `${settings.defaultProvider}/${settings.defaultModel}`;
    if (importedRefs.has(ref)) defaultModel = ref;
  }
  if (!defaultModel) {
    const first = config.models[0];
    if (first) defaultModel = first.ref ?? `${first.provider}/${first.id}`;
  }
  if (defaultModel) config.defaultModel = defaultModel;

  if (settings.theme !== undefined) skipped.push("settings.theme");
  if (settings.packages !== undefined) skipped.push("settings.packages");
  if (settings.lastChangelogVersion !== undefined) skipped.push("settings.lastChangelogVersion");

  await writeJsonAtomic(targetConfig, config);
  await writeJsonAtomic(targetAuth, auth, 0o600);

  const report: ImportReport = {
    configPath: targetConfig,
    authPath: targetAuth,
    providers: importedProviders,
    models: config.models.length,
    skipped,
  };
  if (defaultModel !== undefined) report.defaultModel = defaultModel;
  return report;
}