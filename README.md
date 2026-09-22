# TMDB movie search index (extension-owned)

A local, queryable movie index over the full TMDB Movies Dataset v11 (~1.5M titles). The index lives
entirely extension-owned, as the plan demands: Tinycast's launcher index never sees these records —
the extension searches its own index and returns ~10 candidates to a future root-search provider.

The important constraint this design satisfies: **the extension runtime is a bare JavaScriptCore
`JSContext` with no SQLite and no native/WASM modules**, so the index is a purpose-built compact
binary artifact (this is plan §12 "outcome B"). It is hand-rolled precisely because the launcher
needs word-prefix/substring/subsequence semantics that FTS5 cannot express anyway; the hand-rolled
part only replaces FTS5's *candidate retrieval*, and the reranker is required either way.

## Layout

```
Scripts/build-index.mjs     Node CLI: TMDB CSV -> movies.index (streams, offline)
src/db/                     storage + I/O (all pure JS, JSContext-safe except loaders.mjs)
  index-format.mjs          binary layout (source of truth) + serialize/parse
  loader.mjs                MovieIndex: two-stage retrieval + rerank wiring
  runtime-reader.mjs        openRuntimeReader — the reader for JavaScriptCore (zero imports)
  loaders.mjs               openNodeReader (Node/tests) + re-export of runtime reader
  base64.mjs, utf8.mjs      portable codecs (no Buffer dependency)
src/movies/
  normalize.mjs             foldText (NFD diacritic fold + lowercase), tokenize
  rank.mjs                  movieScore reranker (title exact > prefix > fuzzy > original > year)
  search.mjs                shared searchMovies entry point
test/
  smoke.mjs                 small-fixture pipeline check
  rank.test.mjs             full-dataset ranking + brute-force no-miss validation
  perf.mjs                  warm p50/p95/p99 vs plan targets
  jsc/                      JavaScriptCore-compatibility probe (real runtime harness)
  gen-fixture.py            regenerates test/fixtures/small.csv from the dataset
```

## Build the index

The CSV is ~660 MB with 1.5M rows; import streams it and takes ~10 s, producing a ~141 MB artifact.

```
node Scripts/build-index.mjs <movies.csv> <movies.index>
```

The importer refuses to write over its own input (or any `.csv`). It indexes `title`,
`original_title` (when different), and the **release year** as a searchable term (so `matrix 1999`
finds The Matrix even though "1999" never appears in the title).

## Binary format (index-format.mjs)

One file: a 96-byte header, then rowMeta (32 B × rows), a term table (offsets + packed UTF-8 +
[start,end) postings ranges), a flat postings array (row indices, ascending per term), and two
title pools. Little-endian via DataView. Row record:

```
u32 tmdbID | u32 titleOffset | u16 titleLength | u32 originalOffset | u16 originalLength |
u16 year (0 unknown) | u32 imdbNum (0 = absent, else tt+\d+ numeric part) | f32 popularity
```

The loader keeps only the inverted index in memory (~30 MB); the pools + rowMeta stay on disk and
are paged via positional reads for the ~25 candidate rows a query needs.

## Query path

1. Normalize query (same `foldText` as import → `café` ≍ `cafe`).
2. Candidate retrieval (in-memory): non-last terms must be exact sets, last term is a prefix.
3. Read candidate row records + title text (positional reads, span-merged).
4. `movieScore` rerank (exact > prefix > fuzzy/subsequence > original-title > year > popularity).
5. Top `limit` (default 10).

## Runtime compatibility

Everything under `src/` except `loaders.mjs` is JavaScriptCore-safe (standard JS only). In the
extension runtime, open the index with `openRuntimeReader(path, require("fs"))`; under Node/tests use
`openNodeReader`. The reader interface is `load(offset, byteLength) -> Uint8Array`.

## Verify

```
node test/smoke.mjs                       # small-fixture pipeline
node test/rank.test.mjs movies.index      # full-dataset ranking + no-miss
node test/perf.mjs movies.index           # p50 <10ms / p95 <30ms / p99 <100ms

# JavaScriptCore (vm-context approximation of JSC + the real generated runtime):
cd test/jsc/npm && npm install esbuild && cd .. && node build.mjs
cd ../../.. && node Scripts/raycast-runtime/test.mjs extensions/tmdb-movies/test/jsc search-probe
```

Measured against the full index (M3, ~1.5M rows): load ~20 ms, warm p50 0–1 ms, p95 1 ms, p99 1 ms,
max 6 ms; the inverted index is ~30 MB resident.