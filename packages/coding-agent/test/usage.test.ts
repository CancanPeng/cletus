import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@cletus/agent";
import { emptyUsage, type Model, type Usage } from "@cletus/ai";
import { SessionManager } from "../src/session/manager.js";
import { AgentSession } from "../src/session/session.js";
import {
  contextReport,
  summarizeUsage,
  type UsageStats,
} from "../src/session/usage.js";
import { createDefaultConfig } from "../src/config.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { ResourceLoader } from "../src/resources/index.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cletus-usage-"));
  dirs.push(dir);
  return dir;
}

const assistant = (
  usage: Usage,
  provider: "openai" | "anthropic" = "anthropic",
): AgentMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  provider,
  model: "fake",
  usage,
  stopReason: "stop",
  timestamp: 1,
});

describe("summarizeUsage", () => {
  it("sums anthropic calls where input excludes cache reads and writes", () => {
    const stats = summarizeUsage([
      assistant({ input: 100, output: 20, cacheRead: 900, cacheWrite: 0, totalTokens: 1020 }),
      assistant({ input: 50, output: 10, cacheRead: 0, cacheWrite: 1000, totalTokens: 1060 }),
    ]);
    expect(stats.calls).toBe(2);
    expect(stats.promptTokens).toBe(2050);
    expect(stats.output).toBe(30);
    expect(stats.cacheRead).toBe(900);
    expect(stats.cacheWrite).toBe(1000);
    expect(stats.cacheMiss).toBe(1150);
    expect(stats.totalTokens).toBe(2080);
    expect(stats.hitRate).toBeCloseTo(0.439, 3);
  });

  it("does not double-count openai cached tokens already inside input", () => {
    const stats = summarizeUsage([
      assistant(
        { input: 1000, output: 50, cacheRead: 900, cacheWrite: 0, totalTokens: 1050 },
        "openai",
      ),
    ]);
    expect(stats.calls).toBe(1);
    expect(stats.promptTokens).toBe(1000);
    expect(stats.cacheRead).toBe(900);
    expect(stats.cacheMiss).toBe(100);
    expect(stats.hitRate).toBeCloseTo(0.9, 5);
  });

  it("normalizes each provider when a session mixes them", () => {
    const stats = summarizeUsage([
      assistant({ input: 100, output: 20, cacheRead: 900, cacheWrite: 0, totalTokens: 1020 }),
      assistant(
        { input: 1000, output: 50, cacheRead: 900, cacheWrite: 0, totalTokens: 1050 },
        "openai",
      ),
    ]);
    expect(stats.calls).toBe(2);
    expect(stats.promptTokens).toBe(2000);
    expect(stats.cacheRead).toBe(1800);
    expect(stats.cacheMiss).toBe(200);
    expect(stats.output).toBe(70);
    expect(stats.totalTokens).toBe(2070);
    expect(stats.hitRate).toBeCloseTo(0.9, 5);
  });

  it("ignores non-assistant messages and calls without usage", () => {
    const stats = summarizeUsage([
      { role: "user", content: "hi", timestamp: 1 },
      assistant(emptyUsage()),
    ]);
    expect(stats.calls).toBe(0);
    expect(stats.promptTokens).toBe(0);
    expect(stats.totalTokens).toBe(0);
    expect(stats.hitRate).toBe(0);
  });
});

describe("contextReport", () => {
  it("renders context usage, token totals, and cache hit/miss lines", () => {
    const stats: UsageStats = {
      calls: 8,
      promptTokens: 45231,
      output: 3120,
      cacheRead: 40000,
      cacheWrite: 2000,
      cacheMiss: 5231,
      totalTokens: 48351,
      hitRate: 0.884,
    };
    expect(contextReport({ used: 12345, window: 200000 }, stats)).toBe(
      [
        "Context: 12k/200k (6%)",
        "Tokens: input 45k · output 3.1k · total 48k (8 calls)",
        "Cache: hit 40k · miss 5.2k · write 2.0k · hit rate 88.4%",
      ].join("\n"),
    );
  });

  it("says there are no model calls instead of a misleading 0% hit rate", () => {
    const report = contextReport({ used: 500, window: 200000 }, summarizeUsage([]));
    expect(report).toBe("Context: 500/200k (0%)\nTokens: no model calls yet");
  });
});

describe("AgentSession.getContextUsage", () => {
  const model: Model = {
    provider: "openai",
    id: "fake",
    baseUrl: "http://localhost",
    contextWindow: 100000,
    maxOutputTokens: 1000,
  };
  async function sessionWith(manager: SessionManager, home: string, cwd: string) {
    return AgentSession.create({
      cwd,
      home,
      config: createDefaultConfig(),
      auth: { keys: {} },
      model,
      sessionManager: manager,
      permissions: new PermissionPolicy({
        cwd,
        readOnlyRoots: [],
        allowWrite: [],
        yolo: true,
        interactive: false,
      }),
      resources: new ResourceLoader(cwd, home),
    });
  }

  it("reports zero used for a session with no conversation", async () => {
    const home = await temp();
    const cwd = await temp();
    const manager = await SessionManager.create(cwd, { home });
    const session = await sessionWith(manager, home, cwd);
    const usage = session.getContextUsage();
    expect(usage.used).toBe(0);
    expect(usage.window).toBe(100000);
    await session.dispose();
  });

  it("reports the full estimate once the conversation has messages", async () => {
    const home = await temp();
    const cwd = await temp();
    const manager = await SessionManager.create(cwd, { home });
    await manager.appendMessage({ role: "user", content: "hello there", timestamp: 1 });
    const session = await sessionWith(manager, home, cwd);
    const usage = session.getContextUsage();
    // System prompt + tools overhead alone is well above zero; the message
    // adds more. The exact value depends on loaded skills, so assert a floor.
    expect(usage.used).toBeGreaterThan(100);
    await session.dispose();
  });
});

describe("AgentSession.getUsageStats", () => {
  it("aggregates every model call in the session, including compacted history", async () => {
    const home = await temp();
    const cwd = await temp();
    const manager = await SessionManager.create(cwd, { home });
    const first = await manager.appendMessage(
      assistant({ input: 100, output: 20, cacheRead: 900, cacheWrite: 0, totalTokens: 1020 }),
    );
    await manager.appendCompaction("summary", first.id, 100);
    await manager.appendMessage(
      assistant(
        { input: 1000, output: 50, cacheRead: 900, cacheWrite: 0, totalTokens: 1050 },
        "openai",
      ),
    );
    const model: Model = {
      provider: "openai",
      id: "fake",
      baseUrl: "http://localhost",
      contextWindow: 100000,
      maxOutputTokens: 1000,
    };
    const session = await AgentSession.create({
      cwd,
      home,
      config: createDefaultConfig(),
      auth: { keys: {} },
      model,
      sessionManager: manager,
      permissions: new PermissionPolicy({
        cwd,
        readOnlyRoots: [],
        allowWrite: [],
        yolo: true,
        interactive: false,
      }),
      resources: new ResourceLoader(cwd, home),
    });
    const stats = session.getUsageStats();
    expect(stats.calls).toBe(2);
    expect(stats.promptTokens).toBe(2000);
    expect(stats.cacheRead).toBe(1800);
    expect(stats.cacheMiss).toBe(200);
    expect(stats.hitRate).toBeCloseTo(0.9, 5);
    await session.dispose();
  });
});
