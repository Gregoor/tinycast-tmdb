#!/usr/bin/env node
// IMDb's own ratings, from their published bulk file.
//
// Rotten Tomatoes and Metacritic have no bulk feed — they are only reachable one title at a time
// through OMDb, and only for titles they reviewed. IMDb, by contrast, publishes every rating as one
// ~8.6 MB gzipped TSV, refreshed daily, with no key and no rate limit:
//
//   https://datasets.imdbws.com/title.ratings.tsv.gz     tconst \t averageRating \t numVotes
//
// So IMDb's number comes from here and OMDb is left to do only what it alone can. Non-commercial use
// only, per IMDb's terms.
//
//   node Scripts/fetch-imdb-ratings.mjs [--out data] [--url <override>]

import { gunzipSync } from "node:zlib";
import { readStore, appendRecord } from "./store.mjs";

const DEFAULT_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz";

// Detached runs outlive whatever was reading their log; a write to a closed pipe must not kill them.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});

function argValue(flag) {
  const arg = process.argv.find((a) => a.startsWith(flag));
  return arg ? arg.slice(flag.length) : undefined;
}

const outDir = argValue("--out=") ?? "data";
const url = argValue("--url=") ?? DEFAULT_URL;

console.log(`downloading ${url}`);
const response = await fetch(url);
if (!response.ok) {
  console.error(`ratings file -> HTTP ${response.status}`);
  process.exit(1);
}
const gz = new Uint8Array(await response.arrayBuffer());
const text = gunzipSync(gz).toString("utf8");

// tconst -> 0-100, matching how the record and the index store a rating.
const ratings = new Map();
let rows = 0;
for (const line of text.split("\n")) {
  if (!line) continue;
  const tab1 = line.indexOf("\t");
  if (tab1 < 0) continue; // header
  const tab2 = line.indexOf("\t", tab1 + 1);
  if (tab2 < 0) continue;
  const tconst = line.slice(0, tab1);
  const value = Number.parseFloat(line.slice(tab1 + 1, tab2));
  if (!tconst.startsWith("tt") || !Number.isFinite(value)) continue;
  ratings.set(tconst, Math.max(0, Math.min(100, Math.round(value * 10))));
  rows++;
}
console.log(`  ${rows.toLocaleString()} IMDb ratings, ${(gz.length / 1e6).toFixed(1)} MB gzipped`);

const store = readStore(outDir);
let asked = 0;
let changed = 0;
let unchanged = 0;
let missing = 0;

for (const rec of store.values()) {
  const tconst = (rec.imdbId ?? "").trim();
  if (!tconst.startsWith("tt")) continue;
  asked++;
  const rating = ratings.get(tconst);
  if (rating === undefined) {
    missing++;
    continue;
  }
  if (rec.imdbRating === rating) {
    unchanged++;
    continue;
  }
  // Append only on a real change, so a daily run of an unchanged corpus writes nothing — and so the
  // delta carries the change when there is one.
  appendRecord(outDir, { ...rec, imdbRating: rating, ratingsAt: rec.ratingsAt ?? Date.now(), fetchedAt: Date.now() });
  changed++;
}

console.log(`asked about ${asked.toLocaleString()} records: ${changed.toLocaleString()} updated, ` +
  `${unchanged.toLocaleString()} already current, ${missing.toLocaleString()} not in IMDb's file`);