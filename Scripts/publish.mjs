#!/usr/bin/env node
// Publishes the index to the rolling `latest` GitHub Release, as a base + deltas + a manifest.
//
// The index is far past GitHub's 100 MB committed-file limit, but Release assets allow 2 GB, so it
// ships there and the extension fetches it on first use. Release assets have no expiry, so a
// published base stays until it is replaced; deltas are pruned once folded into a new base.
//
// Usage:
//   node Scripts/publish.mjs                                  # bundle only (no index change)
//   node Scripts/publish.mjs --delta=build/delta-2026-09-23.index
//   node Scripts/publish.mjs --base=build/tmdb.index          # republish the base, reset deltas
//   node Scripts/publish.mjs --store=data/records.ndjson.gz   # back the store up as an asset
//
// Needs the `gh` CLI (authenticated; GitHub Actions provides it).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const TAG = "latest";
const MANIFEST = "manifest.json";

function argValue(flag) {
  const arg = process.argv.find((a) => a.startsWith(flag));
  return arg ? arg.slice(flag.length) : undefined;
}

const baseArg = argValue("--base=");
const deltaArg = argValue("--delta=");
const storeArg = argValue("--store=");
const bundlePath = resolve(argValue("--bundle=") ?? "build/provider.bundle.js");

function gh(args, options = {}) {
  return execFileSync("gh", args, { stdio: "inherit", ...options });
}

function streamHash(path) {
  const hash = createHash("sha256");
  const fd = readFileSync(path); // artifacts are build outputs (tens of MB); fine to read whole
  hash.update(fd);
  return hash.digest("hex");
}

function assetInfo(path, name) {
  if (!existsSync(path)) throw new Error(`missing artifact: ${path}`);
  return { name, bytes: statSync(path).size, sha256: streamHash(path), local: resolve(path) };
}

try {
  gh(["release", "view", TAG], { stdio: "ignore" });
} catch {
  gh(["release", "create", TAG, "--title", "Latest index",
    "--notes", "Rolling TMDB index (base + deltas), provider bundle, and store backup."]);
}

// The previous manifest tells us the existing base/deltas to carry forward.
const scratch = mkdtempSync(join(tmpdir(), "tmdb-publish-"));
let prev = null;
try {
  gh(["release", "download", TAG, "-p", MANIFEST, "-D", scratch], { stdio: "ignore" });
  prev = JSON.parse(readFileSync(join(scratch, MANIFEST), "utf8"));
} catch {
  prev = null; // first publish
}

// A new base resets the delta chain; otherwise the deltas accumulate.
let base = baseArg ? assetInfo(baseArg, "tmdb.index") : prev?.base ?? null;
let deltas = baseArg ? [] : [...(prev?.deltas ?? [])];
if (deltaArg) {
  const name = basename(deltaArg);
  if (deltas.some((d) => d.name === name)) deltas = deltas.filter((d) => d.name !== name);
  deltas.push(assetInfo(deltaArg, name));
}
const bundle = assetInfo(bundlePath, "provider.bundle.js");
const store = storeArg ? assetInfo(storeArg, "store.ndjson.gz") : prev?.store ?? null;

const manifest = {
  version: (prev?.version ?? 0) + 1,
  generatedAt: new Date().toISOString(),
  base,
  deltas,
  bundle,
  ...(store ? { store } : {}),
};

// Upload first, then the manifest — so a client never sees a manifest whose assets are missing.
const uploads = [];
if (baseArg) uploads.push(base.local);
if (deltaArg) uploads.push(resolve(deltaArg));
uploads.push(bundle.local);
if (storeArg) uploads.push(resolve(storeArg));
gh(["release", "upload", TAG, ...uploads, "--clobber"]);

const manifestPath = join(scratch, MANIFEST);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
gh(["release", "upload", TAG, manifestPath, "--clobber"]);

// Prune assets the new manifest no longer references (deltas folded into a fresh base).
const keep = new Set([MANIFEST, base?.name, bundle.name, store?.name, ...deltas.map((d) => d.name)].filter(Boolean));
const listed = execFileSync("gh", ["release", "view", TAG, "--json", "assets", "--jq", ".assets[].name"],
  { encoding: "utf8" }).split("\n").map((s) => s.trim()).filter(Boolean);
for (const name of listed) {
  if (!keep.has(name)) {
    console.log(`pruning stale asset ${name}`);
    gh(["release", "delete-asset", TAG, name, "-y"], { stdio: "ignore" });
  }
}

console.log(`published v${manifest.version}: base=${base?.name ?? "none"}, ${deltas.length} delta(s)`);