#!/usr/bin/env node
// Builds the compact binary index from the metadata store (data/records.ndjson, produced by
// backfill-metadata.mjs), which holds the fetched movie + TV records.
//
//   node Scripts/build-index.mjs [data-dir] [out.index]
//
// Normalizes each title/original-title to folded terms and writes the shared inverted-index format.
// Runs under Node only (a build step); the artifact it writes is what runs in JavaScriptCore.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

import { foldText, tokenize } from "../src/movies/normalize.mjs";
import { serializeIndex } from "../src/db/index-format.mjs";
import { utf8Encode } from "../src/db/utf8.mjs";

/// Parse `tt1234567` (or the literal "None" the API sometimes returns) to its numeric part, or 0.
function imdbNum(imdb) {
  const s = String(imdb ?? "").trim();
  if (s.length > 2 && s[0] === "t" && s[1] === "t") {
    let num = 0;
    for (let k = 2; k < s.length; k++) {
      const d = s.charCodeAt(k) - 48;
      if (d < 0 || d > 9) return 0;
      num = num * 10 + d;
    }
    return num;
  }
  return 0;
}

const MEDIA_TYPE = { movie: 0, tv: 1 };

export async function buildIndexMain(storeDir, outPath, { verbose = true } = {}) {
  const resolvedOut = resolve(outPath);
  const recordsPath = resolve(storeDir, "records.ndjson");
  if (!existsSync(recordsPath)) {
    throw new Error(`no metadata store at ${recordsPath} — run backfill-metadata.mjs first`);
  }
  if (verbose) console.log(`reading ${recordsPath}`);

  // Parallel per-row arrays + the term map (as before), fed from the store.
  const termMap = new Map();
  const titles = [];
  const originals = [];
  const posters = [];
  const popularityVals = [];
  const voteCountVals = [];
  const yearsVal = [];
  const tmdbVal = [];
  const imdbVal = [];
  const mediaVal = [];

  const ingest = (folded, row) => {
    for (const w of tokenize(folded)) {
      let list = termMap.get(w);
      if (!list) {
        list = [];
        termMap.set(w, list);
      }
      list.push(row);
    }
  };

  const text = readFileSync(recordsPath, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const rec = JSON.parse(line);
    const title = rec.title || rec.originalTitle || "";
    if (!title) continue;

    const row = titles.length;
    tmdbVal.push(Number(rec.id) || 0);
    yearsVal.push(Number(rec.year) || 0);
    imdbVal.push(imdbNum(rec.imdbId));
    popularityVals.push(Number(rec.popularity) || 0);
    voteCountVals.push(Number(rec.voteCount) || 0);
    mediaVal.push(MEDIA_TYPE[rec.mediaType] ?? 0);
    titles.push(title);
    const original = rec.originalTitle || "";
    originals.push(original);
    posters.push(rec.posterPath || "");

    ingest(foldText(title), row);
    if (original && original !== title) ingest(foldText(original), row);
    // The release year is indexed as a plain term so "matrix 1999" / "inception 2010" retrieve the
    // right record even though the year never appears in the title text.
    const year = yearsVal[yearsVal.length - 1];
    if (year > 0) ingest(String(year), row);
  }

  const rowCount = titles.length;
  if (verbose) console.log(`loaded ${rowCount} rows, ${termMap.size} distinct terms`);

  // Sort terms; build term offsets + postings ranges (dedup + sort ascending per term).
  const sortedTerms = [...termMap.keys()].sort();
  const termOffsets = new Uint32Array(sortedTerms.length);
  const termRanges = new Uint32Array(sortedTerms.length * 2);
  const parts = new Array(sortedTerms.length);
  const postingsList = new Array(sortedTerms.length);

  let blobTotal = 0;
  let pi = 0;
  for (let t = 0; t < sortedTerms.length; t++) {
    termOffsets[t] = blobTotal;
    parts[t] = sortedTerms[t];
    blobTotal += sortedTerms[t].length;
    const list = termMap.get(sortedTerms[t]);
    list.sort((a, b) => a - b);
    let unique = 0;
    for (let i = 0; i < list.length; i++) {
      if (unique === 0 || list[i] !== list[unique - 1]) list[unique++] = list[i];
    }
    list.length = unique;
    termRanges[t * 2] = pi;
    termRanges[t * 2 + 1] = pi + unique;
    postingsList[t] = list;
    pi += unique;
  }

  const postingsFlat = new Uint32Array(pi);
  let w = 0;
  for (let t = 0; t < sortedTerms.length; t++) {
    const list = postingsList[t];
    for (let k = 0; k < list.length; k++) postingsFlat[w++] = list[k];
  }

  const termsBlob = utf8Encode(parts.join(""));
  parts.length = 0;

  // Pools (title, original, poster) + row records, built in one pass.
  const rowRecs = new Array(rowCount);
  const titleChunks = [];
  const origChunks = [];
  const posterChunks = [];
  let titleOff = 0;
  let origOff = 0;
  let posterOff = 0;
  for (let r = 0; r < rowCount; r++) {
    const tenc = utf8Encode(titles[r]);
    const oenc = utf8Encode(originals[r]);
    const penc = utf8Encode(posters[r]);
    titleChunks.push(tenc);
    origChunks.push(oenc);
    posterChunks.push(penc);
    rowRecs[r] = {
      tmdbID: tmdbVal[r],
      titleOffset: titleOff,
      titleLength: tenc.length,
      originalOffset: origOff,
      originalLength: oenc.length,
      year: yearsVal[r],
      imdbNum: imdbVal[r],
      popularity: popularityVals[r],
      voteCount: voteCountVals[r],
      posterOffset: posterOff,
      posterLength: penc.length,
      mediaType: mediaVal[r],
    };
    titleOff += tenc.length;
    origOff += oenc.length;
    posterOff += penc.length;
  }

  const indexBytes = serializeIndex({
    rows: rowRecs,
    termOffsets,
    termsBlob,
    termRanges,
    postings: postingsFlat,
    titlePool: concat8(titleChunks),
    originalPool: concat8(origChunks),
    posterPool: concat8(posterChunks),
  });

  mkdirSync(dirname(resolvedOut), { recursive: true });
  writeFileSync(resolvedOut, Buffer.from(indexBytes));
  const sizeMB = (indexBytes.length / 1048576).toFixed(1);
  if (verbose) {
    console.log(
      `wrote ${resolvedOut} (${sizeMB} MB, ${rowCount} rows, ${sortedTerms.length} terms, ${pi} postings)`);
  }
  return { rows: rowCount, terms: sortedTerms.length, postings: pi, bytes: indexBytes.length };
}

/// Concatenate a list of Uint8Array chunks into one Uint8Array.
function concat8(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// CLI entry: `node build-index.mjs [data-dir] [out.index]`.
if (import.meta.main) {
  const storeDir = process.argv[2] ?? "data";
  const out = resolve(process.argv[3] ?? "build/tmdb.index");
  if (resolve(storeDir) === resolve(out)) {
    console.error("refusing: output resolves to the store directory");
    process.exit(3);
  }
  buildIndexMain(storeDir, out).catch((err) => {
    console.error("build failed:", err);
    process.exit(1);
  });
}