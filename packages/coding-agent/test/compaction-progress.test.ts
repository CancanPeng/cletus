import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AssistantEventStream,
  assistantMessage,
  type Model,
  type StreamFn,
} from "@cletus/ai";
import { SessionManager } from "../src/session/manager.js";
import { AgentSession } from "../src/session/session.js";
import type { CompactionProgress } from "../src/session/session.js";
import { createDefaultConfig } from "../src/config.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { ResourceLoader } from "../src/resources/index.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cletus-progress-"));
  dirs.push(dir);
  return dir;
}

const model: Model = {
  provider: "openai",
  id: "fake",
  baseUrl: "http://localhost",
  contextWindow: 100000,
  maxOutputTokens: 1000,
};

async function setup(streamFn: StreamFn, events: CompactionProgress[]) {
  const home = await temp();
  const cwd = await temp();
  const manager = await SessionManager.create(cwd, { home });
  // A few exchanges so there is something to summarize.
  for (let index = 0; index < 6; index += 1) {
    await manager.appendMessage(
      index % 2 === 0
        ? { role: "user", content: `question ${index} ${"x".repeat(200)}`, timestamp: index }
        : {
            role: "assistant",
            content: [{ type: "text", text: `answer ${index}` }],
            provider: "openai",
            model: "fake",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
            stopReason: "stop",
            timestamp: index,
          },
    );
  }
  const config = createDefaultConfig();
  config.compaction.keepRecentTokens = 10;
  const session = await AgentSession.create({
    cwd,
    home,
    config,
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
    streamFn,
    onCompaction: (event) => events.push(event),
  });
  return { session, manager };
}

const summaryStream: StreamFn = () => {
  const stream = new AssistantEventStream();
  stream.end(assistantMessage(model, [{ type: "text", text: "## Goal\nsummarized" }], "stop"));
  return stream;
};

describe("compaction progress", () => {
  it("emits start then done with shrinking token counts and returns true", async () => {
    const events: CompactionProgress[] = [];
    const { session } = await setup(summaryStream, events);
    const compacted = await session.compact();
    expect(compacted).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
    const done = events[1];
    if (done?.type === "done") {
      expect(done.tokensBefore).toBeGreaterThan(done.tokensAfter);
      expect(done.tokensAfter).toBeGreaterThan(0);
    }
    await session.dispose();
  });

  it("emits nothing and returns false when there is nothing to compact", async () => {
    const home = await temp();
    const cwd = await temp();
    const events: CompactionProgress[] = [];
    const notices: string[] = [];
    const manager = await SessionManager.create(cwd, { home });
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
      streamFn: summaryStream,
      onNotice: (text) => notices.push(text),
      onCompaction: (event) => events.push(event),
    });
    const compacted = await session.compact();
    expect(compacted).toBe(false);
    expect(events).toEqual([]);
    expect(notices).toContain("Nothing to compact");
    await session.dispose();
  });

  it("emits start then error and rethrows when the summary call fails", async () => {
    const events: CompactionProgress[] = [];
    const failing: StreamFn = () => {
      const stream = new AssistantEventStream();
      stream.fail(
        assistantMessage(model, [], "error", undefined, "boom"),
        "boom",
      );
      return stream;
    };
    const { session } = await setup(failing, events);
    await expect(session.compact()).rejects.toThrow("boom");
    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    const failed = events[1];
    if (failed?.type === "error") expect(failed.message).toContain("boom");
    await session.dispose();
  });
});
