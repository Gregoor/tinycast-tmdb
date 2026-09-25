#!/usr/bin/env node
// Resolves articles to their Wikidata item, so a row's identity is the entity rather than a hash of its
// title.
//
// The pageview dumps carry no id, and neither does a title: a title is unique per wiki but it moves when
// an article is renamed. A `page_id` is stable but costs a multi-gigabyte dump per rebuild. A Wikidata
// item is stable, comes from one batched lookup per thousand articles, and is the same id every wiki
// agrees on — which is also what cross-wiki grouping would key on.
//
//   node --max-old-space-size=8192 Scripts/fetch-wiki-keys.mjs [--lang=en] [--chunk=1000] [--delay=500]
//                                                              [--limit=100000]
//
// Keys are kept per language, so a rerun only asks about titles it has not seen: the first pass over a
// band is thousands of requests, and every run after it is the handful of new articles. `limit` bounds
// one run; nothing is lost by stopping early, since the store falls back to a title hash meanwhile.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { readStore } from "./store.mjs";

const LANGUAGES = ["en", "de", "es"];
const SITE = { en: "en.wikipedia.org", de: "de.wikipedia.org", es: "es.wikipedia.org" };
const ENDPOINT = "https://query.wikidata.org/sparql";
const UA = "tinycast-tmdb/0.1 (https://github.com/Gregoor/tinycast-tmdb)";

const argument = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const only = argument("lang", null);
const chunk = Number(argument("chunk", 1000));
const delay = Number(argument("delay", 500));
const limit = Number(argument("limit", Number.MAX_SAFE_INTEGER));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pageURL = (lang, title) =>
  `https://${SITE[lang]}/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`;
const pageTitle = (url) => decodeURIComponent(url.slice(url.lastIndexOf("/") + 1)).replaceAll("_", " ");

/// One chunk of articles and the item each belongs to. A page with no item is absent from the response,
/// which is how it is recorded as having none.
async function queryItems(urls, attempt = 0) {
  const values = urls.map((url) => `<${url}>`).join(" ");
  const sparql = `SELECT ?page ?item WHERE {
  VALUES ?page { ${values} }
  ?page schema:about ?item .
}`;
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        Accept: "application/sparql-results+json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ query: sparql }).toString(),
      // A shared endpoint under load will hold a socket open rather than answer: without this the whole
      // pass stalls on one chunk, which is how it behaved before.
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()).results.bindings;
  } catch (error) {
    if (attempt >= 4) throw error;
    await sleep(1000 * 2 ** attempt);
    return queryItems(urls, attempt + 1);
  }
}

for (const lang of only ? [only] : LANGUAGES) {
  const dir = `data/wikipedia/${lang}`;
  const keysPath = `${dir}/keys.ndjson`;
  const asked = new Set();
  if (existsSync(keysPath)) {
    for (const line of readFileSync(keysPath, "utf8").split("\n")) {
      if (line) asked.add(JSON.parse(line).title);
    }
  }

  // The store's own order is by standing, so a pass that stops early has resolved the busiest articles.
  const pending = [...readStore(dir).values()]
    .map((record) => record.title)
    .filter((title) => !asked.has(title))
    .slice(0, limit);

  console.log(`  ${lang}: ${asked.size.toLocaleString()} known, ${pending.length.toLocaleString()} to resolve`);
  let resolved = 0;
  let missing = 0;
  for (let at = 0; at < pending.length; at += chunk) {
    const slice = pending.slice(at, at + chunk);
    const found = new Map();
    let bindings;
    try {
      bindings = await queryItems(slice.map((title) => pageURL(lang, title)));
    } catch (error) {
      // The endpoint or the network is gone. Stopping here is free: every key already written is kept,
      // and the next run asks only about the titles this one never reached.
      console.error(`\n  ${lang}: ${error?.message ?? error} — stopping with ${resolved.toLocaleString()} done`);
      break;
    }
    for (const row of bindings) {
      found.set(pageTitle(row.page.value), Number(row.item.value.slice(1)));
    }
    let lines = "";
    for (const title of slice) {
      const qid = found.get(title) ?? null;
      if (qid === null) missing += 1;
      lines += `${JSON.stringify({ title, qid })}\n`;
    }
    appendFileSync(keysPath, lines, "utf8");
    resolved += slice.length;
    process.stdout.write(
      `  ${lang} ${Math.min(at + chunk, pending.length).toLocaleString()}/${pending.length.toLocaleString()}` +
        ` resolved (${missing.toLocaleString()} without an item)\r`);
    await sleep(delay);
  }
  console.log(`\n  ${lang}: ${resolved.toLocaleString()} resolved, ${missing.toLocaleString()} without an item`);
}
