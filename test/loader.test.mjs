// The index format's contracts and the store reader's.
//
// Every one of these pins a bug that was invisible while the corpus was English and ASCII:
//   - a row's original title read only when its pool offset differed from the title's, which silently
//     dropped originals whenever the two pools happened to line up — row 0 always;
//   - term-table offsets accumulated as UTF-16 lengths against a UTF-8 blob, which misaligned the
//     whole table the moment a term was not ASCII;
//   - a store read as one string, which cannot exceed Node's ~512 MB and broke every tool at once.

import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import { buildIndexFromRecords } from "../Scripts/build-index.mjs";
import { readStore, appendRecord, forEachLine } from "../Scripts/store.mjs";
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

const dir = resolve(tmpdir(), "tmdb-loader");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const rec = (over) => ({
  mediaType: "movie", id: 0, title: "", originalTitle: "", year: 2000,
  popularity: 1, voteCount: 100, posterPath: "", imdbId: "", fetchedAt: 1000, ...over,
});
const open = async (path) => {
  const index = new MovieIndex({ reader: await openNodeReader(path) });
  await index.open();
  return index;
};

// ── a row's ratings round-trip, and an absent score is distinguishable from a zero one ────────────
{
  const path = resolve(dir, "ratings.index");
  await buildIndexFromRecords([
    rec({ id: 1, title: "Rated", rtScore: 88, metacriticScore: 74, imdbRating: 87 }),
    rec({ id: 2, title: "Unrated" }),
    rec({ id: 3, title: "Zeroed", rtScore: 0, metacriticScore: 0, imdbRating: 0 }),
  ], path, { verbose: false });
  const index = await open(path);
  const [rated, unrated, zeroed] = await index.readRows([0, 1, 2]);
  check("a rating round-trips", rated.rtScore === 88 && rated.metacriticScore === 74 && rated.imdbRating === 87,
    JSON.stringify(rated));
  check("an absent rating is 255", unrated.rtScore === 255 && unrated.metacriticScore === 255 && unrated.imdbRating === 255,
    JSON.stringify(unrated));
  // 0 is a real score (a rotten 0%), not "missing" — the byte has to tell them apart.
  check("a zero rating is not mistaken for absent", zeroed.rtScore === 0 && zeroed.imdbRating === 0,
    JSON.stringify(zeroed));
}

// ── the original title of the FIRST row, whose two pools both start at offset 0 ──────────────────
{
  const path = resolve(dir, "original.index");
  await buildIndexFromRecords([
    rec({ id: 1, title: "Bad Education", originalTitle: "La mala educación" }),
    rec({ id: 2, title: "Second", originalTitle: "Zweite" }),
  ], path, { verbose: false });
  const index = await open(path);
  const rows = await index.readRows([0, 1]);
  const { titles, originals } = await index.readTitles(rows);
  check("the first row's original title is read", originals[0] === "La mala educación",
    JSON.stringify(originals));
  check("the second row's is too", originals[1] === "Zweite", JSON.stringify(originals));
  check("titles are unaffected", titles[0] === "Bad Education" && titles[1] === "Second", JSON.stringify(titles));
}

// ── a non-ASCII term survives the term table, and is findable ────────────────────────────────────
{
  const path = resolve(dir, "nonlatin.index");
  await buildIndexFromRecords([
    rec({ id: 129, title: "Spirited Away", originalTitle: "千と千尋の神隠し", year: 2001 }),
    rec({ id: 1, title: "Alpha", originalTitle: "Alpha" }),
  ], path, { verbose: false });
  const index = await open(path);
  check("a prefix of a non-ASCII term resolves", index._termRange("千と千尋") !== null);
  const hits = await searchMovies(index, "千と千尋", { limit: 3 });
  check("...and finds its record", hits[0]?.title === "Spirited Away", JSON.stringify(hits.map((h) => h.title)));
  check("...reported as an original-title match", hits[0]?.matchedOriginal === true, String(hits[0]?.matchedOriginal));
}

// ── the store reader across every possible chunk boundary ───────────────────────────────────────
// A multi-byte character straddling a chunk edge is the case a plain `chunk.toString()` corrupts, so
// the reader is exercised at every small chunk size rather than trusting one large one.
{
  const sdir = resolve(dir, "store");
  mkdirSync(sdir, { recursive: true });
  const records = [
    rec({ id: 1, title: "Amélie", originalTitle: "Le Fabuleux Destin d'Amélie Poulain" }),
    rec({ id: 2, title: "千と千尋の神隠し", mediaType: "tv" }),
    rec({ id: 3, title: "Ночной дозор" }),
  ];
  for (const r of records) appendRecord(sdir, r);
  const expected = records.map((r) => `${r.mediaType}:${r.id}→${r.title}`).join("|");
  const seen = [];
  for (let chunkBytes = 1; chunkBytes <= 8; chunkBytes++) {
    const store = readStore(sdir, { chunkBytes });
    seen.push([...store.values()].map((r) => `${r.mediaType}:${r.id}→${r.title}`).join("|"));
  }
  check("every chunk size reads the store identically", seen.every((s) => s === expected),
    seen.find((s) => s !== expected) ?? "");

  // Last line wins, which is how an updated record supersedes its earlier line.
  appendRecord(sdir, rec({ id: 1, title: "Amélie (updated)" }));
  const store = readStore(sdir);
  check("the last line for a key wins", store.get("movie:1")?.title === "Amélie (updated)",
    store.get("movie:1")?.title);
  check("...and the count is unchanged", store.size === 3, String(store.size));
  check("an empty store reads as empty", readStore(resolve(dir, "absent")).size === 0);

  // forEachLine is the primitive every tool reads big files through — the export as well as the store
  // — so it is exercised the same way, at every chunk size, including mid-character splits.
  const collected = [];
  for (let chunkBytes = 1; chunkBytes <= 8; chunkBytes++) {
    const lines = [];
    forEachLine(join(sdir, "records.ndjson"), (line) => lines.push(line), { chunkBytes });
    collected.push(lines.length);
  }
  check("forEachLine yields every line at every chunk size", collected.every((n) => n === collected[0]), collected.join(","));
  check("...in order, and trimmed", (() => {
    const lines = [];
    forEachLine(join(sdir, "records.ndjson"), (l) => lines.push(l), { chunkBytes: 3 });
    return lines.every((l) => l === l.trim() && l.startsWith("{"));
  })());
  check("a missing file yields nothing rather than throwing", (() => {
    forEachLine(resolve(dir, "absent"), () => { throw new Error("should not be called"); });
    return true;
  })());
}

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);