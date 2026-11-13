import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importPi } from "../src/config/import-pi.js";
import { loadConfig, loadAuth, resolveApiKey } from "../src/config.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cletus-import-"));
  dirs.push(dir);
  return dir;
}

async function fixture(): Promise<{ home: string; piHome: string }> {
  const home = await temp();
  const piHome = await temp();
  await mkdir(join(piHome, "agent"), { recursive: true });
  await writeFile(
    join(piHome, "agent", "models.json"),
    JSON.stringify({
      providers: {
        local: {
          baseUrl: "http://localhost:1234",
          api: "openai-completions",
          apiKey: "sk-literal-secret",
          models: [{ id: "model-a", name: "Model A", contextWindow: 32000, maxTokens: 2048 }],
        },
        cloud: {
          baseUrl: "http://localhost:1235",
          api: "anthropic-messages",
          apiKey: "$CLOUD_KEY",
          models: [{ id: "model-b", reasoning: true, input: ["text", "image"] }],
        },
      },
    }),
  );
  await writeFile(
    join(piHome, "agent", "settings.json"),
    JSON.stringify({ defaultProvider: "local", defaultModel: "model-a", theme: "tokyo-night" }),
  );
  return { home, piHome };
}

describe("importPi", () => {
  it("maps models and keeps literal keys out of config", async () => {
    const { home, piHome } = await fixture();
    const report = await importPi({ home, piHome });
    expect(report.models).toBe(2);
    expect(report.defaultModel).toBe("local/model-a");
    const configText = await readFile(join(home, "config.json"), "utf8");
    expect(configText).not.toContain("sk-literal-secret");
    const auth = await loadAuth(join(home, "auth.json"));
    expect(auth.keys["local"]).toBe("sk-literal-secret");
    const mode = (await stat(join(home, "auth.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
    const config = await loadConfig(home);
    expect(config.models.find((model) => model.ref === "cloud/model-b")?.apiKeyEnv).toBe(
      "CLOUD_KEY",
    );
  });

  it("refuses to overwrite without --force and resolves env first", async () => {
    const { home, piHome } = await fixture();
    await importPi({ home, piHome });
    await expect(importPi({ home, piHome })).rejects.toThrow("Config already exists");
    const config = await loadConfig(home);
    const auth = await loadAuth(join(home, "auth.json"));
    const model = config.models.find((candidate) => candidate.ref === "local/model-a");
    expect(model).toBeTruthy();
    process.env["TEST_KEY"] = "from-env";
    const resolved = resolveApiKey(
      config,
      auth,
      {
        provider: "openai",
        id: "model-a",
        baseUrl: "x",
        contextWindow: 1,
        maxOutputTokens: 1,
        apiKeyEnv: "TEST_KEY",
        apiKeyId: "local",
      },
    );
    expect(resolved).toBe("from-env");
  });

  it("keeps unrelated auth keys when re-importing with --force", async () => {
    const { home, piHome } = await fixture();
    await importPi({ home, piHome });
    const authFile = join(home, "auth.json");
    const auth = JSON.parse(await readFile(authFile, "utf8")) as { keys: Record<string, string> };
    auth.keys["manual-provider"] = "sk-manual";
    await writeFile(authFile, JSON.stringify(auth));
    await importPi({ home, piHome, force: true });
    const merged = await loadAuth(authFile);
    expect(merged.keys["manual-provider"]).toBe("sk-manual");
    expect(merged.keys["local"]).toBe("sk-literal-secret");
  });
});