// Warm-query latency harness against the full index.
//
//   node test/perf.mjs <index.path>
//
// Reports p50/p95/p99/max across a mix of one- and multi-word queries. The plan's targets:
//   p50 < 10 ms, p95 < 30 ms, p99 comfortably < 100 ms, 300 ms is an emergency ceiling.

import { openNodeReader } from "../src/db/loaders.mjs";
import { MovieIndex } from "../src/db/loader.mjs";
import { searchMovies } from "../src/movies/search.mjs";

const indexPath = process.argv[2] ?? new URL("../build/tmdb.index", import.meta.url).pathname;
const reader = await openNodeReader(indexPath);
const index = new MovieIndex({ reader });
const t0 = Date.now();
await index.open();
const mem = process.memoryUsage();
console.log(`load ${Date.now() - t0}ms  rows ${index.rowCount}  terms ${index.termCount}  postings ${index.postings.length}  RSS ${(mem.rss / 1048576).toFixed(0)}MB`);

const queryPool = [
  "alien", "alien 3", "mulholland drive", "matrix", "matrix 1999", "interstellar",
  "dark knight", "inception", "inception 2010", "parasite", "amelie", "casablanca",
  "pulp fiction", "the godfather", "forrest gump", "schindler list", "gone with the wind",
  "et", "blade runner", "the shawshank redemption", "titanic", "avatar", "jurassic park",
];

// Warm the OS page cache + any lazy state.
for (let i = 0; i < 20; i++) await searchMovies(index, queryPool[i % queryPool.length], { limit: 10 });

const N = 1000;
const samples = new Array(N);
for (let i = 0; i < N; i++) {
  const q = queryPool[i % queryPool.length];
  const s = Date.now();
  await searchMovies(index, q, { limit: 10 });
  samples[i] = Date.now() - s;
}
samples.sort((a, b) => a - b);
const p = (k) => samples[Math.floor(k * samples.length)];
console.log(`warm queries (${N}): p50 ${p(0.5)}ms  p95 ${p(0.95)}ms  p99 ${p(0.99)}ms  max ${samples[samples.length - 1]}ms`);

const okP50 = p(0.5) <= 10;
const okP95 = p(0.95) <= 30;
const okP99 = p(0.99) < 100;
console.log(`targets: p50<10ms ${okP50 ? "OK" : "FAIL"}  p95<30ms ${okP95 ? "OK" : "FAIL"}  p99<100ms ${okP99 ? "OK" : "FAIL"}`);
await reader.close();
process.exit(okP50 && okP95 && okP99 ? 0 : 1);