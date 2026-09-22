// Downloads today's TMDB daily ID exports (movies + TV) and writes a merged, filtered NDJSON the
// indexer can consume. Per https://developer.themoviedb.org/docs/daily-id-exports the files are
// unauthenticated, available by ~08:00 UTC, at https://files.tmdb.org/p/exports/{movie,tv_series}_ids_MM_DD_YYYY.json.gz.
//
// Usage: node Scripts/fetch-exports.mjs [--date MM_DD_YYYY] [--out <dir>]
//
// Output: <out>/id-export.ndjson — one line per id: {mediaType:"movie"|"tv", id, originalTitle,
// popularity, adult}. Files are only cached 3 months on the server, so a fatal fetch is clearer
// than a silent retry guessing at a stale date.

import { gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Default to today, or accept --date MM_DD_YYYY (historic reruns fetch that day's file while alive).
function targetDate() {
  const arg = process.argv.find((a) => a.startsWith("--date="));
  if (arg) return arg.slice("--date=".length);
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}_${dd}_${d.getFullYear()}`;
}

const outArg = process.argv.find((a) => a.startsWith("--out="));
const outDir = resolve(outArg ? outArg.slice("--out=".length) : "data");
mkdirSync(outDir, { recursive: true });

const date = targetDate();
const KINDS = { movie: "movie_ids", tv: "tv_series_ids" };

const lines = [];
for (const [mediaType, name] of Object.entries(KINDS)) {
  const url = `https://files.tmdb.org/p/exports/${name}_${date}.json.gz`;
  console.log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`export ${name} ${date} -> HTTP ${response.status}`);
  }
  const gz = new Uint8Array(await response.arrayBuffer());
  const text = gunzipSync(gz).toString("utf8");
  let n = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = JSON.parse(line);
    lines.push({
      mediaType,
      id: parsed.id,
      originalTitle: parsed.original_title ?? parsed.original_name ?? "",
      popularity: parsed.popularity ?? 0,
      adult: !!parsed.adult,
    });
    n++;
  }
  console.log(`  ${mediaType}: ${n} ids`);
}

const outPath = resolve(outDir, "id-export.ndjson");
writeFileSync(outPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
console.log(`wrote ${outPath} (${lines.length} ids)`);