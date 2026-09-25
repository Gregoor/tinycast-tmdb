// Samples Wikimedia's hourly pageview dumps into a view-ranked title list — the raw material for a
// Wikipedia band, since an article's readership is the nearest thing it has to a vote count.
//
//   node Scripts/fetch-wikipedia-views.mjs [--date=2026-09-24] [--hours=0,1,…,23]
//                                          [--langs=en,de,es] [--min-views=1] [--keep=1000000]
//                                          [--out=data/wikipedia/views.ndjson]
//
// Each hourly file is ~50 MB gzipped and covers every wiki, so one pass collects every language. Hours
// are streamed and never written to disk.
//
// A full day of English pageviews has more distinct articles than V8 will hold in one Map (2^24), so
// the accumulator is bounded: one map per language, pruned back to `--keep` times four whenever a
// language exceeds it, and to `--keep` at the end. The prune is lossy in principle — a title could
// climb past the cut between prunes — but the cut is four times the final size, so a title would have
// to quadruple its count relative to everything else to be lost.

import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

const argument = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const date = argument("date", "2026-09-24");
const hours = argument("hours", Array.from({ length: 24 }, (_, h) => h).join(",")).split(",");
const langs = argument("langs", "en,de,es").split(",");
const minViews = Number(argument("min-views", 1));
const keep = Number(argument("keep", 1_000_000));
const out = argument("out", "data/wikipedia/views.ndjson");
const [year, month] = [date.slice(0, 4), date.slice(0, 7)];

/// Every domain code a language publishes under: `en`, plus `en.m` for mobile.
const languageOf = (code) => {
  const lang = code.split(".")[0];
  return langs.includes(lang) ? lang : null;
};

/// Namespace 0 is the articles. Everything else — Talk, Category, File, User, and each wiki's own
/// names for them — is not something a launcher should return, and the pageview dumps carry no
/// namespace at all, so this has to be fetched per language and matched on the title's prefix.
///
/// A colon alone proves nothing: "Star Trek: The Next Generation" is an article. Nor is a prefix
/// enough on its own — a namespace name may contain a space, which the dumps write as an underscore.
const UA = "tinycast-tmdb/0.1 (https://github.com/Gregoor/tinycast-tmdb)";

async function nonArticlePrefixes(lang) {
  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&meta=siteinfo&siprop=namespaces&format=json`;
  const response = await fetch(url, { headers: { "user-agent": UA } });
  if (!response.ok) throw new Error(`namespaces for ${lang}: HTTP ${response.status}`);
  const data = await response.json();
  const prefixes = new Set();
  for (const [key, ns] of Object.entries(data.query.namespaces)) {
    if (key === "0" || key === "-1") continue;
    for (const name of [ns["*"], ns.canonical]) {
      if (name) prefixes.add(`${name.replaceAll(" ", "_")}:`);
    }
  }
  return prefixes;
}

/// The namespace a title claims, or nil for a main-namespace article. A leading colon is part of the
/// title, not a namespace, so the colon must not be first.
const prefixOf = (title) => {
  const colon = title.indexOf(":");
  return colon > 0 ? title.slice(0, colon + 1) : null;
};

const skip = new Map();
for (const lang of langs) {
  skip.set(lang, await nonArticlePrefixes(lang));
  console.log(`  ${lang}: excluding ${skip.get(lang).size} namespace prefixes`);
}

const totals = new Map(langs.map((lang) => [lang, new Map()]));
const threshold = keep * 4;
let prunes = 0;
let excluded = 0;

/// Keep the most-viewed `keep` for one language, in place. Amortised: it only fires once a language has
/// grown to four times what the band will hold.
function prune(lang) {
  const titles = totals.get(lang);
  if (titles.size < threshold) return;
  const top = [...titles].sort((a, b) => b[1] - a[1]).slice(0, keep);
  totals.set(lang, new Map(top));
  prunes++;
}

for (const hour of hours) {
  const stamp = `${date.replaceAll("-", "")}-${hour.padStart(2, "0")}0000`;
  const url =
    `https://dumps.wikimedia.org/other/pageviews/${year}/${month}/pageviews-${stamp}.gz`;
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`  ${stamp}: HTTP ${response.status} — skipped`);
    continue;
  }
  const reader = createInterface({
    input: Readable.fromWeb(response.body).pipe(createGunzip()),
  });
  let kept = 0;
  // A connection that drops mid-body emits on the stream rather than rejecting the read, and the hours
  // already folded in are only in memory — so a lost hour is short rather than the whole day being lost.
  try {
    for await (const line of reader) {
      if (!line) continue;
      const [code, title, views] = line.split(" ");
      const lang = languageOf(code ?? "");
      if (!lang) continue;
      const hourViews = Number(views);
      if (!Number.isFinite(hourViews) || hourViews < minViews) continue;
      const prefix = prefixOf(title);
      if (prefix && skip.get(lang).has(prefix)) {
        excluded++;
        continue;
      }
      const titles = totals.get(lang);
      titles.set(title, (titles.get(title) ?? 0) + hourViews);
      kept++;
    }
  } catch (error) {
    console.error(`  ${stamp}: ${error?.message ?? error} — that hour is short`);
  }
  for (const lang of langs) prune(lang);
  const held = langs.map((lang) => `${lang} ${totals.get(lang).size.toLocaleString()}`).join(" · ");
  console.log(
    `  ${stamp}: ${kept.toLocaleString()} kept, ${excluded.toLocaleString()} namespace lines dropped  |  ` +
      `holding ${held}  |  prunes ${prunes}`);
}

const rows = [];
for (const lang of langs) {
  const titles = [...totals.get(lang)].sort((a, b) => b[1] - a[1]).slice(0, keep);
  for (const [title, views] of titles) rows.push({ lang, title, views });
}

mkdirSync(out.slice(0, out.lastIndexOf("/")), { recursive: true });
writeFileSync(out, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
// Which day and hours this band came from, beside the rows: it is the content decision, and without
// it a later build cannot say what population it is measuring.
writeFileSync(
  `${out}.meta.json`,
  JSON.stringify(
    {
      date, hours, minViews, keep, langs,
      // Which pages this band may contain, not just how they were ranked.
      pages: "articles only — namespace 0, each wiki's own namespace names excluded",
      sampledAt: new Date().toISOString(),
    },
    null,
    2) +
    "\n");

console.log(`\nwrote ${out}: ${rows.length.toLocaleString()} titles`);
for (const lang of langs) {
  const counts = [1, 2, 5, 20, 100]
    .map((floor) => `${floor}:${rows.filter((r) => r.lang === lang && r.views >= floor).length.toLocaleString()}`)
    .join("  ");
  console.log(`  ${lang}: kept ${totals.get(lang).size.toLocaleString()}  |  by floor  ${counts}`);
}
