#!/usr/bin/env node
// Enriches the store with ratings from OMDb: Rotten Tomatoes and Metacritic scores plus IMDb's own.
// One OMDb request yields all three, so all three are kept.
//
// OMDb's free tier is 1,000 requests/day, and RT/Metacritic scores only exist for titles those sites
// reviewed — coverage on a random draw from this corpus is ~4%, but 100% across the most-voted few
// thousand. So this walks the store by vote count, descending, and stops at its request budget.
//
// It is resumable and quota-aware: ratings land on the record itself (append-only, last-wins), so a
// re-run skips what is already fresh and continues where it left off.
//
//   OMDB_API_KEY=... node Scripts/fetch-ratings.mjs [--top=5000] [--max-requests=1000]
//                                        [--refresh-days=30] [--requests-per-second=5] [--out data]

import { readStore, appendRecord } from "./store.mjs";

const API = "https://www.omdbapi.com/";
const apiKey = process.env.OMDB_API_KEY;
if (!apiKey) {
  console.error("set OMDB_API_KEY in the environment");
  process.exit(2);
}

// Detached runs outlive whatever was reading their log; a write to a closed pipe must not kill them.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});

function argValue(flag) {
  const arg = process.argv.find((a) => a.startsWith(flag));
  return arg ? arg.slice(flag.length) : undefined;
}

const outDir = argValue("--out=") ?? "data";
const top = Number(argValue("--top=") ?? 5000);
const maxRequests = Number(argValue("--max-requests=") ?? 1000);
const refreshDays = Number(argValue("--refresh-days=") ?? 30);
const rps = Number(argValue("--requests-per-second=") ?? 5);
const staleBefore = Date.now() - refreshDays * 24 * 60 * 60 * 1000;

const store = readStore(outDir);

// Only records OMDb can be asked about by id, most-voted first, skipping anything refreshed recently.
const queue = [...store.entries()]
  .filter(([, rec]) => (rec.imdbId ?? "").trim())
  .filter(([, rec]) => !rec.ratingsAt || rec.ratingsAt < staleBefore)
  .sort((a, b) => (b[1].voteCount ?? 0) - (a[1].voteCount ?? 0))
  .slice(0, top);

console.log(`store ${store.size}; candidates ${queue.length}; budget ${maxRequests} requests`);

/// "8.3" -> 83, "N/A"/absent -> null, so a score is one byte on disk.
const score100 = (value) => {
  const n = Number.parseFloat(String(value ?? "").replace("%", ""));
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
};
const imdb100 = (value) => {
  const n = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n * 10))) : null;
};

let done = 0;
let withRt = 0;
let withMeta = 0;
let unknown = 0;
let errors = 0;
const started = Date.now();

for (const [recordKey, rec] of queue) {
  if (done >= maxRequests) {
    console.log(`stopping at the ${maxRequests}-request budget (${queue.length - done} left for next run)`);
    break;
  }
  // Token-bucket-ish spacing; OMDb documents a daily quota, not a per-second one.
  const wait = (done + 1) * (1000 / rps) - (Date.now() - started);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  let payload;
  try {
    const response = await fetch(`${API}?apikey=${apiKey}&i=${encodeURIComponent(rec.imdbId.trim())}`);
    payload = await response.json();
  } catch (error) {
    errors++;
    console.error(`  ${recordKey}: ${error.message}`);
    continue;
  }
  done++;

  if (payload?.Error) {
    // A bad key or an exhausted quota is fatal, not a per-title miss.
    if (/invalid api key|limit/i.test(payload.Error)) {
      console.error(`fatal: ${payload.Error} (after ${done} requests)`);
      process.exitCode = 1;
      break;
    }
    unknown++;
    continue;
  }

  const ratings = payload?.Ratings ?? [];
  const rt = score100(ratings.find((r) => /rotten tomatoes/i.test(r.Source))?.Value);
  const metacritic = score100(ratings.find((r) => /metacritic/i.test(r.Source))?.Value);
  const imdb = imdb100(payload?.imdbRating);
  if (rt !== null) withRt++;
  if (metacritic !== null) withMeta++;

  // Append-only last-wins: the record gains the ratings, and the index/delta machinery carries the
  // change like any other edit.
  // `fetchedAt` moves too: it is the marker `build-delta` reads to decide which records changed, so
  // without it a new score would only reach a client at the next base rebuild instead of that day.
  const stamp = Date.now();
  appendRecord(outDir, {
    ...rec, imdbRating: imdb, rtScore: rt, metacriticScore: metacritic,
    ratingsAt: stamp, fetchedAt: stamp,
  });

  if (done % 100 === 0) {
    console.log(`  ${done}/${Math.min(maxRequests, queue.length)} — rt ${withRt}, metacritic ${withMeta}, unknown ${unknown}, errors ${errors}`);
  }
}

const minutes = ((Date.now() - started) / 60000).toFixed(1);
console.log(`done: ${done} requests in ${minutes}m (rt ${withRt}, metacritic ${withMeta}, unknown ${unknown}, errors ${errors})`);
if (errors > 0) process.exitCode = 1;
