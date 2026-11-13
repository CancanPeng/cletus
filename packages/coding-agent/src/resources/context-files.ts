import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

export type ContextFile = { path: string; content: string };
const MAX_BYTES = 32768;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function findRepoRoot(cwd: string): Promise<string> {
  let current = resolve(cwd);
  for (;;) {
    if (await exists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

async function readContext(path: string): Promise<ContextFile | undefined> {
  try {
    let content = await readFile(path, "utf8");
    if (Buffer.byteLength(content) > MAX_BYTES) {
      // Truncate by bytes, not UTF-16 units; the decoder drops any partial
      // multibyte character at the cut.
      const decoder = new StringDecoder("utf8");
      content = `${decoder.write(Buffer.from(content, "utf8").subarray(0, MAX_BYTES))}\n[truncated]`;
    }
    return { path, content };
  } catch {
    return undefined;
  }
}

export async function loadContextFiles(
  cwd: string,
  home: string,
): Promise<ContextFile[]> {
  const files: ContextFile[] = [];
  const global =
    (await readContext(join(home, "AGENTS.md"))) ??
    (await readContext(join(home, "CLAUDE.md")));
  if (global) files.push(global);

  const root = await findRepoRoot(cwd);
  const chain: string[] = [];
  let current = resolve(cwd);
  for (;;) {
    chain.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  chain.reverse();

  for (const dir of chain) {
    const override = await readContext(join(dir, "AGENTS.override.md"));
    if (override) {
      files.push(override);
      continue;
    }
    const agents = await readContext(join(dir, "AGENTS.md"));
    if (agents) {
      files.push(agents);
      continue;
    }
    const claude = await readContext(join(dir, "CLAUDE.md"));
    if (claude) files.push(claude);
  }
  return files;
}