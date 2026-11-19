import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig, loadConfig, resolveModel, type CletusConfig } from "../src/config.js";

function config(): CletusConfig {
  return {
    providers: {
      openai: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" },
      anthropic: { baseUrl: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY" },
    },
    models: [
      {
        provider: "anthropic",
        id: "deepseek-v4.1-flash-1017",
        ref: "aliyun-token-plan/deepseek-v4.1-flash-1017",
        baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
        apiKeyId: "aliyun-token-plan",
        contextWindow: 983616,
        maxOutputTokens: 32768,
      },
    ],
    compaction: { reserveTokens: 16384, keepRecentTokens: 20000 },
    maxTurns: 500,
    maxAutoContinues: 3,
    webSearch: { enabled: false, order: [], timeoutSeconds: 30 },
    skillOverrides: {},
    permissions: { allowWrite: [] },
    tui: {
      showThinking: false,
      theme: "dark",
      keybindings: {},
      symbols: { preset: "nerd", overrides: {} },
    },
    defaultModel: "aliyun-token-plan/deepseek-v4.1-flash-1017",
  };
}

describe("resolveModel", () => {
  it("resolves a model by its ref", () => {
    const model = resolveModel(config(), { keys: {} }, "aliyun-token-plan/deepseek-v4.1-flash-1017");
    expect(model.ref).toBe("aliyun-token-plan/deepseek-v4.1-flash-1017");
  });

  // The bash tool exports CLETUS_MODEL as `${provider}/${id}`, and nested
  // cletus runs read it back. If that form does not resolve, every resume
  // started from inside a cletus session dies with "Unknown model".
  it("resolves a model by provider/id", () => {
    const model = resolveModel(config(), { keys: {} }, "anthropic/deepseek-v4.1-flash-1017");
    expect(model.ref).toBe("aliyun-token-plan/deepseek-v4.1-flash-1017");
  });

  it("resolves a model by bare id", () => {
    const model = resolveModel(config(), { keys: {} }, "deepseek-v4.1-flash-1017");
    expect(model.ref).toBe("aliyun-token-plan/deepseek-v4.1-flash-1017");
  });

  it("still rejects an unknown reference", () => {
    expect(() => resolveModel(config(), { keys: {} }, "nope/nope")).toThrow(/Unknown model/);
  });

  it("passes supportsImages through resolveModel", () => {
    const cfg = config();
    cfg.models.push({
      provider: "openai",
      id: "no-vision",
      contextWindow: 100000,
      maxOutputTokens: 1000,
      supportsImages: false,
    });
    expect(resolveModel(cfg, { keys: {} }, "openai/no-vision").supportsImages).toBe(false);
    expect(
      resolveModel(cfg, { keys: {} }, "aliyun-token-plan/deepseek-v4.1-flash-1017").supportsImages,
    ).toBeUndefined();
  });

  it("agentOverrides defaults and merges", async () => {
    expect(createDefaultConfig().agentOverrides).toEqual({});
    const home = await mkdtemp(join(tmpdir(), "cletus-cfg-"));
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ agentOverrides: { explore: "off" } }),
      "utf8",
    );
    const cfg = await loadConfig(home);
    expect(cfg.agentOverrides).toEqual({ explore: "off" });
  });
});