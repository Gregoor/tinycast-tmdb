// Backfills TMDB metadata for ids in the daily export that aren't yet in the store. Resumeable:
// records append to the store as each fetch lands, so killing and re-running skips what is done.
//
// Usage: node Scripts/backfill-metadata.mjs [--requests-per-second 20] [--limit 100] [--out data]

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readStore, key } from "./store.mjs";
import { createClient, fetchInto, hasCredentials } from "./fetch.mjs";

if (!hasCredentials()) {
  console.error("set TMDB_READ_TOKEN (v4 bearer) or TMDB_API_KEY (v3) in the environment");
  process.exit(2);
}

// This job runs for hours, detached, and outlives whatever was reading its log. A write to a closed
// pipe must not take the run down with it.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});

function argValue(flag) {
  const arg = process.argv.find((a) => a.startsWith(flag));
  return arg ? arg.slice(flag.length) : undefined;
}

const outDir = resolve(argValue("--out=") ?? "data");
const rps = Number(argValue("--requests-per-second=") ?? 20);
const limit = Number(argValue("--limit=") ?? 0); // 0 = all

const exportIds = [];
for (const raw of readFileSync(resolve(outDir, "id-export.ndjson"), "utf8").split("\n")) {
  const line = raw.trim();
  if (!line) continue;
  const parsed = JSON.parse(line);
  // Adult content is excluded up front (the indexes we ship are family-safe root-search surfaces).
  if (parsed.adult) continue;
  exportIds.push(parsed);
}

const store = readStore(outDir);
const toFetch = exportIds.filter((e) => !store.has(key(e.mediaType, e.id)));
console.log(`store has ${store.size}; export has ${exportIds.length}; to fetch ${toFetch.length}`);
if (limit > 0) {
  console.log(`limiting to ${limit} requests this run`);
  toFetch.length = Math.min(toFetch.length, limit);
}

const stats = await fetchInto(toFetch, { outDir, client: createClient({ rps }), label: "backfill" });
console.log(`done: ${stats.done} fetched (${stats.skipped404} 404s, ${stats.errors} errors)`);
if (stats.errors > 0) process.exitCode = 1;