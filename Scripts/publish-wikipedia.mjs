#!/usr/bin/env node
// Publishes the Wikipedia provider's assets to the same rolling `latest` release the movie index uses.
//
// One release, not two: `releases/latest/download/<name>` resolves to the most recent release, so a
// second rolling release would quietly take the URL the other provider's clients already depend on. The
// two publishers therefore share the tag and each prunes only the assets it owns.
//
// Usage:
//   node Scripts/publish-wikipedia.mjs              # all three wikis
//   node Scripts/publish-wikipedia.mjs --lang=de    # one
//   node Scripts/publish-wikipedia.mjs --dry-run    # report, upload nothing
//
// Needs the `gh` CLI (authenticated; GitHub Actions provides it).

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const TAG = "latest";
const LANGUAGES = ["en", "de", "es"];

const argValue = (flag) => process.argv.find((value) => value.startsWith(flag))?.slice(flag.length);
const only = argValue("--lang=");
const dryRun = process.argv.includes("--dry-run");
const languages = only ? [only] : LANGUAGES;
const stem = (lang) => resolve("build", `wikipedia-${lang}`);

/// What one wiki publishes: its index and entity map, both as the compressed transfer, plus the manifest
/// that names them. The raw files stay local — a manifest describes what gets *installed*.
function assetsFor(lang) {
  return [`${stem(lang)}.index.gz`, `${stem(lang)}.groups.gz`, `${stem(lang)}-manifest.json`];
}

const missing = languages.flatMap(assetsFor).filter((path) => !existsSync(path));
if (missing.length > 0) {
  console.error(`missing artifacts:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

const mb = (path) => `${(statSync(path).size / 1e6).toFixed(1)} MB`;

if (dryRun) {
  for (const lang of languages) {
    for (const path of assetsFor(lang)) console.log(`  would upload ${path} (${mb(path)})`);
  }
  process.exit(0);
}

function gh(args, options = {}) {
  return execFileSync("gh", args, { stdio: "inherit", ...options });
}

try {
  gh(["release", "view", TAG], { stdio: "ignore" });
} catch {
  gh([
    "release", "create", TAG, "--title", "Latest index",
    "--notes", "Rolling TMDB and Wikipedia indexes, provider bundles, and store backup.",
  ]);
}

// Assets first, manifests last: a client must never read a manifest whose assets are not there yet.
gh(["release", "upload", TAG, ...languages.flatMap((lang) => assetsFor(lang).slice(0, 2)), "--clobber"]);
gh(["release", "upload", TAG, ...languages.map((lang) => `${stem(lang)}-manifest.json`), "--clobber"]);

// Prune only this provider's stale assets. The movie publisher sweeps the same release, so each keeps to
// its own prefix rather than deleting what it does not know about.
const keep = new Set(languages.flatMap((lang) => assetsFor(lang).map((path) => path.split("/").pop())));
const listed = execFileSync("gh", ["release", "view", TAG, "--json", "assets", "--jq", ".assets[].name"], {
  encoding: "utf8",
}).split("\n").map((s) => s.trim()).filter(Boolean);
for (const name of listed) {
  if (!name.startsWith("wikipedia-") || keep.has(name)) continue;
  console.log(`pruning stale asset ${name}`);
  gh(["release", "delete-asset", TAG, name, "-y"], { stdio: "ignore" });
}

console.log(`published Wikipedia assets for ${languages.join(", ")}`);
