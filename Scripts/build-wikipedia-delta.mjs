#!/usr/bin/env node
// Builds one wiki's delta index: the records whose shipped level moved since the marker, plus every
// stable key it supersedes. A delta is an index in the same format, so a client searches base + deltas
// and merges them — no renumbering, no binary patch.
//
//   node Scripts/build-wikipedia-delta.mjs <lang> [--out=build/wikipedia-<lang>-delta-YYYY-MM-DD.index]
//                                                 [--since=YYYY-MM-DD] [--mark]
//
// `--since` defaults to the marker beside the store, which is the date of the sample the published base
// was built from — not the wall clock, because every change this store records is dated by its sample.
// Nothing changed is a valid answer, and the cheapest one.
//
// The delta names the files an index would: `--out` for the artifact, and the manifest the publisher
// builds names it. `--mark` moves the marker forward so the next run starts from here.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildIndexFromRecords } from "./build-index.mjs";
import { readStore } from "./store.mjs";
import { deltaFor } from "../src/wikipedia/delta.mjs";
import { shipping } from "../src/wikipedia/popularity.mjs";

const argument = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const lang = process.argv[2] ?? "en";
const dir = resolve(`data/wikipedia/${lang}`);

/// The JSON a build-time file holds, or a fallback — a missing one is a first run, not an error.
function readJSON(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

const sampled = readJSON(`${dir}/sampled.json`, {});
const out = resolve(argument("out", `build/wikipedia-${lang}-delta-${sampled.date ?? "unknown"}.index`));
const marker = readJSON(`${dir}/published.json`, {});
const since = argument("since", marker.since ?? "");
const mark = process.argv.includes("--mark");

const dropped = readJSON(`${dir}/dropped.json`, []);
const { touched, superseded } = deltaFor([...readStore(dir).values()], dropped, since);

if (touched.length === 0 && superseded.length === 0) {
  console.log(`  ${lang}: nothing changed since ${since || "the beginning"}`);
} else {
  const built = await buildIndexFromRecords(shipping(touched), out, {
    supersededKeys: superseded,
    verbose: false,
  });
  console.log(
    `  ${lang}: ${built.rows.toLocaleString()} records, ${superseded.length.toLocaleString()} superseded` +
      ` → ${(built.bytes / 1048576).toFixed(1)} MiB`);
}

if (mark) {
  writeFileSync(`${dir}/published.json`, JSON.stringify({ since: sampled.date ?? "", delta: out }) + "\n");
  console.log(`  ${lang}: marked published at ${sampled.date ?? "unknown"}`);
}

// A caller piping this needs to know whether there is a file to publish.
process.exit(existsSync(out) ? 0 : 0);
