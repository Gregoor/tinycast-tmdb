#!/usr/bin/env node
// Build tools: ingest the TMDB CSV into the compact binary index artifact.
//
//   node Scripts/build-index.mjs <movies.csv> [out.index]
//
// Streams the CSV line-by-line (no multi-line quoted fields in this dataset), normalizes each
// title/original-title to folded terms, and writes the shared inverted-index format. Runs under
// Node only (it is a build step); the produced artifact is what runs inside JavaScriptCore.

import { readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { foldText, tokenize } from "../src/movies/normalize.mjs";
import { serializeIndex } from "../src/db/index-format.mjs";
import { utf8Encode } from "../src/db/utf8.mjs";

// ── fast streaming CSV record parser (RFC-4180-ish, single-line records) ────────────────────────
const COMMA = ",";
const QUOTE = '"';
const QUOTE_CHAR = QUOTE;
const CR = 13;
const LF = 10;

/// Parse one CSV line into fields, honouring double-quoted fields and escaped quotes. Accumulates
/// each field as a string (not via fromCharCode) so ASCII text round-trips exactly.
function parseLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  const s = line;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (quoted) {
      if (c === QUOTE) {
        if (i + 1 < n && s[i + 1] === QUOTE) {
          field += '"';
          i += 2;
        } else {
          quoted = false;
          i++;
        }
      } else {
        field += c;
        i++;
      }
    } else if (c === QUOTE && field === "") {
      quoted = true;
      i++;
    } else if (c === COMMA) {
      fields.push(field);
      field = "";
      i++;
    } else {
      field += c;
      i++;
    }
  }
  fields.push(field);
  return fields;
}

// Column indices in the TMDB v11 header (verified against the file; keep in sync if it changes).
const COL = {
  ID: 0,
  TITLE: 1,
  VOTE_COUNT: 3,
  RELEASE_DATE: 5,
  IMDB_ID: 12,
  ORIGINAL_TITLE: 14,
  POPULARITY: 16,
  POSTER_PATH: 17,
};

function yearFromDate(dateStr) {
  const s = String(dateStr ?? "");
  return s.length >= 4 ? Number(s.slice(0, 4)) || 0 : 0;
}

/// Parse `tt1234567` (or the literal "None" that stands in for missing) to its numeric part, or 0.
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

export async function buildIndexMain(csvPath, outPath, { verbose = true } = {}) {
  const resolvedOut = resolve(outPath);
  if (resolve(csvPath) === resolvedOut) {
    throw new Error("refusing to build: output path resolves to the input CSV");
  }
  if (verbose) console.log(`reading ${csvPath}`);

  // State
  const termMap = new Map(); // term -> Array<row> (unsorted, deduped later)
  const titles = []; // row -> title string
  const originals = [];
  const posters = []; // row -> TMDB poster_path ("" when absent)
  const popularityVals = [];
  const voteCountVals = [];
  const yearsVal = [];
  const tmdbVal = [];
  const imdbVal = [];

  // Whole-file read + split on newlines. The importer is a one-time offline Node build step (the
  // artifact it writes is what ships into the JS runtime), so holding the raw bytes briefly is fine.
  const bytes = await readFile(csvPath);
  let lineNo = 0;
  let start = 0;

  const maybeIndex = (raw) => {
    lineNo++;
    if (lineNo === 1) return; // header
    const fields = parseLine(raw);
    const title = fields[COL.TITLE] ?? "";
    if (!title) return;

    const row = titles.length; // row index = position in the parallel arrays (grown in lockstep)
    tmdbVal.push(Number(fields[COL.ID]) || 0);
    yearsVal.push(yearFromDate(fields[COL.RELEASE_DATE]));
    imdbVal.push(imdbNum(fields[COL.IMDB_ID]));
    popularityVals.push(Number(fields[COL.POPULARITY]) || 0);
    voteCountVals.push(Number(fields[COL.VOTE_COUNT]) || 0);
    titles.push(title);
    const original = fields[COL.ORIGINAL_TITLE] ?? "";
    originals.push(original);
    posters.push(fields[COL.POSTER_PATH] ?? "");

    // Index both title and original title into the same term map.
    ingest(foldText(title), row, termMap);
    if (original && original !== title) ingest(foldText(original), row, termMap);
    // Index the release year too (as a plain term) so "matrix 1999" / "inception 2010" retrieve the
    // right movie even though the year never appears in the title text.
    const y = yearsVal[yearsVal.length - 1];
    if (y > 0) {
      ingest(String(y), row, termMap);
    }
  };

  const decoder = new TextDecoder("utf-8", { fatal: false });
  for (let i = 0; i <= bytes.length; i++) {
    if (i === bytes.length || bytes[i] === 0x0a) {
      let end = i;
      if (end > start && bytes[end - 1] === 0x0d) end--; // strip trailing \r
      if (end > start) maybeIndex(decoder.decode(bytes.slice(start, end)));
      start = i + 1;
    }
  }

  const rowCount = titles.length;
  if (verbose) console.log(`parsed ${rowCount} rows, ${termMap.size} distinct terms`);

  // Sort terms lexicographically; assign row postings (dedup, sort asc).
  const sortedTerms = [...termMap.keys()].sort();
  const termOffsets = new Uint32Array(sortedTerms.length);
  const termRanges = new Uint32Array(sortedTerms.length * 2);
  const parts = new Array(sortedTerms.length);
  const postingsList = new Array(termMap.size);

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

  // Flatten postings into one Uint32Array.
  const postingsFlat = new Uint32Array(pi);
  let w = 0;
  for (let t = 0; t < sortedTerms.length; t++) {
    const list = postingsList[t];
    for (let k = 0; k < list.length; k++) postingsFlat[w++] = list[k];
  }

  // Terms blob
  const termsBlob = utf8Encode(parts.join(""));
  parts.length = 0;

  // Title + original pools (packed UTF-8, no separator; offsets+lengths disambiguate). Build the
  // row records as we append chunks so no array of per-title encoded blobs is ever materialised.
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
    };
    titleOff += tenc.length;
    origOff += oenc.length;
    posterOff += penc.length;
  }
  const titlePool = concat8(titleChunks);
  const originalPool = concat8(origChunks);
  const posterPool = concat8(posterChunks);

  const indexBytes = serializeIndex({
    rows: rowRecs,
    termOffsets,
    termsBlob,
    termRanges,
    postings: postingsFlat,
    titlePool,
    originalPool,
    posterPool,
  });

  writeFileSync(resolvedOut, Buffer.from(indexBytes));
  const sizeMB = (indexBytes.length / 1048576).toFixed(1);
  if (verbose) {
    console.log(`wrote ${resolvedOut} (${sizeMB} MB, ${rowCount} rows, ${termMap.size} terms, ${pi} postings)`);
  }
  return { rows: rowCount, terms: termMap.size, postings: pi, bytes: indexBytes.length };
}

// Feed the terms of one folded text into the term map (each term -> row).
function ingest(folded, row, termMap) {
  const words = tokenize(folded);
  for (const w of words) {
    let rowsForTerm = termMap.get(w);
    if (!rowsForTerm) {
      rowsForTerm = [];
      termMap.set(w, rowsForTerm);
    }
    rowsForTerm.push(row);
  }
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

// CLI entry: `node build-index.mjs <movies.csv> [out.index]`.
if (import.meta.main) {
  // process.argv is [node, script, ...args], so the first user argument is at index 2.
  const csv = process.argv[2];
  if (!csv) {
    console.error("usage: build-index.mjs <movies.csv> [out.index]");
    process.exit(2);
  }
  const out = process.argv[3] ?? "movies.index";
  // Safety: never let the build overwrite its own input (or any .csv).
  if (resolve(csv) === resolve(out)) {
    console.error("refusing: output path resolves to the input CSV");
    process.exit(3);
  }
  if (/\.csv$/i.test(out) && csv !== out) {
    console.error("refusing: refusing a .csv output path (importer writes the .index artifact)");
    process.exit(3);
  }
  buildIndexMain(csv, out).catch((err) => {
    console.error("build failed:", err);
    process.exit(1);
  });
}