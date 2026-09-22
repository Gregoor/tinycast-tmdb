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

A root-search provider runs sandboxed. In the live runtime it can:

| Available | Not available |
|---|---|
| `fs`, `crypto`, `zlib`, `os`, `proc` (via the node shims) | `environment` (the provider's `@tinycast/api` module is `{registerRootSearchProvider, open}`) |
| `registerRootSearchProvider`, `open` | Any store/registry surface |

Its fetch path is unreliable by design: the runtime's own fetch polyfill is refused by the provider
bridge (*"providers may only open a URL"*), and the only reason a bare `fetch` works today is that
this macOS's JavaScriptCore supplies a native one, so the polyfill never installs. That is a platform
accident, not a contract — and it buffers a body in memory, which a 140 MB index must not do. So the
download goes through **curl** via the process shim, streaming straight to disk. The cache therefore
lives at `~/Library/Caches/tinycast-root-search/movies`, derived from the home directory rather than
`environment.supportPath`.

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