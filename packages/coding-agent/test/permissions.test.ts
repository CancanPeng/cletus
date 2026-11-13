import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionPolicy } from "../src/permissions/policy.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cletus-perm-"));
  dirs.push(dir);
  return dir;
}

describe("permission policy", () => {
  it("allows reads inside cwd and rejects traversal and symlink escapes", async () => {
    const cwd = await temp();
    const outside = await temp();
    await writeFile(join(cwd, "inside.txt"), "ok");
    await writeFile(join(outside, "outside.txt"), "no");
    await symlink(join(outside, "outside.txt"), join(cwd, "link.txt"));
    const policy = new PermissionPolicy({
      cwd,
      readOnlyRoots: [],
      allowWrite: [],
      yolo: false,
      interactive: false,
    });
    await expect(policy.resolveRead("inside.txt")).resolves.toContain("inside.txt");
    await expect(policy.resolveRead("../outside.txt")).rejects.toThrow("outside allowed roots");
    await expect(policy.resolveRead("link.txt")).rejects.toThrow("outside allowed roots");
  });

  it("requires confirmation for web search unless yolo", async () => {
    const cwd = await temp();
    const policy = new PermissionPolicy({
      cwd,
      readOnlyRoots: [],
      allowWrite: [],
      yolo: false,
      interactive: false,
    });
    expect((await policy.check("web_search", { query: "hello" })).allow).toBe(false);
    policy.setYolo(true);
    expect((await policy.check("web_search", { query: "hello" })).allow).toBe(true);
  });

  it("toggles yolo mode at runtime", async () => {
    const cwd = await temp();
    const policy = new PermissionPolicy({
      cwd,
      readOnlyRoots: [],
      allowWrite: [],
      yolo: false,
      interactive: false,
    });
    expect((await policy.check("write", { path: "a.txt", content: "x" })).allow).toBe(false);
    policy.setYolo(true);
    expect(policy.yolo).toBe(true);
    expect((await policy.check("write", { path: "a.txt", content: "x" })).allow).toBe(true);
    policy.setYolo(false);
    expect((await policy.check("write", { path: "a.txt", content: "x" })).allow).toBe(false);
  });

  it("updates the persistent write allowlist at runtime", async () => {
    const cwd = await temp();
    const policy = new PermissionPolicy({
      cwd,
      readOnlyRoots: [],
      allowWrite: [],
      yolo: false,
      interactive: false,
    });
    expect((await policy.check("write", { path: "src/a.ts", content: "x" })).allow).toBe(false);
    policy.setAllowWrite(["src/**"]);
    expect((await policy.check("write", { path: "src/a.ts", content: "x" })).allow).toBe(true);
    expect((await policy.check("write", { path: "other/a.ts", content: "x" })).allow).toBe(false);
    policy.setAllowWrite([]);
    expect((await policy.check("write", { path: "src/a.ts", content: "x" })).allow).toBe(false);
  });

  it("rejects .git writes and non-interactive writes without yolo", async () => {
    const cwd = await temp();
    await mkdir(join(cwd, ".git"), { recursive: true });
    const policy = new PermissionPolicy({
      cwd,
      readOnlyRoots: [],
      allowWrite: [],
      yolo: false,
      interactive: false,
    });
    await expect(policy.resolveWrite(".git/config")).rejects.toThrow("Refusing to modify .git");
    const denied = await policy.check("write", { path: "a.txt", content: "x" });
    expect(denied.allow).toBe(false);
    const yolo = new PermissionPolicy({
      cwd,
      readOnlyRoots: [],
      allowWrite: [],
      yolo: true,
      interactive: false,
    });
    expect((await yolo.check("write", { path: "a.txt", content: "x" })).allow).toBe(true);
  });
});