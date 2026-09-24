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
  // Wide-prefix cases: a single-letter term spans tens of thousands of index terms, so these are the
  // queries where a badly ordered membership check costs hundreds of milliseconds.
  "where's wanda", "a star is born", "the s", "x files",
];

// Warm the OS page cache + any lazy state.
for (let i = 0; i < 20; i++) await searchMovies(index, queryPool[i % queryPool.length], { limit: 10 });

const N = 1000;
const samples = new Array(N);
let slowest = { ms: 0, query: "" };
for (let i = 0; i < N; i++) {
  const q = queryPool[i % queryPool.length];
  const s = Date.now();
  await searchMovies(index, q, { limit: 10 });
  samples[i] = Date.now() - s;
  if (samples[i] > slowest.ms) slowest = { ms: samples[i], query: q };
}
samples.sort((a, b) => a - b);
const p = (k) => samples[Math.floor(k * samples.length)];
console.log(`warm queries (${N}): p50 ${p(0.5)}ms  p95 ${p(0.95)}ms  p99 ${p(0.99)}ms  max ${samples[samples.length - 1]}ms`);

const okP50 = p(0.5) <= 10;
const okP95 = p(0.95) <= 30;
const okP99 = p(0.99) < 100;

// A hard ceiling that FAILS the run, distinct from the targets above which only print.
//
// It exists because the most expensive bug this suite has met was purely a performance one: a
// membership check ordered widest-first made "where's wanda" take 797 ms while still returning its
// correct single result. No correctness assertion can notice that coming back. The bound is loose
// enough to survive a loaded CI runner and tight enough to catch that class — about 3x headroom.
const CEILING_MS = 250;
const okCeiling = slowest.ms < CEILING_MS;
if (!okCeiling) console.log(`  SLOWEST: '${slowest.query}' took ${slowest.ms}ms (ceiling ${CEILING_MS}ms)`);
else if (slowest.ms > 40) console.log(`  slowest: '${slowest.query}' ${slowest.ms}ms`);
console.log(`targets: p50<10ms ${okP50 ? "OK" : "FAIL"}  p95<30ms ${okP95 ? "OK" : "FAIL"}  p99<100ms ${okP99 ? "OK" : "FAIL"}`);
await reader.close();

if (!okP50 || !okP95 || !okP99 || !okCeiling) {
  console.log(`\nFAILED: p50 ${okP50 ? "ok" : "MISS"} · p95 ${okP95 ? "ok" : "MISS"} · p99 ${okP99 ? "ok" : "MISS"} · ceiling ${okCeiling ? "ok" : "MISS"}`);
  process.exit(1);
}
process.exit(0);
