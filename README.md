# tinycast-tmdb

A Tinycast **root-search provider** for TMDB movies **and TV shows**, backed by an
extension-owned index that is updated daily.

Tinycast's launcher never holds the million-row corpus. This provider keeps its own compact binary
index, searches it locally in JavaScriptCore, and hands the launcher ~10 candidates per query.

> **Tinycast-only.** This is not a Raycast extension. It depends on Tinycast's root-search provider
> runtime, on the reduced `@tinycast/api` module that runtime hands a provider, and on the process
> shim for its downloads. It must not be listed in the Raycast store or any registry catalog.

## Layout

The index is **not committed** (~140 MB is past GitHub's 100 MB committed-file limit). It ships on a
rolling `latest` GitHub Release:

```
manifest.json            version + each asset's name, bytes and sha256
tmdb.index               the base index
delta-2026-09-23.index   one small index per day (new + changed records)
store.ndjson.gz          the metadata store, so a lost Actions cache needs no re-backfill
provider.bundle.js       the built provider (source lives here in git)
```

The client fetches the tiny `manifest.json` every launch and downloads an index file only when its
recorded hash differs from what is already cached, so a launch costs one small request and a day's
update costs only that day's delta.

## How a day's update runs

```
TMDB daily ID export (files.tmdb.org)         ~08:00 UTC
        │
        ▼
Scripts/fetch-exports.mjs                     movies + TV ids → data/id-export.ndjson
        │
        ▼
Scripts/daily-update.mjs                      1. new ids            → fetch metadata
        │                                     2. original-title edits→ free, from the export
        │                                     3. rolling re-fetch   → N stalest records
        ▼
data/records.ndjson                           the canonical store (append-only, last-wins per key)
        │
        ├──▶ Scripts/build-delta.mjs           → build/delta-<date>.index  (daily)
        └──▶ Scripts/build-index.mjs           → build/tmdb.index          (weekly base rebuild)
        │
        ▼
Scripts/publish.mjs                           rolling `latest` release + manifest
```

Popularity drift is deliberately not an update: the index stores it, but scoring never reads it, so
emitting it would churn the deltas for nothing.

## What the index covers

The **store** is complete — every record ships in `store.ndjson.gz` — but the **index** is what a
client downloads and holds resident, so it carries what anyone would search rather than all 1.48M
records (`Scripts/band.mjs`):

```
anything with >= 10 votes, or released this year or last with >= 1 vote
```

Measured against this corpus: 150,699 rows kept, 1,329,526 left out — and **not one of the dropped
records had a Rotten Tomatoes score**, because RT/Metacritic only review titles that have an audience.
The index falls from 189.9 MB to 20.7 MB, the loader's resident set from ~150 MB to ~60 MB, and query
p99 from 42 ms to 8 ms.

The one-vote floor on recent titles is what separates a genuine new release from the long tail of
zero-vote entries the export adds daily — 114k of those arrived in the last two years alone, so plain
recency would have been far too broad. Dropping a record here is reversible and costs nothing: the
store keeps it, so a later base rebuild can bring it back.

## Ratings

Three sources, stored per row as three bytes in the index (256 = absent):

| source | how | coverage |
|---|---|---|
| IMDb | their bulk `title.ratings.tsv.gz`, 8.7 MB/day, no key, no rate limit | ~100% of records with an IMDb id |
| Rotten Tomatoes | OMDb, one title at a time | ~5% of films, ~0% of series |
| Metacritic | OMDb, same call | ~4% of films, ~0% of series |

OMDb's Metascore is movie-only — it returns `N/A` for series that Metacritic plainly scores — and its
RT/Metacritic data reaches only the prominent few thousand, so **IMDb is the rating actually available
for the corpus**. `Scripts/fetch-ratings.mjs` therefore spends its quota only where RT/Metacritic can
exist, weighted by vote count and floored at 10 votes.

A row shows `rt` for both media types with `imdb` behind it as a fallback; any combination, in any
order, is configurable from a `config.json` in the provider's cache directory. Tinycast hands the bundle
that directory (its `TINYCAST_PROVIDER_CACHE`), scoped per channel and per bundle id so a Dev build never
shares an installed copy's index:

```
~/Library/Caches/<bundle id>/provider-cache/movies/config.json
```

```json
{ "ratings": { "movie": ["rt", "metacritic"], "tv": ["rt"], "fallback": ["imdb"] } }
```

An edit applies on the next palette open.

## Deltas and updates

A day's delta is **an index in the same format** — no binary patch, no LSM. It carries the records
that changed plus the **stable keys it supersedes** (`id * 2 + mediaType`). The client searches the
base and every delta, then:

- drops any base candidate whose key a newer delta supersedes — so an edited *title* stops matching
  even though the delta's new text would not have matched the query;
- dedupes by key, newest delta winning.

A record removed from the export is superseded with no replacement, which is how deletions fall out
of the same mechanism.

## Why this shape

- **The index is extension-owned.** ~1.5M rows never enter Tinycast's `AppIndex`; the provider
  searches locally and returns a bounded candidate set.
- **The store is durable**, so the multi-hour backfill and each daily delta restart without
  re-fetching what is present (`data/records.ndjson` is the checkpoint).
- **The index ships as a Release asset.** Release assets have no expiry (unlike Actions artifacts,
  which default to 90 days), and each is capped at 2 GB.
- **The store is cached in Actions, but also published.** The Actions cache evicts after 7 idle days,
  so a cold cache restores `store.ndjson.gz` from the release instead of re-backfilling for hours.

## The provider's environment

A root-search provider is restricted at the **API** level, not the module level: its `@tinycast/api` is
only `{registerRootSearchProvider, open}`, but the Node builtins are provided to every bundle by
design.

| Available | Not available |
|---|---|
| `fs`, `proc`, `crypto`, `zlib`, `os` (Node builtins) | `environment` (so the cache path is derived from `os.homedir()`) |
| `registerRootSearchProvider`, `open` | the rest of the API surface — storage, clipboard, `fetch` |

So the index is downloaded with **curl through the process shim**, streaming straight to disk. The
fetch path can't do that: the runtime's fetch polyfill is refused by the provider bridge, and a bare
`fetch` only works where JavaScriptCore supplies a native one — which buffers the whole body in
memory, the last thing a 140 MB index needs.

The transport is isolated in one `download(url, path)` function, so swapping it (say, for a future
host-side sync) touches nothing in the sync, format or merge logic.

## The index format (`src/db/index-format.mjs`)

One little-endian binary file (v4): a 128-byte header, per-row records (37 B), a sorted term table
(offsets + packed UTF-8 + postings ranges), a flat postings array, title/original/poster pools, and a
superseded-keys section (empty for a base). A row carries tmdbID, title/original offsets, year, imdb
id, popularity, vote count, poster offset and media type (0 movie, 1 TV). The loader keeps only the
inverted index in memory (~30 MB); the pools stay on disk and are paged per query.

## Running it

```sh
npm install

# Local secrets (gitignored): a v4 read token or a v3 key.
printf 'TMDB_READ_TOKEN=...\n' > .env

# First seed — hours, resumable: re-run until `to fetch 0`.
npm run fetch-exports
npm run backfill

# Build
npm run build-index      # the base
npm run build-delta      # or a delta, given a changed store
npm run build-provider

# The whole daily cycle:
npm run update
```

`TMDB_API_KEY` (v3) also works in place of `TMDB_READ_TOKEN` (v4 bearer).

## Daily automation

`.github/workflows/daily.yml` runs every day at 09:00 UTC and Sundays for a base rebuild: restore the
store (cache, else the release asset), download the export, run the incremental update, build a delta
or the base, publish, and save the store. It needs one repository secret, `TMDB_READ_TOKEN`.

## Verifying

```sh
npm test                                   # smoke, delta/update merge, sync, provider glue
npm run test:rank                          # ranking + no-miss against a real index
node test/perf.mjs build/tmdb.index        # warm p50/p95/p99
```