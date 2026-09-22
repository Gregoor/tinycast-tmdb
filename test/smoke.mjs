// Smoke test for the import→load→search pipeline on a small fixture. Not a benchmark; proves the
// binary format round-trips and that candidate retrieval + reranking agree on obvious titles.
//
//   node test/smoke.mjs

import { resolve } from "node:path";
import {
  createReadStream, writeFileSync, statSync, mkdirSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";

import { buildIndexMain } from "../Scripts/build-index.mjs";
import { MovieIndex } from "../src/db/loader.mjs";
import { openNodeReader } from "../src/db/loaders.mjs";
import { searchMovies } from "../src/movies/search.mjs";
import { foldTitle } from "../src/movies/normalize.mjs";

let pass = 0;
let fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ""}`); }
}

const fixture = resolve("test/fixtures/small.csv");
const outFile = resolve(`${tmpdir}/movies-smoke.index`);

async function main() {
  // 1. Build
  await buildIndexMain(fixture, outFile);
  const st = statSync(outFile);
  check(`built index ${st.size} bytes`, st.size > 0);

  // 2. Load
  const index = new MovieIndex({ reader: await openNodeReader(outFile) });
  await index.open();
  check(`loaded ${index.rowCount} rows, ${index.termCount} terms`, index.rowCount > 0);

  // 3. Raw candidate retrieval sanity
  const terms = MovieIndex.queryTerms("mulh");
  const cands = index.collectCandidates(terms, 50);
  check(`'mulh' yields candidates`, cands.length > 0);

  // 4. End-to-end search, ranked
  async function top(query, n = 5) {
    const r = await searchMovies(index, query, { limit: n });
    return r.map((x) => x.title);
  }
  const topMatrix = await top("matrix");
  check(`'matrix' → Matrix in top`, topMatrix.includes("The Matrix"), topMatrix.join(" | "));

  const topMulh = await top("mulh");
  check(`'mulh' → Mulholland Drive in top`, topMulh.some((t) => t.includes("Mulholland")), topMulh.join(" | "));

  const topAlien3 = await top("alien 3");
  check(`'alien 3' → an Alien 3 title in top`, topAlien3.some((t) => /^alien 3:?/i.test(t)), topAlien3.join(" | "));

  const topCafe = await top("amelie");
  check(`'amelie' → Amélie (diacritic fold)`, topCafe.some((t) => t.includes("Amélie")), topCafe.join(" | "));

  const topNone = await top("zzzzqqqq");
  check(`'zzzzqqqq' → empty`, topNone.length === 0);

  check(`exact title ranked above fuzzy`, topMatrix[0]?.includes("Matrix"), topMatrix.join(" | "));

  console.log(`\n${pass} passed, ${fail} failed`);
  rmSync(outFile, { force: true });
  process.exit(fail ? 1 : 0);
}

await main();