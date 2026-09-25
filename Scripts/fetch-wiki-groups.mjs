#!/usr/bin/env node
// The cross-language entity map: which article in one wiki is the same subject as one in another.
//
// Keyed by Wikidata item, not by title, because that is the only thing that knows "New York City",
// "Nueva York" and "New York City" are one row. A launcher row can only offer the languages it can
// find, and a provider is handed only what the query matched — so the mapping has to be resolved
// ahead of time and shipped beside the index.
//
// Wikidata is asked in chunks with VALUES: the work, and each response, is bounded by OUR rows rather
// than by Wikidata's size. Asking for the whole join instead is a query that never returns.
//
//   node --max-old-space-size=8192 Scripts/fetch-wiki-groups.mjs --head 3000            # coverage only
//   node --max-old-space-size=8192 Scripts/fetch-wiki-groups.mjs --head 200000 --write   # write the map
//
// Only the head of each band is mapped by default: a launcher's traffic is concentrated there, and the
// tail keeps today's title-based merge rather than costing tens of thousands of requests.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { MovieIndex } from "../src/db/loader.mjs";
import { openRuntimeReader } from "../src/db/runtime-reader.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = { en: "en.wikipedia.org", de: "de.wikipedia.org", es: "es.wikipedia.org" };
const ENDPOINT = "https://query.wikidata.org/sparql";
const UA = "tinycast-tmdb/0.1 (https://github.com/Gregoor/tinycast-tmdb)";

/// Sparse side table: a group is an entity, and a language holds at most one row of it.
///   magic "TCWG0001" | u32 languages | per language: u32 byRowCount, u32 byGroupCount, then
///   (rowIndex, groupId) sorted by rowIndex, then (groupId, rowIndex) sorted by groupId.
const GROUP_MAGIC = "TCWG0001";

function parseArgs(argv) {
  const args = new Map();
  for (let at = 0; at < argv.length; at += 1) {
    const [key, inline] = argv[at].replace(/^--/, "").split("=");
    if (inline !== undefined) args.set(key, inline);
    // `--head 200` and `--head=200` both, so a flag is never mistaken for a value.
    else if (argv[at + 1] !== undefined && !argv[at + 1].startsWith("--")) {
      args.set(key, argv[at + 1]);
      at += 1;
    } else args.set(key, true);
  }
  return {
    head: Number(args.get("head") ?? 0),
    from: String(args.get("from") ?? "en,de,es").split(","),
    chunk: Number(args.get("chunk") ?? 400),
    // Wikidata's endpoint is shared and rate-limited. 250 ms is polite for a sample; a full-band run
    // should raise it rather than lean on the retry.
    delay: Number(args.get("delay") ?? 250),
    write: args.get("write") === true,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// One wiki's band, head-first by views, with every title keyed to its row. A counterpart is looked up
/// by name hundreds of thousands of times and the index's own search walks postings per term, which
/// does not scale to that; a map does, and this is a build-time job with the heap to hold it.
async function openBand(lang, head) {
  const path = resolve(root, "build", `wikipedia-${lang}.index`);
  const index = await new MovieIndex({ reader: openRuntimeReader(path, fs) }).open();
  const indices = [...Array(index.rowCount).keys()];
  const rows = await index.readRows(indices);
  const { titles } = await index.readTitles(rows);
  const titleToRow = new Map();
  for (let at = 0; at < titles.length; at += 1) titleToRow.set(titles[at], at);
  const order = indices
    .map((_, at) => ({ at, views: rows[at].voteCount }))
    .sort((a, b) => b.views - a.views);
  const picked = order.slice(0, head || order.length);
  return {
    lang,
    titleToRow,
    entries: picked.map(({ at }) => ({ index: at, title: titles[at], views: rows[at].voteCount })),
    rowCount: index.rowCount,
  };
}

/// The row this repo ships for a title, or nil. Exact, because both sides name the same article: a
/// redirect spelling is simply not mapped, and the title merge is what covers those.
function rowFor(band, title) {
  if (!title) return null;
  const at = band.titleToRow.get(title);
  return at == null ? null : { index: at, title };
}

/// Ask Wikidata for a chunk of articles: their item, and that item's article in every wiki we ship.
async function queryItems(urls, attempt = 0) {
  const values = urls.map((url) => `<${url}>`).join(" ");
  const sparql = `SELECT ?page ?item ?${Object.keys(SITE).join(" ?")} WHERE {
  VALUES ?page { ${values} }
  ?page schema:about ?item .
  ${Object.entries(SITE)
    .map(
      ([lang, host]) =>
        `OPTIONAL { ?${lang} schema:about ?item ; schema:isPartOf <https://${host}/> . }`,
    )
    .join("\n  ")}
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
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    return body.results.bindings;
  } catch (error) {
    if (attempt >= 4) throw error;
    await sleep(1000 * 2 ** attempt);
    return queryItems(urls, attempt + 1);
  }
}

const pageURL = (lang, title) =>
  `https://${SITE[lang]}/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`;
const pageTitle = (url) => decodeURIComponent(url.slice(url.lastIndexOf("/") + 1)).replaceAll("_", " ");

function writeGroups(outDir, bands, groups) {
  for (const band of bands) {
    const byRow = [];
    for (const [groupId, members] of groups) {
      const member = members.get(band.lang);
      if (member) byRow.push({ rowIndex: member.index, groupId });
    }
    byRow.sort((a, b) => a.rowIndex - b.rowIndex);
    const byGroup = byRow.map(({ rowIndex, groupId }) => ({ groupId, rowIndex })).sort((a, b) => a.groupId - b.groupId);

    // Header: "TCWG0001" | u32 languages | u32 byRowCount | u32 byGroupCount — the shape `openGroups`
    // reads, so the writer and the reader cannot drift.
    const bytes = Buffer.alloc(20 + byRow.length * 8 + byGroup.length * 8);
    bytes.write(GROUP_MAGIC, 0, "utf8");
    bytes.writeUInt32LE(bands.length, 8);
    bytes.writeUInt32LE(byRow.length, 12);
    bytes.writeUInt32LE(byGroup.length, 16);
    let at = 20;
    for (const { rowIndex, groupId } of byRow) {
      bytes.writeUInt32LE(rowIndex, at);
      bytes.writeUInt32LE(groupId, at + 4);
      at += 8;
    }
    for (const { groupId, rowIndex } of byGroup) {
      bytes.writeUInt32LE(groupId, at);
      bytes.writeUInt32LE(rowIndex, at + 4);
      at += 8;
    }
    const path = resolve(outDir, `wikipedia-${band.lang}.groups`);
    writeFileSync(path, bytes);
    console.log(`wrote ${path} — ${byRow.length} grouped rows, ${bytes.length} bytes`);
  }
}

async function main() {
  const { head, from, chunk, delay, write } = parseArgs(process.argv.slice(2));
  if (!head) {
    console.error("--head <rows per language> is required (use the row count for everything)");
    process.exit(1);
  }

  // Every language's band is opened: the sources are the languages asked about, but a match is made
  // against all of them, because a counterpart can be in a wiki that is not a source.
  const bands = new Map();
  for (const lang of Object.keys(SITE)) {
    bands.set(lang, await openBand(lang, head));
  }
  for (const band of bands.values()) {
    console.log(`${band.lang}: ${band.entries.length} rows considered, ${band.rowCount} in band`);
  }

  const groups = new Map();
  let withItem = 0;
  let considered = 0;
  let sameTitle = 0;
  let differentTitle = 0;
  const examples = [];

  for (const lang of from) {
    const band = bands.get(lang);
    for (let at = 0; at < band.entries.length; at += chunk) {
      const slice = band.entries.slice(at, at + chunk);
      const bindings = await queryItems(slice.map((entry) => pageURL(lang, entry.title)));
      const seen = new Map();
      for (const row of bindings) {
        const item = row.item.value;
        const titles = Object.fromEntries(Object.keys(SITE).map((l) => [l, row[l]?.value ?? null]));
        seen.set(pageTitle(row.page.value), { item, titles });
      }
      for (const entry of slice) {
        considered += 1;
        const hit = seen.get(entry.title);
        if (!hit) continue;
        withItem += 1;
        // Keyed by the item, never by the pass that found it: en, de and es all resolve the same entity,
        // and two ids for one entity would give the same article two rows.
        const members = groups.get(hit.item) ?? new Map();
        for (const [other, url] of Object.entries(hit.titles)) {
          const title = url ? pageTitle(url) : null;
          if (!title) continue;
          const otherBand = bands.get(other);
          if (other === lang && title === entry.title) {
            members.set(other, { index: entry.index, title: entry.title });
            continue;
          }
          const found = rowFor(otherBand, title);
          if (found) members.set(other, found);
        }
        groups.set(hit.item, members);
      }
      process.stdout.write(
        `  ${lang} ${Math.min(at + chunk, band.entries.length)}/${band.entries.length} — ${groups.size} entities\r`,
      );
      await sleep(delay);
    }
  }

  // Entities this repo holds in two wikis or more, numbered once each.
  const grouped = new Map();
  for (const members of groups.values()) {
    if (members.size >= 2) grouped.set(grouped.size + 1, members);
  }
  for (const members of grouped.values()) {
    const titles = [...members.values()].map((member) => member.title.toLowerCase());
    if (new Set(titles).size === 1) sameTitle += 1;
    else {
      differentTitle += 1;
      if (examples.length < 8) {
        examples.push(
          [...members].map(([language, member]) => `${language}: ${member.title}`).join("  |  "),
        );
      }
    }
  }

  console.log(`\nconsidered ${considered}, resolved to an item ${withItem} (${((withItem / considered) * 100).toFixed(1)}%)`);
  console.log(`entities in two wikis or more: ${grouped.size}`);
  console.log(`  by identical title (today's merge already catches these): ${sameTitle}`);
  console.log(`  by different title (what this adds): ${differentTitle}`);
  const groupedRows = [...grouped.values()].reduce((total, members) => total + members.size, 0);
  console.log(`grouped rows: ${groupedRows}`);
  for (const example of examples) console.log(`  ${example}`);

  if (write) {
    const outDir = resolve(root, "build");
    // `rowFor` sees the whole band; a member's index is therefore already its shipped row index.
    writeGroups(outDir, [...bands.values()], grouped);
    // A manifest records the map's bytes and hash, so a map shipped without its manifest is a client
    // that fails its check. Refreshing both here is what makes one command enough — the order matters,
    // and this is the only place that gets it right by construction.
    for (const band of bands.values()) {
      execFileSync(
        process.execPath,
        [
          resolve(root, "Scripts", "build-local-manifest.mjs"),
          resolve(outDir, `wikipedia-${band.lang}.index`),
          resolve(outDir, `wikipedia-${band.lang}-manifest.json`),
          `--files=${resolve(outDir, `wikipedia-${band.lang}.groups`)}`,
        ],
        { stdio: "inherit" },
      );
    }
  }
}

main();
