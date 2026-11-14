import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { createReadTool } from "../src/tools/read.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cletus-read-"));
  dirs.push(dir);
  return dir;
}

function context(cwd: string) {
  return {
    cwd,
    toolCallId: "t1",
    signal: new AbortController().signal,
    onUpdate: () => undefined,
  };
}

/** 8-byte PNG signature + IHDR chunk declaring the given dimensions. */
function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function policyFor(cwd: string): PermissionPolicy {
  return new PermissionPolicy({
    cwd,
    readOnlyRoots: [],
    allowWrite: [],
    yolo: true,
    interactive: false,
  });
}

describe("read tool images", () => {
  it("returns a text summary and an image block for a PNG", async () => {
    const cwd = await temp();
    await writeFile(join(cwd, "shot.png"), png(1280, 720));
    const result = await createReadTool({ policy: policyFor(cwd), cwd }).execute(
      { path: "shot.png" },
      context(cwd),
    );
    // The sandbox resolves symlinks, so the reported path is the realpath
    // (/var is a symlink to /private/var on macOS).
    const real = join(await realpath(cwd), "shot.png");
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toEqual({
      type: "text",
      text: `shot.png — image/png, 1280×720, 1 KB, path: ${real}`,
    });
    expect(result.content[1]).toEqual({
      type: "image",
      mediaType: "image/png",
      path: real,
    });
  });

  it("detects JPEG by magic bytes", async () => {
    const cwd = await temp();
    await writeFile(join(cwd, "photo.bin"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    const result = await createReadTool({ policy: policyFor(cwd), cwd }).execute(
      { path: "photo.bin" },
      context(cwd),
    );
    expect(result.content[1]).toMatchObject({ type: "image", mediaType: "image/jpeg" });
  });

  it("reads text when the extension lies", async () => {
    const cwd = await temp();
    await writeFile(join(cwd, "image.png"), "just text\n");
    const result = await createReadTool({ policy: policyFor(cwd), cwd }).execute(
      { path: "image.png" },
      context(cwd),
    );
    expect(result.content).toHaveLength(1);
    // Trailing newline yields a second, empty numbered line — that is the
    // existing text-mode behavior, not something this task changes.
    expect(result.content[0]).toEqual({ type: "text", text: "     1\tjust text\n     2\t" });
  });

  it("rejects images over 5MB without truncating", async () => {
    const cwd = await temp();
    const big = Buffer.concat([png(10, 10), Buffer.alloc(5 * 1024 * 1024)]);
    await writeFile(join(cwd, "big.png"), big);
    const result = await createReadTool({ policy: policyFor(cwd), cwd }).execute(
      { path: "big.png" },
      context(cwd),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("5MB");
  });

  it("treats a truncated PNG header as an image rather than failing", async () => {
    const cwd = await temp();
    await writeFile(
      join(cwd, "cut.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const result = await createReadTool({ policy: policyFor(cwd), cwd }).execute(
      { path: "cut.png" },
      context(cwd),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[1]).toMatchObject({ type: "image", mediaType: "image/png" });
  });
});