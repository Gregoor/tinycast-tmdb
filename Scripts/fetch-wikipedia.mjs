// Turns the day's pageview sample into per-language store records — the Wikipedia band, applied.
//
//   node Scripts/fetch-wikipedia.mjs [--views=data/wikipedia/views.ndjson]
//                                    [--out=data/wikipedia] [--min-views=1]
//
// One store per language, because the index is per language: an article's language is part of its
// identity, and a client that wants English should not download German to search for it.
//
// Readership stands in for TMDB's vote count, but not as a reading: `popularity` is the *decayed* score
// across days (see `src/wikipedia/popularity.mjs`), which is what makes an article's standing a rate
// rather than today's number. The previous store is therefore the input to this one rather than being
// replaced by it — a rebuild folds in the day it is rebuilding for.
//
// `id` is a hash of the language and title, so it survives a re-sample. Without that, every rebuild
// renumbers every row and nothing can say what changed.
//
// The record is written in the shape `build-index.mjs` already reads, field for field, because that is
// the index format's input contract rather than a movie's.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appendRecord, readStore, storePath } from "./store.mjs";
import { articleID, decay } from "../src/wikipedia/popularity.mjs";

const argument = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const viewsPath = argument("views", "data/wikipedia/views.ndjson");
const out = argument("out", "data/wikipedia");
const minViews = Number(argument("min-views", 1));

/// What a row prints under the title, and the only place the language is visible. Not an "original
/// title" in TMDB's sense, but the slot the index already carries, indexes and dims.
const label = (lang) => `${lang}.wikipedia.org`;

/// The sample's own provenance, so a build always carries which population it measured.
const meta = JSON.parse(readFileSync(`${viewsPath}.meta.json`, "utf8"));

/// How many days a rebuild is folding in. A skipped rebuild — or a CI run that failed — decays by the
/// time it actually missed rather than by a single step.
function daysSince(previousDate) {
  if (!previousDate || !meta.date) return 1;
  const gap =
    (Date.parse(`${meta.date}T00:00:00Z`) - Date.parse(`${previousDate}T00:00:00Z`)) / 86_400_000;
  return Number.isFinite(gap) && gap > 0 ? gap : 1;
}

/// The date of the sample this store was last built from, if it says.
function previousDate(dir) {
  try {
    return JSON.parse(readFileSync(`${dir}/sampled.json`, "utf8")).date ?? null;
  } catch {
    return null;
  }
}

const sampled = readFileSync(viewsPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((row) => row.views >= minViews);

const byLanguage = new Map();
for (const row of sampled) {
  if (!byLanguage.has(row.lang)) byLanguage.set(row.lang, []);
  byLanguage.get(row.lang).push(row);
}

for (const [lang, rows] of [...byLanguage].sort()) {
  const dir = `${out}/${lang}`;
  // The standing carried over from the last build, by title — which is what a sample row arrives as.
  const standings = new Map();
  if (existsSync(storePath(dir))) {
    for (const record of readStore(dir).values()) standings.set(record.title, Number(record.popularity) || 0);
  }
  const days = daysSince(previousDate(dir));
  rows.sort((a, b) => b.views - a.views);

  // A rebuild replaces the store rather than appending to it.
  rmSync(storePath(dir), { force: true });
  mkdirSync(dir, { recursive: true });

  const seen = new Set();
  let collisions = 0;
  let rank = 0;
  for (const row of rows) {
    rank += 1;
    const title = row.title.replaceAll("_", " ");
    const id = articleID(`${lang}:${title}`);
    // An id collision would merge two articles into one row, so it is counted rather than assumed away.
    if (seen.has(id)) collisions += 1;
    seen.add(id);
    appendRecord(dir, {
      // The index format encodes this as one bit, so an article rides in the movie slot. Splitting by
      // language is what makes that acceptable: the language is the index, not a bit inside it.
      mediaType: "movie",
      id,
      title,
      originalTitle: label(row.lang),
      // The standing, and only this store's business: the index ships a level of it.
      popularity: decay(standings.get(title) ?? 0, row.views, days),
      voteCount: 0,
      posterPath: "",
    });
  }
  writeFileSync(`${dir}/sampled.json`, JSON.stringify(meta, null, 2) + "\n");
  console.log(
    `  ${lang}: ${rank.toLocaleString()} records` + (collisions ? `, ${collisions} id collisions` : ""));
}
