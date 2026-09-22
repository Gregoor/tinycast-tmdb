# tinycast-tmdb

A Tinycast root-search provider for TMDB movies **and TV shows**, with a small extension-owned index
that is rebuilt daily from TMDB's ID exports.

Tinycast's launcher never holds the million-row corpus. This extension keeps its own compact binary
index, searches it locally in JavaScriptCore, and hands Tinycast ~10 candidates per query — the
design the plan calls a "root-search candidate provider".

## How a day's update runs

```
TMDB daily ID export (files.tmdb.org)         every day, ~08:00 UTC
        │
        ▼
Scripts/fetch-exports.mjs                     movies + TV ids → data/id-export.ndjson
        │
        ▼
Scripts/backfill-metadata.mjs                 fetch full metadata for NEW ids only
        │                                       (/movie/{id}, /tv/{id}); resumable, rate-limited
        ▼
data/records.ndjson                           the canonical store (durable, diffable)
        │
        ▼
Scripts/build-index.mjs                       → build/tmdb.index (compact, extension-owned)
Scripts/build-provider.mjs                    → build/provider.bundle.js
        │
        ▼
Scripts/publish.mjs                           rolling `latest` GitHub Release (assets)
```

## Why this shape

- **The index is extension-owned.** ~1.5M rows never enter Tinycast's `AppIndex`; the provider
  searches locally and returns a bounded set of candidates.
- **The store is durable + diffable**, so the multi-hour first backfill and each daily delta both
  restart without re-fetching what is already present (`data/records.ndjson` doubles as the
  checkpoint).
- **The index ships as a Release asset**, not a committed file: ~140 MB is past GitHub's 100 MB
  committed-file limit but well under the 2 GB Release-asset limit. Source + bundle live in the repo.
- **Networked and cacheless**: the poster fetch and the index download use their own ephemeral
  `URLSession`/`fetch`, matching Tinycast's networked-feature rule.

## The index format (`src/db/index-format.mjs`)

One little-endian binary file: a 112-byte header, per-row records (37 B), a sorted term table
(offsets + packed UTF-8 + postings ranges), a flat postings array, and title/original/poster pools.
A row record carries tmdbID, title/original offsets, year, imdb id, popularity, vote count,
poster offset, and a media type (0 movie, 1 TV). The loader keeps only the inverted index in memory
(~30 MB); the pools stay on disk and are paged per query via positional reads.

## Running it

```sh
npm install

# Local secrets (gitignored): a v4 read token or a v3 key.
printf 'TMDB_READ_TOKEN=...\n' > .env

# First seed — hours, resumeable: re-run until `to fetch 0`.
npm run fetch-exports
npm run backfill

# Build + publish
npm run build-index
npm run build-provider

# Or the whole daily cycle:
npm run update
```

`TMDB_API_KEY` (v3) also works in place of `TMDB_READ_TOKEN` (v4 bearer).

## Daily automation

`.github/workflows/daily.yml` runs the cycle every day at 09:00 UTC: restore the store from the
Actions cache, download the export, fetch new ids, rebuild, publish the rolling release, save the
store. It needs one repository secret, `TMDB_READ_TOKEN`. The store is refetchable, so it lives in
the cache rather than in git.

## Verifying

```sh
node test/rank.test.mjs build/tmdb.index   # ranking + no-miss against a real index
node test/perf.mjs build/tmdb.index        # warm p50/p95/p99
```
