import { build } from "esbuild";
import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(
  await readFile(resolve(root, "packages/coding-agent/package.json"), "utf8"),
);

const localPackages = {
  name: "local-packages",
  setup(build) {
    build.onResolve({ filter: /^@cletus\// }, (args) => {
      const name = args.path.split("/")[1];
      return { path: resolve(root, "packages", name, "src", "index.ts") };
    });
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("node:")) return { path: args.path, external: true };
      return { path: args.path, external: true };
    });
  },
};

// tsc emits per-file JS that imports unpublished workspace packages; only the
// esbuild bundles below are shippable, so drop the stale output first.
await rm(resolve(root, "packages/coding-agent/dist"), { recursive: true, force: true });

async function bundle(entry, outfile) {
  await build({
    entryPoints: [resolve(root, entry)],
    outfile: resolve(root, outfile),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    sourcemap: true,
    plugins: [localPackages],
    define: { __CLETUS_VERSION__: JSON.stringify(pkg.version) },
    logLevel: "warning",
  });
}

await bundle(
  "packages/coding-agent/src/cli.ts",
  "packages/coding-agent/dist/cli.js",
);
await bundle("packages/coding-agent/src/index.ts", "packages/coding-agent/dist/index.js");
