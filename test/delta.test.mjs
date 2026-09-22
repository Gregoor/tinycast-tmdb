// Delta + update correctness: a base index plus a delta index must resolve a record's current
// state — an edited title wins, a record removed from the export disappears, and a new record is
// searchable — without renumbering the base.
//
//   node test/delta.test.mjs

import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { buildIndexMain, buildIndexFromRecords } from "../Scripts/build-index.mjs";
import { execFileSync } from "node:child_process";
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

const dir = resolve(tmpdir(), "tmdb-delta");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const rec = (over) => ({
  mediaType: "movie", id: 0, title: "", originalTitle: "", year: 2000,
  popularity: 1, voteCount: 10, posterPath: "", imdbId: "", fetchedAt: 1000, ...over,
});

// Base store: three records, all fetched at t=1000.
const base = [
  rec({ id: 1, title: "Old Title One" }),
  rec({ id: 2, title: "Keep Two" }),
  rec({ id: 3, title: "Gone Three" }),
];
writeFileSync(resolve(dir, "records.ndjson"), base.map((r) => JSON.stringify(r)).join("\n") + "\n");
// The export that the base was built from lists all three.
writeFileSync(
  resolve(dir, "id-export.ndjson"),
  base.map((r) => JSON.stringify({ mediaType: r.mediaType, id: r.id, adult: false })).join("\n") + "\n");

const basePath = resolve(dir, "base.index");
await buildIndexMain(dir, basePath, { verbose: false });

// A "day" later: record 1 is edited, record 4 is new, record 3 is removed from the export.
const delta = [
  rec({ id: 1, title: "New Title One", fetchedAt: 2000 }),
  rec({ id: 4, title: "Brand New Four", fetchedAt: 2000 }),
];
writeFileSync(
  resolve(dir, "records.ndjson"),
  [...base, ...delta].map((r) => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(
  resolve(dir, "id-export.ndjson"),
  [base[0], base[1], delta[1]]
    .map((r) => JSON.stringify({ mediaType: r.mediaType, id: r.id, adult: false }))
    .join("\n") + "\n");

const deltaPath = resolve(dir, "delta.index");
execFileSync("node", ["Scripts/build-delta.mjs", dir, deltaPath, "--since=1500"], { stdio: "ignore" });

const baseIndex = new MovieIndex({ reader: await openNodeReader(basePath) });
await baseIndex.open();
const deltaIndex = new MovieIndex({ reader: await openNodeReader(deltaPath) });
await deltaIndex.open();

check("delta carries the edited + new records", deltaIndex.rowCount === 2, String(deltaIndex.rowCount));
check("delta supersedes 3 keys (1 edited, 3 removed, 4 new)", deltaIndex.supersededKeys.length === 3,
  String(deltaIndex.supersededKeys.length));

const titles = async (q) => (await searchMovies([baseIndex, deltaIndex], q, { limit: 5 })).map((r) => r.title);

check("edited: new title wins", (await titles("new title one"))[0] === "New Title One", (await titles("new title one")).join(" | "));
check("edited: stale base title gone", !(await titles("old title one")).includes("Old Title One"), (await titles("old title one")).join(" | "));
check("new record searchable", (await titles("brand new four"))[0] === "Brand New Four");
check("removed record gone", !(await titles("gone three")).includes("Gone Three"), (await titles("gone three")).join(" | "));
check("untouched record still found", (await titles("keep two"))[0] === "Keep Two");

// A single index still works (array-of-one path).
const alone = await searchMovies(baseIndex, "keep two", { limit: 1 });
check("single-index search still works", alone[0]?.title === "Keep Two");

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);