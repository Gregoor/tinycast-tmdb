#!/usr/bin/env node
// Publishes the built index + provider bundle to the rolling `latest` GitHub Release. The index is
// far past GitHub's 100 MB committed-file limit, but Release assets allow 2 GB, so it ships there
// and the extension fetches it at install time. The small source + bundle live in the repo itself.
//
// Usage: node Scripts/publish.mjs    (needs the `gh` CLI, authenticated — GitHub Actions provides it)

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const TAG = "latest";
const artifacts = ["build/tmdb.index", "build/provider.bundle.js"].map((p) => resolve(p));
for (const path of artifacts) {
  if (!existsSync(path)) throw new Error(`missing build artifact: ${path} — run the build first`);
}

function gh(args, options = {}) {
  return execFileSync("gh", args, { stdio: "inherit", ...options });
}

// Ensure the rolling release exists (create once; later runs just replace its assets).
try {
  gh(["release", "view", TAG], { stdio: "ignore" });
} catch {
  gh(["release", "create", TAG, "--title", "Latest index", "--notes", "Rolling TMDB index + provider bundle."]);
}

gh(["release", "upload", TAG, ...artifacts, "--clobber"]);
console.log(`published ${artifacts.length} assets to release '${TAG}'`);