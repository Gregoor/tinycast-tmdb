// Smoke test for the store → index → search pipeline. Writes a tiny metadata store, builds the
// binary index from it, loads it, and checks that obvious titles rank first — for movies and TV.
//
//   node test/smoke.mjs

import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { buildIndexMain } from "../Scripts/build-index.mjs";
import { MovieIndex } from "../src/db/loader.mjs";
import { openNodeReader } from "../src/db/loaders.mjs";
import { searchMovies } from "../src/movies/search.mjs";

let pass = 0;
let fail = 0;
const check = (label, ok, extra = "") => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

const dir = resolve(tmpdir(), "tmdb-smoke");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

// A handbuilt store: a couple of movies and TV shows with the fields the index consumes.
const records = [
  { mediaType: "movie", id: 603, title: "The Matrix", originalTitle: "The Matrix", year: 1999, voteCount: 24500, popularity: 78, posterPath: "/matrix.jpg", imdbId: "tt0133093" },
  { mediaType: "movie", id: 604, title: "The Matrix Reloaded", originalTitle: "The Matrix Reloaded", year: 2003, voteCount: 10000, popularity: 40, posterPath: "/m2.jpg", imdbId: "tt0234215" },
  { mediaType: "movie", id: 27205, title: "Inception", originalTitle: "Inception", year: 2010, voteCount: 34000, popularity: 83, posterPath: "/inc.jpg", imdbId: "tt1375666" },
  { mediaType: "tv", id: 1399, title: "Game of Thrones", originalTitle: "Game of Thrones", year: 2011, voteCount: 22000, popularity: 120, posterPath: "/got.jpg", imdbId: "" },
  { mediaType: "tv", id: 94605, title: "Arcane", originalTitle: "Arcane", year: 2021, voteCount: 4500, popularity: 90, posterPath: "/arcane.jpg", imdbId: "" },
];
writeFileSync(resolve(dir, "records.ndjson"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");

const outFile = resolve(dir, "smoke.index");
await buildIndexMain(dir, outFile, { verbose: false });

const index = new MovieIndex({ reader: await openNodeReader(outFile) });
await index.open();
check(`loaded ${index.rowCount} rows, ${index.termCount} terms`, index.rowCount === records.length);

const top = async (q, n = 3) => (await searchMovies(index, q, { limit: n })).map((r) => r.title);

check("'matrix' → The Matrix first", (await top("matrix"))[0] === "The Matrix", (await top("matrix")).join(" | "));
check("'inception' → Inception first", (await top("inception"))[0] === "Inception");
check("'game of thrones' → the show", (await top("game of thrones"))[0] === "Game of Thrones");
check("'arcane' → Arcane", (await top("arcane"))[0] === "Arcane");

const tv = await searchMovies(index, "arcane", { limit: 1 });
check("TV results carry mediaType 'tv'", tv[0]?.mediaType === "tv", tv[0]?.mediaType);
const movie = await searchMovies(index, "inception", { limit: 1 });
check("movie results carry mediaType 'movie'", movie[0]?.mediaType === "movie", movie[0]?.mediaType);

check("unknown query → empty", (await searchMovies(index, "zzzqqq", { limit: 3 })).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);