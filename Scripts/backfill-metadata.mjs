// Backfills TMDB metadata for ids in the daily export that aren't yet in the store. Rate-limited to
// stay under TMDB's ~50 req/s per IP, resumeable: records are appended to the store as each fetch
// lands, so killing and re-running skips everything already written.
//
// Usage: node Scripts/backfill-metadata.mjs [--requests-per-second 40] [--limit 100] [--out data]
//
// Reads TMDB_API_KEY from the environment (GitHub secret or your shell).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readStore, key, appendRecord, recordFromApi } from "./store.mjs";

const readToken = process.env.TMDB_READ_TOKEN;
const apiKey = process.env.TMDB_API_KEY;
if (!readToken && !apiKey) {
  console.error("set TMDB_READ_TOKEN (v4 bearer) or TMDB_API_KEY (v3) in the environment");
  process.exit(2);
}
// TMDB takes either a v4 read token as a Bearer header or a v3 key as `?api_key=`.
function auth() {
  return readToken
    ? { url: (u) => u, headers: { Authorization: `Bearer ${readToken}` } }
    : { url: (u) => u + (u.includes("?") ? "&" : "?") + "api_key=" + apiKey, headers: {} };
}
const AUTH = auth();

function argValue(flag) {
  const arg = process.argv.find((a) => a.startsWith(flag));
  return arg ? arg.slice(flag.length) : undefined;
}
const outDir = resolve(argValue("--out=") ?? "data");
const rps = Number(argValue("--requests-per-second=") ?? 20);
const limit = Number(argValue("--limit=") ?? 0); // 0 = all

const exportPath = resolve(outDir, "id-export.ndjson");
const exportIds = [];
for (const raw of readFileSync(exportPath, "utf8").split("\n")) {
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

// ── rate limiter ────────────────────────────────────────────────────────────────────────────────
// Token bucket at `rps` requests per second; 429 (rate limit) and 5xx (transient) wait + retry.
let tokens = rps;
let lastRefill = Date.now();
// A single cursor into `toFetch` (workers overlap on the network, not the list) avoids spreading a
// million-element array, which overflows the call stack.
let cursor = 0;

function maybeRefill() {
  const now = Date.now();
  tokens = Math.min(rps, tokens + ((now - lastRefill) / 1000) * rps);
  lastRefill = now;
}

async function withTicket() {
  while (true) {
    maybeRefill();
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function getJson(url, retries = 4) {
  for (let attempt = 0; ; attempt++) {
    await withTicket();
    const response = await fetch(AUTH.url(url), { headers: AUTH.headers });
    if (response.status === 200) return await response.json();
    if ((response.status === 429 || response.status >= 500) && attempt < retries) {
      const retryAfter = Number(response.headers.get("retry-after") ?? 1);
      const ms = Math.max(1000, retryAfter * 1000) * (attempt + 1);
      console.log(`  ${response.status} on ${url} — retry in ${ms / 1000}s`);
      await new Promise((r) => setTimeout(r, ms));
      continue;
    }
    if (response.status === 404) return null; // dropped/deleted id: skip, don't crash the run
    throw new Error(`GET ${url} -> HTTP ${response.status}`);
  }
}

let done = 0;
let skipped404 = 0;
let errors = 0;

async function worker() {
  while (true) {
    const item = toFetch[cursor++];
    if (!item) return;
    try {
      const url = `https://api.themoviedb.org/3/${item.mediaType}/${item.id}?language=en-US`;
      const data = await getJson(url);
      if (data === null) {
        skipped404++;
      } else {
        appendRecord(outDir, recordFromApi(item.mediaType, data));
      }
    } catch (error) {
      errors++;
      console.error(`  ${item.mediaType} ${item.id}: ${error.message}`);
    }
    done++;
    if (done % 1000 === 0) {
      console.log(`fetched ${done}/${toFetch.length} (404s ${skipped404}, errors ${errors})`);
    }
  }
}

// ~14 concurrent workers; the token bucket is the real throttle, workers just overlap the network RTT.
const concurrency = 16;
await Promise.all(Array.from({ length: concurrency }, worker));

console.log(`done: ${done} fetched (${skipped404} 404s, ${errors} errors)`);
if (errors > 0) process.exitCode = 1;