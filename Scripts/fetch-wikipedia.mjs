// Turns the day's pageview sample into per-language store records — the Wikipedia band, applied.
//
//   node Scripts/fetch-wikipedia.mjs [--views=data/wikipedia/views.ndjson]
//                                    [--out=data/wikipedia] [--min-views=1]
//
// One store per language, because the index is per language: an article's language is part of its
// identity, and a client that wants English should not download German to search for it.
//
// Readership stands in for TMDB's vote count, but not as a reading: `popularity` is the *decayed* score
// across days (see `src/wikipedia/popularity.mjs`), so an article's standing is a rate. The previous
// store is therefore the input to this one rather than being replaced by it — a rebuild folds in the day
// it is rebuilding for, and what it cannot say about a row it carries forward.
//
// The record is written in the shape `build-index.mjs` already reads, field for field, because that is
// the index format's input contract rather than a movie's. Three fields are this store's own, and a delta
// reads all three: `changedOn`, the day the shipped level last moved; `prevId`, an id this row had
// before it changed; and `dropped.json` beside it, the ids that left the band since the last build.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appendRecord, readStore, storePath } from "./store.mjs";
import { articleID, decay, strength } from "../src/wikipedia/popularity.mjs";

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

/// The sample this store was last built from, if it says.
function previousDate(dir) {
  try {
    return JSON.parse(readFileSync(`${dir}/sampled.json`, "utf8")).date ?? null;
  } catch {
    return null;
  }
}

/// Resolved Wikidata items by title, where `Scripts/fetch-wiki-keys.mjs` has got to them. An article
/// without one keeps a title hash instead — an id has to fit 31 bits, since a stable key is `id * 2` in a
/// `Uint32Array`, and a hash is only as stable as the title it is made from.
function wikidataKeys(dir) {
  const keys = new Map();
  try {
    for (const line of readFileSync(`${dir}/keys.ndjson`, "utf8").split("\n")) {
      if (!line) continue;
      const { title, qid } = JSON.parse(line);
      if (qid && qid < 2 ** 31) keys.set(title, qid);
    }
  } catch {}
  return keys;
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
  // Everything the last build knew, by title — which is what a sample row arrives as.
  const before = new Map();
  if (existsSync(storePath(dir))) {
    for (const record of readStore(dir).values()) before.set(record.title, record);
  }
  const keys = wikidataKeys(dir);
  const days = daysSince(previousDate(dir));
  rows.sort((a, b) => b.views - a.views);

  // A rebuild replaces the store rather than appending to it.
  rmSync(storePath(dir), { force: true });
  mkdirSync(dir, { recursive: true });

  const seen = new Set();
  const live = new Set();
  const collisions = [];
  let rank = 0;
  for (const row of rows) {
    rank += 1;
    const title = row.title.replaceAll("_", " ");
    const id = keys.get(title) ?? articleID(`${lang}:${title}`);
    // An id collision would merge two articles into one row, so it is counted rather than assumed away.
    if (seen.has(id)) collisions.push(title);
    seen.add(id);
    live.add(title);

    const was = before.get(title);
    const score = decay(was ? Number(was.popularity) || 0 : 0, row.views, days);
    // What a delta keys on: the row changed if its shipped level moved or it is not the same article it
    // was — and when the id moved, the supersede list has to name the old one too.
    const changed = !was || was.id !== id || strength(score) !== strength(Number(was.popularity) || 0);
    appendRecord(dir, {
      // The index format encodes this as one bit, so an article rides in the movie slot. Splitting by
      // language is what makes that acceptable: the language is the index, not a bit inside it.
      mediaType: "movie",
      id,
      ...(changed && was && was.id !== id ? { prevId: was.id } : {}),
      title,
      originalTitle: label(row.lang),
      popularity: score,
      voteCount: 0,
      posterPath: "",
      changedOn: changed ? (meta.date ?? "") : (was?.changedOn ?? ""),
    });
  }

  // The ids that left the band: a delta has to supersede them or a client keeps a row nobody ships.
  const dropped = [...before.values()].filter((record) => !live.has(record.title)).map((record) => record.id);
  writeFileSync(`${dir}/dropped.json`, JSON.stringify(dropped));
  writeFileSync(`${dir}/sampled.json`, JSON.stringify(meta, null, 2) + "\n");
  console.log(
    `  ${lang}: ${rank.toLocaleString()} records, ${dropped.length.toLocaleString()} dropped` +
      (collisions.length ? `, ${collisions.length} id collisions: ${collisions.slice(0, 3).join(", ")}` : ""));
}
