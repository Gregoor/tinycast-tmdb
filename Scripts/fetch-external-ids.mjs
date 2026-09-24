#!/usr/bin/env node
// Fills in imdbId for TV records that lack one, so OMDb can be asked about them by id.
//
// TMDB's `/tv/{id}` payload omits `imdb_id` entirely — only `/tv/{id}/external_ids` carries it — so
// every show fetched before `fetch.mjs` learned to ask for it was stored with an empty id. This is
// the catch-up for those; new shows get their id during the normal fetch.
//
// Resumable: a record that already has an id is skipped, and each id is appended to the store as it
// lands. Roughly 40% of a random sample of shows have one, and rather more among popular shows.
//
//   node Scripts/fetch-external-ids.mjs [--out data] [--limit 100] [--requests-per-second 20]

import { readStore, appendRecord } from "./store.mjs";
import { createClient, hasCredentials } from "./fetch.mjs";

if (!hasCredentials()) {
  console.error("set TMDB_READ_TOKEN (v4 bearer) or TMDB_API_KEY (v3) in the environment");
  process.exit(2);
}

// Detached runs outlive whatever was reading their log; a write to a closed pipe must not kill them.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});

function argValue(flag) {
  const arg = process.argv.find((a) => a.startsWith(flag));
  return arg ? arg.slice(flag.length) : undefined;
}

const outDir = argValue("--out=") ?? "data";
const limit = Number(argValue("--limit=") ?? 0);
const rps = Number(argValue("--requests-per-second=") ?? 20);

const store = readStore(outDir);
// Most-voted first: a popular show is likelier to have an id at all, and likelier to be searched.
const queue = [...store.values()]
  .filter((rec) => rec.mediaType === "tv" && !(rec.imdbId ?? "").trim())
  .sort((a, b) => (b.voteCount ?? 0) - (a.voteCount ?? 0))
  .map((rec) => rec.id);
if (limit > 0) queue.length = Math.min(queue.length, limit);
console.log(`store ${store.size}; TV without an imdbId ${queue.length}`);

const client = createClient({ rps });
let cursor = 0;
let done = 0;
let gained = 0;
let errors = 0;
const byId = new Map([...store.values()].map((rec) => [`${rec.mediaType}:${rec.id}`, rec]));

async function worker() {
  while (true) {
    const id = queue[cursor++];
    if (id === undefined) return;
    try {
      const external = await client.getJson(`https://api.themoviedb.org/3/tv/${id}/external_ids`);
      done++;
      if (external?.imdb_id) {
        // `fetchedAt` moves too, so the change reaches a client as that day's delta.
        const rec = byId.get(`tv:${id}`);
        const stamp = Date.now();
        appendRecord(outDir, { ...rec, imdbId: external.imdb_id, fetchedAt: stamp });
        gained++;
      }
    } catch (error) {
      errors++;
      console.error(`  tv ${id}: ${error.message}`);
    }
    if (done % 1000 === 0) console.log(`  ${done}/${queue.length} — gained ${gained}, errors ${errors}`);
  }
}

await Promise.all(Array.from({ length: client.concurrency }, worker));
console.log(`done: ${done} asked, ${gained} gained an imdbId, ${errors} errors`);
if (errors > 0) process.exitCode = 1;