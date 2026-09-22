// The Tinycast root-search provider for TMDB movies and TV shows. Bundled to a single self-contained
// file that AppCore loads into a resident JavaScriptCore session.
//
// The index is NOT committed — at ~140 MB it is past GitHub's 100 MB committed-file limit. It ships
// as a GitHub Release asset beside a small manifest and per-day deltas; the manifest is fetched every
// launch and an index file only when its recorded hash changed, so a launch costs one small request
// and a day's update costs only that day's delta.
//
// A provider's API surface is restricted to `rootSearch.*` + `open`, but the Node builtins are
// provided to every bundle by design — so the index is downloaded with curl through the process shim.
// That streams straight to disk, which the fetch path cannot: its polyfill is refused by the provider
// bridge, and a bare `fetch` only works where JavaScriptCore supplies a native one, buffering the
// whole body in memory. That, plus the resident-session runtime, makes this Tinycast-only: it is not a
// Raycast extension and must stay out of the Raycast store and any registry catalog.
//
// The provider's `@tinycast/api` module exposes only `registerRootSearchProvider` and `open`, so the
// cache directory is derived from the home directory rather than `environment.supportPath`.
//
// The default export must stay "alive" (return a never-settling promise) so the resident session keeps
// the runtime mounted across keystrokes — see RootSearchProviderHost.

import { registerRootSearchProvider, open } from "@tinycast/api";
import { createProviderCore, activationURL } from "./provider-core.mjs";

const MANIFEST_URL =
  "https://github.com/Gregoor/tinycast-tmdb/releases/latest/download/manifest.json";

/// A re-downloadable, hash-verified artifact belongs in Caches, not Application Support.
const CACHE_DIR = `${require("os").homedir()}/Library/Caches/tinycast-root-search/movies`;

/// Fetch `url` to `path` through curl, writing beside the target and renaming so a failed or partial
/// transfer never leaves a truncated index where the loader would open it.
function download(url, path) {
  const { execFileSync } = require("child_process");
  const fs = require("fs");
  execFileSync("/usr/bin/curl", ["-fsSL", "--retry", "3", url, "-o", `${path}.part`]);
  fs.renameSync(`${path}.part`, path);
}

export default function command() {
  const fs = require("fs");
  const core = createProviderCore({
    manifestURL: MANIFEST_URL, cacheDir: CACHE_DIR, fs, download, log: console.log,
  });

  registerRootSearchProvider({
    id: "movies",
    search: (query, { limit }) => core.search(query, limit),
    async perform(resultId) {
      const url = activationURL(resultId);
      if (url) await open(url, "Safari");
    },
  });

  // Keep the resident session mounted: never settle.
  return new Promise(() => {});
}