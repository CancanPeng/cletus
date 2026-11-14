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

/**
 * A structurally complete 1x1 PNG plus an IHDR chunk. CRC fields are zero,
 * which is fine: `read` validates structure, not checksums.
 */
function png(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  const idat = Buffer.alloc(21);
  idat.writeUInt32BE(9, 0);
  idat.write("IDAT", 4, "ascii");
  const iend = Buffer.alloc(12);
  iend.write("IEND", 4, "ascii");
  return Buffer.concat([signature, ihdr, idat, iend]);
}

/**
 * Minimal JPEG: SOI, one APP0 segment, then an SOF0 declaring the dimensions.
 * Segment length counts itself, so the segment occupies 2 (marker) + length bytes.
 */
function jpeg(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(2 + 2 + 2 + 2 + 17);
  buffer[0] = 0xff;
  buffer[1] = 0xd8; // SOI
  buffer[2] = 0xff;
  buffer[3] = 0xe0; // APP0 marker
  buffer.writeUInt16BE(2, 4); // length 2 => next marker starts at 2 + 2 + 2 = 6
  buffer[6] = 0xff;
  buffer[7] = 0xc0; // SOF0
  buffer.writeUInt16BE(11, 8);
  buffer[10] = 8; // precision
  buffer.writeUInt16BE(height, 11);
  buffer.writeUInt16BE(width, 13);
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
    await writeFile(join(cwd, "photo.bin"), jpeg(640, 480));
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

  it("falls back to a binary error when a PNG has only a signature", async () => {
    const cwd = await temp();
    // Magic matches but there is no IHDR/IDAT/IEND. Forwarding this as an
    // image hands the provider bytes it cannot decode, so it must not.
    await writeFile(
      join(cwd, "cut.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const result = await createReadTool({ policy: policyFor(cwd), cwd }).execute(
      { path: "cut.png" },
      context(cwd),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect((result.content[0] as { text: string }).text).toContain("Cannot read binary file");
  });

  it("falls back to a binary error when a JPEG has no frame header", async () => {
    const cwd = await temp();
    await writeFile(join(cwd, "cut.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
    const result = await createReadTool({ policy: policyFor(cwd), cwd }).execute(
      { path: "cut.jpg" },
      context(cwd),
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Cannot read binary file");
  });

  it("still returns an image when only the dimensions are unreadable but the file is a real PNG", async () => {
    const cwd = await temp();
    // Signature + IHDR chunk header but a zero width: dimensions unknown,
    // yet the payload is a genuine (if odd) PNG container.
    await writeFile(join(cwd, "odd.png"), png(0, 0));
    const result = await createReadTool({ policy: policyFor(cwd), cwd }).execute(
      { path: "odd.png" },
      context(cwd),
    );
    expect(result.content[1]).toMatchObject({ type: "image", mediaType: "image/png" });
  });
});