#!/usr/bin/env node
// Bundles the movie root-search provider into a single self-contained file the resident JS runtime
// (RootSearchProviderHost) can load. `@tinycast/api` and the Node builtins stay external — the
// runtime's module registry resolves them; the movie library is inlined.
//
//   node Scripts/build-provider.mjs     # writes build/provider.bundle.js

import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = resolve(root, "build", "provider.bundle.js");

const result = await build({
  entryPoints: [resolve(root, "src", "provider.js")],
  outfile,
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2022",
  write: true,
  plugins: [
    // Everything under node:... and node builtins stays external for the runtime's registry.
    {
      name: "external-node",
      setup(b) {
        b.onResolve(
          { filter: /^(fs|path|os|process|child_process|crypto|zlib|node:[^/]+)$/ },
          () => ({ external: true }),
        );
        b.onResolve({ filter: /^@tinycast\/api$/ }, () => ({ external: true }));
      },
    },
  ],
  logLevel: "warning",
});

for (const warning of result.warnings) console.warn(warning.text);
if (result.errors.length) {
  console.error(result.errors.map((e) => e.text).join("\n"));
  process.exit(1);
}
console.log(`wrote ${outfile}`);