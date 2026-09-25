// Builds one language's Wikipedia index, sized to a budget.
//
//   node Scripts/build-index-wikipedia.mjs [lang] [--budget-mb=100] [--out=build/wikipedia-<lang>.index]
//
// The row cost is not linear in the count — the term dictionary saturates while the postings keep
// growing — so rather than model it this builds and re-scales. Two or three passes of a few seconds
// each land inside the budget, and the size printed is the artifact's, not an estimate of it.
//
// Everything after the record choice is `buildIndexFromRecords` unchanged: same format, same loader,
// same search as the movie index. Banding by readership lives here rather than in `band.mjs`, which
// knows TMDB's fields.

import { statSync } from "node:fs";
import { readStore } from "./store.mjs";
import { buildIndexFromRecords } from "./build-index.mjs";
import { shipping } from "../src/wikipedia/popularity.mjs";

const argument = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const lang = process.argv[2] ?? "en";
const budget = Number(argument("budget-mb", 100)) * 1048576;
const dir = argument("dir", `data/wikipedia/${lang}`);
const out = argument("out", `build/wikipedia-${lang}.index`);

const records = [...readStore(dir).values()].sort((a, b) => b.popularity - a.popularity);
console.log(`  ${lang}: ${records.length.toLocaleString()} records in the store`);

let take = Math.min(records.length, 150_000);
for (let attempt = 1; attempt <= 5; attempt += 1) {
  const started = Date.now();
  await buildIndexFromRecords(shipping(records.slice(0, take)), out, { verbose: false });
  const bytes = statSync(out).size;
  console.log(
    `  ${lang}: ${take.toLocaleString().padStart(9)} rows → ` +
      `${(bytes / 1048576).toFixed(1).padStart(6)} MiB  ` +
      `${((bytes / budget) * 100).toFixed(0).padStart(3)}% of budget  ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (Math.abs(bytes / budget - 1) < 0.03) break;
  // A row-count estimate straight off the measured ratio; the next pass corrects it.
  const scaled = Math.min(records.length, Math.max(1, Math.floor(take / (bytes / budget))));
  if (scaled === take) break;
  take = scaled;
}
