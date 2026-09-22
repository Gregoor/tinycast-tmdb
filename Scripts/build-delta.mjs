#!/usr/bin/env node
// Builds a delta index: the records touched since a marker (new + updated), plus the stable keys it
// supersedes (those touched records, and anything dropped from the export). The delta is an index in
// the same format, so the client searches base + deltas and merges — no renumbering, no binary patch.
//
//   node Scripts/build-delta.mjs [data-dir] [out.index] [--since=<unix-ms>]
//
// `--since` defaults to the marker in <data-dir>/published.json (written by --mark). Records carry
// `fetchedAt`, so "touched since T" is exact; a matching record removed from today's export is
// superseded with no replacement.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildIndexFromRecords } from "./build-index.mjs";
import { stableKey, key as recordKey } from "./store.mjs";

const dir = resolve(process.argv[2] ?? "data");
const out = resolve(process.argv[3] ?? "build/delta.index");
const sinceArg = process.argv.find((a) => a.startsWith("--since="));
const markArg = process.argv.includes("--mark");

const markerPath = resolve(dir, "published.json");
const marker = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, "utf8")) : {};
const since = sinceArg ? Number(sinceArg.slice("--since=".length)) : Number(marker.since ?? 0);

// Last-wins per key, so an updated record resolves to its newest line.
const latest = new Map();
for (const raw of readFileSync(resolve(dir, "records.ndjson"), "utf8").split("\n")) {
  const line = raw.trim();
  if (!line) continue;
  const rec = JSON.parse(line);
  latest.set(recordKey(rec.mediaType, rec.id), rec);
}

// Today's export ids, to spot records that vanished (rare, but a deletion must supersede too).
const liveExport = new Set();
const exportPath = resolve(dir, "id-export.ndjson");
if (existsSync(exportPath)) {
  for (const raw of readFileSync(exportPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const e = JSON.parse(line);
    if (!e.adult) liveExport.add(recordKey(e.mediaType, e.id));
  }
}

const touched = [];
const superseded = new Set();
for (const [k, rec] of latest) {
  if ((rec.fetchedAt ?? 0) > since) {
    touched.push(rec);
    superseded.add(stableKey(rec.mediaType, rec.id));
  } else if (liveExport.size > 0 && !liveExport.has(k)) {
    // Present in the store, gone from the export: removed from TMDB. Supersede, ship no replacement.
    superseded.add(stableKey(rec.mediaType, rec.id));
  }
}

if (touched.length === 0 && superseded.size === 0) {
  console.log("delta: nothing changed since the marker");
} else {
  const built = await buildIndexFromRecords(touched, out, { supersededKeys: [...superseded] });
  console.log(
    `delta: ${built.rows} records, ${superseded.size} superseded keys → ${out}`);
}

if (markArg) {
  writeFileSync(markerPath, JSON.stringify({ since: Date.now(), delta: out }));
  console.log(`marked published.json since=${new Date().toISOString()}`);
}