#!/usr/bin/env node
// Publishes the Wikipedia provider's assets to the same rolling `latest` release the movie index uses.
//
// One release, not two: `releases/latest/download/<name>` resolves to the most recent release, so a
// second rolling release would quietly take the URL the other provider's clients already depend on. The
// two publishers therefore share the tag and each prunes only the assets it owns.
//
// A *delta* day publishes one small index per wiki, and the manifest carries the chain forward — a delta
// can only be applied to the base it was built on, so which base that is has to be carried, not guessed.
// A *base* day republishes the whole index and restarts the chain.
//
//   node Scripts/publish-wikipedia.mjs                  # today's deltas, chained onto the published base
//   node Scripts/publish-wikipedia.mjs --base           # a full index, chain restarted
//   node Scripts/publish-wikipedia.mjs --lang=en --dry-run
//
// Needs the `gh` CLI (authenticated; GitHub Actions provides it).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { buildManifest, nextDeltas, published } from "./manifest.mjs";

const TAG = "latest";
const LANGUAGES = ["en", "de", "es"];
const RELEASE = "https://github.com/Gregoor/tinycast-tmdb/releases/latest/download";

const argValue = (flag) => process.argv.find((value) => value.startsWith(flag))?.slice(flag.length);
const languages = (argValue("--lang=") ?? LANGUAGES.join(",")).split(",");
const isBase = process.argv.includes("--base");
const dryRun = process.argv.includes("--dry-run");
const stem = (lang) => resolve("build", `wikipedia-${lang}`);

/// The transfer artifact: the manifest names what gets *installed*, and this is the `.gz` beside it.
function gzip(path) {
  const target = `${path}.gz`;
  execFileSync("/bin/sh", ["-c", `/usr/bin/gzip -6 -c '${path}' > '${target}'`]);
  return target;
}

function asset(path) {
  const bytes = readFileSync(path);
  return {
    name: basename(path),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    local: path,
  };
}

/// Today's deltas for a wiki, as the build left them. A fresh checkout has exactly the one this run made.
function deltasFor(lang) {
  return readdirSync("build")
    .filter((name) => name.startsWith(`wikipedia-${lang}-delta-`) && name.endsWith(".index"))
    .sort()
    .map((name) => resolve("build", name));
}

/// The manifest this release already carries, so a delta day can chain onto the base it names.
async function publishedManifest(lang) {
  try {
    const response = await fetch(`${RELEASE}/wikipedia-${lang}-manifest.json`, { redirect: "follow" });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

const missing = [];
for (const lang of languages) {
  if (isBase && !existsSync(`${stem(lang)}.index`)) missing.push(`${stem(lang)}.index`);
  if (!isBase && deltasFor(lang).length === 0) missing.push(`a delta for ${lang}`);
  if (!existsSync(`${stem(lang)}.groups`)) missing.push(`${stem(lang)}.groups`);
}
if (missing.length > 0) {
  console.error(`missing artifacts:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

if (dryRun) {
  for (const lang of languages) {
    const deltas = deltasFor(lang);
    console.log(`  ${lang}: ${isBase ? "base" : `${deltas.length} delta(s)`}, groups`);
    for (const path of [...(isBase ? [`${stem(lang)}.index`] : []), ...deltas, `${stem(lang)}.groups`]) {
      console.log(`    would upload ${basename(path)} (${(statSync(path).size / 1e6).toFixed(1)} MB)`);
    }
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
const uploads = [];
const manifests = [];
for (const lang of languages) {
  const previous = await publishedManifest(lang);
  const deltas = deltasFor(lang);
  const base = isBase ? asset(`${stem(lang)}.index`) : (previous?.base ?? null);
  if (!base) {
    console.error(`no published base for ${lang} and no --base — nothing a delta could apply to`);
    process.exit(1);
  }
  const groups = asset(`${stem(lang)}.groups`);
  const adding = deltas.map((path) => asset(path));
  const manifest = buildManifest({
    prev: previous,
    base,
    deltas: nextDeltas({ prevDeltas: previous?.deltas ?? [], isBase, adding }),
    files: [groups],
  });

  if (isBase) uploads.push(gzip(base.local));
  for (const delta of adding) uploads.push(gzip(delta.local));
  uploads.push(gzip(groups.local));

  const manifestPath = `${stem(lang)}-manifest.json`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  manifests.push(manifestPath);
  console.log(
    `  ${lang}: ${isBase ? "base" : `${adding.length} delta(s)`} onto v${manifest.version - 1}, ` +
      `${manifest.deltas.length} in the chain`);
}

gh(["release", "upload", TAG, ...uploads, "--clobber"]);
gh(["release", "upload", TAG, ...manifests, "--clobber"]);

// Prune only this provider's stale assets. The movie publisher sweeps the same release, so each keeps to
// its own prefix rather than deleting what it does not know about.
const keep = new Set([
  ...manifests.map((path) => basename(path)),
  ...uploads.map((path) => basename(path)),
]);
const listed = execFileSync("gh", ["release", "view", TAG, "--json", "assets", "--jq", ".assets[].name"], {
  encoding: "utf8",
}).split("\n").map((s) => s.trim()).filter(Boolean);
for (const name of listed) {
  if (!name.startsWith("wikipedia-") || keep.has(name)) continue;
  console.log(`  pruning stale asset ${name}`);
  gh(["release", "delete-asset", TAG, name, "-y"], { stdio: "ignore" });
}

console.log(`published Wikipedia assets for ${languages.join(", ")}`);
