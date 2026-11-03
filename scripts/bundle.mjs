import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

async function bundle(entry, outfile, banner) {
  await build({
    entryPoints: [resolve(root, entry)],
    outfile: resolve(root, outfile),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: true,
    plugins: [localPackages],
    ...(banner ? { banner: { js: banner } } : {}),
    logLevel: "warning",
  });
}

await bundle(
  "packages/coding-agent/src/cli.ts",
  "packages/coding-agent/dist/cli.js",
);
await bundle("packages/coding-agent/src/index.ts", "packages/coding-agent/dist/index.js");