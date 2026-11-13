import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type SandboxOptions = {
  cwd: string;
  readOnlyRoots: string[];
};

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

export async function realResolve(target: string): Promise<string> {
  const absolute = resolve(target);
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length > 0 ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      tail.push(basename(current));
      current = parent;
    }
  }
}

export async function resolveRead(
  opts: SandboxOptions,
  input: string,
): Promise<string> {
  const cwd = await realResolve(opts.cwd);
  const target = await realResolve(resolve(opts.cwd, input));
  const roots = await Promise.all(opts.readOnlyRoots.map((root) => realResolve(root)));
  if (isInside(cwd, target) || roots.some((root) => isInside(root, target))) {
    return target;
  }
  throw new Error(`Path outside allowed roots: ${target}`);
}

export async function resolveWrite(
  opts: SandboxOptions,
  input: string,
): Promise<string> {
  const cwd = await realResolve(opts.cwd);
  const target = await realResolve(resolve(opts.cwd, input));
  if (!isInside(cwd, target)) {
    throw new Error(`Path outside allowed roots: ${target}`);
  }
  const rel = relative(cwd, target);
  if (rel.split(/[\\/]/).some((part) => part === ".git")) {
    throw new Error("Refusing to modify .git");
  }
  return target;
}

export function resolveForGlob(cwd: string, pattern: string): string {
  return isAbsolute(pattern) ? pattern : resolve(cwd, pattern);
}