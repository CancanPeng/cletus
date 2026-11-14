import { mkdtemp, readFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@cletus/agent";
import {
  AssistantEventStream,
  assistantMessage,
  type LlmContext,
  type Model,
  type StreamFn,
} from "@cletus/ai";
import { SessionManager, encodeCwd } from "../src/session/manager.js";
import { buildProjection } from "../src/session/context.js";
import { AgentSession } from "../src/session/session.js";
import { createDefaultConfig } from "../src/config.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { ResourceLoader } from "../src/resources/index.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cletus-session-"));
  dirs.push(dir);
  return dir;
}

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });

describe("SessionManager", () => {
  it("reopens the same branch and skips corrupt lines", async () => {
    const home = await temp();
    const cwd = await temp();
    const manager = await SessionManager.create(cwd, { home });
    await manager.appendMessage(user("hello"));
    await manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      provider: "openai",
      model: "fake",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      stopReason: "stop",
      timestamp: 2,
    });
    const file = manager.filePath;
    expect(file).toBeTruthy();
    await appendFile(file!, "{broken\n", "utf8");
    const opened = await SessionManager.open(file!);
    expect(opened.getBranch()).toHaveLength(2);
    expect(opened.getLeafId()).toBeTruthy();
  });

  it("forks a branch into a new file", async () => {
    const home = await temp();
    const cwd = await temp();
    const manager = await SessionManager.create(cwd, { home });
    await manager.appendMessage(user("one"));
    await manager.appendMessage(user("two"));
    const fork = await manager.fork();
    expect(fork.sessionId).not.toBe(manager.sessionId);
    expect(fork.getBranch()).toHaveLength(2);
    const header = JSON.parse((await readFile(fork.filePath!, "utf8")).split("\n")[0] ?? "{}");
    expect(header.parentSession).toBe(manager.filePath);
  });

  it("lists sessions newest first", async () => {
    const home = await temp();
    const cwd = await temp();
    const manager = await SessionManager.create(cwd, { home });
    await manager.appendMessage(user("find me"));
    const infos = await SessionManager.list(cwd, { home });
    expect(infos).toHaveLength(1);
    expect(infos[0]?.firstUserText).toBe("find me");
  });

  it("encodes cwds injectively and isolates their sessions", async () => {
    expect(encodeCwd("/a/b")).not.toBe(encodeCwd("/a-b"));
    const home = await temp();
    const first = await SessionManager.create("/a/b", { home });
    await first.appendMessage(user("project one"));
    const second = await SessionManager.create("/a-b", { home });
    await second.appendMessage(user("project two"));
    const infos = await SessionManager.list("/a/b", { home });
    expect(infos).toHaveLength(1);
    expect(infos[0]?.firstUserText).toBe("project one");
  });

  it("keeps the recent tail when forking a compacted session", async () => {
    const home = await temp();
    const cwd = await temp();
    const manager = await SessionManager.create(cwd, { home });
    await manager.appendMessage(user("old goal"));
    const kept = await manager.appendMessage(user("recent question"));
    await manager.appendCompaction("summary of old goal", kept.id, 100);
    const fork = await manager.fork();
    const projection = buildProjection(fork);
    const texts = projection.messages.map((message) =>
      message.role === "user" ? message.content : "",
    );
    expect(texts.some((text) => text.includes("summary of old goal"))).toBe(true);
    expect(texts).toContain("recent question");
  });
});
describe("SessionManager.find", () => {
  it("resolves by exact id, file path, and unique id prefix", async () => {
    const home = await temp();
    const cwd = await temp();
    const manager = await SessionManager.create(cwd, { home });
    await manager.appendMessage(user("hi"));
    const id = manager.sessionId;
    const filePath = manager.filePath!;

    expect((await SessionManager.find(cwd, id, { home }))?.sessionId).toBe(id);
    expect((await SessionManager.find(cwd, filePath, { home }))?.sessionId).toBe(id);
    // The status bar and `sessions list` show a short id; resuming has to work
    // with exactly what the UI prints.
    expect((await SessionManager.find(cwd, id.slice(0, 8), { home }))?.sessionId).toBe(id);
  });

  it("returns undefined for an ambiguous prefix", async () => {
    const home = await temp();
    const cwd = await temp();
    const a = await SessionManager.create(cwd, { home, sessionId: "abcd1111-0000-0000-0000-000000000000" });
    await a.appendMessage(user("a"));
    const b = await SessionManager.create(cwd, { home, sessionId: "abcd2222-0000-0000-0000-000000000000" });
    await b.appendMessage(user("b"));
    await expect(SessionManager.find(cwd, "abcd", { home })).rejects.toThrow(/ambiguous/i);
  });

  it("returns undefined when nothing matches", async () => {
    const home = await temp();
    const cwd = await temp();
    await SessionManager.create(cwd, { home });
    expect(await SessionManager.find(cwd, "nosuchid", { home })).toBeUndefined();
  });
});

describe("image attachments", () => {
  it("saveAttachment writes bytes under the session directory and returns absolute path", async () => {
    const home = await temp();
    const cwd = await temp();
    const manager = await SessionManager.create(cwd, { home });
    const att = await manager.saveAttachment(new Uint8Array([1, 2, 3]), "png");
    expect(att.mediaType).toBe("image/png");
    expect(isAbsolute(att.path)).toBe(true);
    expect(att.path).toContain(manager.sessionId);
    expect(await readFile(att.path)).toEqual(Buffer.from([1, 2, 3]));
    const jpg = await manager.saveAttachment(new Uint8Array([4]), "jpg");
    expect(jpg.mediaType).toBe("image/jpeg");
  });

  it("persists user images across open and still loads old files without images", async () => {
    const home = await temp();
    const cwd = await temp();
    const manager = await SessionManager.create(cwd, { home });
    const att = await manager.saveAttachment(new Uint8Array([1]), "png");
    await manager.appendMessage({ role: "user", content: "look", timestamp: 1, images: [att] });
    const opened = await SessionManager.open(manager.filePath!);
    const branch = opened.getBranch();
    const message = branch[0];
    expect(message?.type).toBe("message");
    if (message?.type === "message" && message.message.role === "user") {
      expect(message.message.images).toEqual([att]);
    }
    // Old-format line without images must keep loading.
    await appendFile(
      manager.filePath!,
      `${JSON.stringify({ type: "message", id: "legacy01", parentId: opened.getLeafId(), timestamp: new Date().toISOString(), message: { role: "user", content: "old", timestamp: 2 } })}\n`,
      "utf8",
    );
    const reopened = await SessionManager.open(manager.filePath!);
    expect(reopened.getBranch()).toHaveLength(2);
  });

  it("strips images for models without vision in the request projection", async () => {
    const home = await temp();
    const cwd = await temp();
    const manager = await SessionManager.create(cwd, { home });
    const att = await manager.saveAttachment(new Uint8Array([1]), "png");
    const model: Model = {
      provider: "openai",
      id: "no-vision",
      baseUrl: "http://localhost",
      contextWindow: 100000,
      maxOutputTokens: 1000,
      supportsImages: false,
    };
    let seen: LlmContext | undefined;
    const notices: string[] = [];
    const streamFn: StreamFn = (_model, context) => {
      seen = context;
      const stream = new AssistantEventStream();
      stream.end(assistantMessage(model, [{ type: "text", text: "ok" }], "stop"));
      return stream;
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
      streamFn,
      onNotice: (text) => notices.push(text),
    });
    await session.prompt("look", [att]);
    expect(notices.some((text) => text.includes("不支持图片"))).toBe(true);
    const userMessage = seen?.messages.find((message) => message.role === "user");
    expect(userMessage?.role).toBe("user");
    if (userMessage?.role === "user") {
      expect(userMessage.content).toContain("[图片已忽略");
      expect(userMessage.images).toBeUndefined();
    }
    // The persisted message keeps the attachment for later vision models.
    const stored = manager.getBranch()[0];
    if (stored?.type === "message" && stored.message.role === "user") {
      expect(stored.message.images).toEqual([att]);
    }
    await session.dispose();
  });
});
