// Writes a manifest for a local index, so a provider prototype can exercise the real sync path — the
// hash check, the download, the install bookkeeping — without publishing a release.
//
//   node Scripts/build-local-manifest.mjs <index> <manifest-out>

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { buildManifest } from "./manifest.mjs";

const [indexPath, manifestPath, ...rest] = process.argv.slice(2);
if (!indexPath || !manifestPath) {
  console.error(
    "usage: node Scripts/build-local-manifest.mjs <index> <manifest-out> [--files=a.groups,b.groups]");
  process.exit(2);
}
const filesArg = rest.find((arg) => arg.startsWith("--files="));
const filePaths = filesArg ? filesArg.slice("--files=".length).split(",").filter(Boolean) : [];

const asset = (path) => {
  const bytes = readFileSync(path);
  return {
    name: basename(path),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};

/// The wire artifact, as `publish.mjs` writes it: the manifest names the installed file, and the
/// transfer is its gzipped sibling. Level 6, not 9: this runs on a working machine and gzips a 100 MB
/// index per wiki, where the top level is a minute of pinned CPU for a few percent off the transfer.
/// `publish.mjs` keeps level 9 — CI has the time and a download does not.
const gzipped = `${indexPath}.gz`;
execFileSync("/bin/sh", ["-c", `/usr/bin/gzip -6 -c '${indexPath}' > '${gzipped}'`]);
for (const path of filePaths) {
  execFileSync("/bin/sh", ["-c", `/usr/bin/gzip -6 -c '${path}' > '${path}.gz'`]);
}

const manifest = buildManifest({
  base: asset(indexPath),
  deltas: [],
  files: filePaths.map((path) => asset(path)),
});
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`  ${manifestPath}: ${asset(indexPath).name} ${asset(indexPath).bytes.toLocaleString()} bytes`);
for (const path of filePaths) {
  const info = asset(path);
  console.log(`    + ${info.name} ${info.bytes.toLocaleString()} bytes`);
}
console.log(`  ${gzipped}: ${statSync(gzipped).size.toLocaleString()} bytes to transfer`);
