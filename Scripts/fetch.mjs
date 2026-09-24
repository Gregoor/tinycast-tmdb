// Shared, rate-limited TMDB API access. A token bucket at `rps` plus retry for 429/5xx, used by both
// the initial backfill (missing ids) and the daily update (new + changed records).
//
// TMDB takes either a v4 read token as a Bearer header or a v3 key as `?api_key=`; set either
// TMDB_READ_TOKEN or TMDB_API_KEY.

import { appendRecord, recordFromApi } from "./store.mjs";

export function hasCredentials() {
  return Boolean(process.env.TMDB_READ_TOKEN || process.env.TMDB_API_KEY);
}

function auth() {
  const readToken = process.env.TMDB_READ_TOKEN;
  const apiKey = process.env.TMDB_API_KEY;
  return readToken
    ? { url: (u) => u, headers: { Authorization: `Bearer ${readToken}` } }
    : { url: (u) => u + (u.includes("?") ? "&" : "?") + "api_key=" + apiKey, headers: {} };
}

/// A client with its own token bucket. `getJson` also records whether a 404 (dropped id) was seen.
export function createClient({ rps = 20, concurrency = 16, retries = 4 } = {}) {
  const AUTH = auth();
  let tokens = rps;
  let lastRefill = Date.now();

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

  async function getJson(url) {
    for (let attempt = 0; ; attempt++) {
      await withTicket();
      const response = await fetch(AUTH.url(url), { headers: AUTH.headers });
      if (response.status === 200) return await response.json();
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        const retryAfter = Number(response.headers.get("retry-after") ?? 1);
        const ms = Math.max(1000, retryAfter * 1000) * (attempt + 1);
        await new Promise((r) => setTimeout(r, ms));
        continue;
      }
      if (response.status === 404) return null; // dropped/deleted id: skip, don't crash the run
      throw new Error(`GET ${url} -> HTTP ${response.status}`);
    }
  }

  return { getJson, concurrency };
}

/// Fetch `{mediaType,id}` items into the store, appending each record as it lands (resumable: a
/// re-run skips what is already written). Returns counters.
export async function fetchInto(items, { outDir, client, label = "fetch", quiet = false } = {}) {
  let cursor = 0;
  let done = 0;
  let skipped404 = 0;
  let errors = 0;

  async function worker() {
    while (true) {
      const item = items[cursor++];
      if (!item) return;
      try {
        const data = await client.getJson(
          `https://api.themoviedb.org/3/${item.mediaType}/${item.id}?language=en-US`);
        if (data === null) {
          skipped404++;
        } else {
          let record = recordFromApi(item.mediaType, data);
          // TMDB's /tv payload omits imdb_id outright — only /external_ids carries it — so a show
          // would otherwise be stored with no IMDb id and could never be looked up on OMDb. One extra
          // call per new show (~150/day) keeps that from recurring.
          if (item.mediaType === "tv") {
            const external = await client.getJson(
              `https://api.themoviedb.org/3/tv/${item.id}/external_ids`);
            if (external?.imdb_id) record = { ...record, imdbId: external.imdb_id };
          }
          appendRecord(outDir, record);
        }
      } catch (error) {
        errors++;
        console.error(`  ${item.mediaType} ${item.id}: ${error.message}`);
      }
      done++;
      if (!quiet && done % 1000 === 0) {
        console.log(`${label}: ${done}/${items.length} (404s ${skipped404}, errors ${errors})`);
      }
    }
  }

  await Promise.all(Array.from({ length: client.concurrency }, worker));
  return { done, skipped404, errors };
}