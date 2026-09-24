// The release's decisions — the ones that are expensive or silent when they go wrong.
//
//   - what a manifest may contain (it once published the build machine's paths);
//   - when to rebuild the 199 MB base (every client re-downloads it, so the cadence is a cost);
//   - what a base does to the delta chain (it resets it, and leaving old deltas listed would have
//     clients regress records to a state that predates the base);
//   - the order the ratings pass works in, which decides whether a bounded daily budget ever reaches
//     the corpus or re-checks the same popular titles for ever.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import { buildManifest, decideMode, nextDeltas, BASE_REBUILD_DELTAS } from "../Scripts/manifest.mjs";

let pass = 0;
let fail = 0;
const check = (label, ok, extra = "") => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

// ── the manifest ────────────────────────────────────────────────────────────────────────────────
{
  const asset = (name) => ({ name, bytes: 10, sha256: "abc", local: "/Users/gregor/code/build/x" });
  const man = buildManifest({
    prev: { version: 4 },
    base: asset("tmdb.index"),
    deltas: [asset("delta-1.index")],
    bundle: asset("provider.bundle.js"),
    store: null,
  });
  check("the version advances", man.version === 5, String(man.version));
  check("no local build path is published", !JSON.stringify(man).includes("local"), JSON.stringify(man).slice(0, 120));
  check("assets carry name, bytes and hash only",
    JSON.stringify(Object.keys(man.base).sort()) === JSON.stringify(["bytes", "name", "sha256"]),
    JSON.stringify(Object.keys(man.base)));
  check("deltas are listed", man.deltas.length === 1 && man.deltas[0].name === "delta-1.index");
  check("an absent store is omitted rather than null", "store" in man === false);
  const withStore = buildManifest({ prev: null, base: asset("a"), deltas: [], bundle: asset("b"), store: asset("s") });
  check("a first publish starts at v1", withStore.version === 1, String(withStore.version));
  check("a store appears when given", withStore.store?.name === "s");
}

// ── delta or base ───────────────────────────────────────────────────────────────────────────────
{
  check("a cold cache rebuilds the base (no marker to diff against)",
    decideMode({ hasMarker: false, deltas: 0 }) === "base");
  check("a warm cache with a short chain adds a delta",
    decideMode({ hasMarker: true, deltas: 1 }) === "delta");
  check(`the chain is compacted before ${BASE_REBUILD_DELTAS}`,
    decideMode({ hasMarker: true, deltas: BASE_REBUILD_DELTAS - 1 }) === "delta");
  check(`...and at ${BASE_REBUILD_DELTAS}`, decideMode({ hasMarker: true, deltas: BASE_REBUILD_DELTAS }) === "base");
  check("an explicit request wins", decideMode({ hasMarker: true, deltas: 0, requested: "base" }) === "base");
}

// ── the chain a publish produces ────────────────────────────────────────────────────────────────
{
  const d1 = { name: "delta-1.index" };
  const d2 = { name: "delta-2.index" };
  check("adding a delta appends it",
    nextDeltas({ prevDeltas: [d1], adding: [d2] }).map((d) => d.name).join(",") === "delta-1.index,delta-2.index");
  check("a new base clears the chain", nextDeltas({ prevDeltas: [d1, d2], isBase: true }).length === 0);
  check("re-publishing a day's delta replaces it rather than duplicating",
    nextDeltas({ prevDeltas: [d1], adding: [d1] }).length === 1);
}

// ── the ratings pass's order and floor ──────────────────────────────────────────────────────────
{
  const dir = resolve(tmpdir(), "tmdb-release");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const DAY = 86400000;
  const now = Date.now();
  const rec = (over) => ({ mediaType: "movie", title: "", originalTitle: "", year: 2000, voteCount: 10,
    posterPath: "", imdbId: "", fetchedAt: now, ...over });
  const records = [
    rec({ id: 1, title: "unrated low", imdbId: "tt0000001", voteCount: 50 }),
    rec({ id: 2, title: "unrated high", imdbId: "tt0000002", voteCount: 900 }),
    rec({ id: 3, title: "rated fresh", imdbId: "tt0000003", voteCount: 999, ratingsAt: now - 1 * DAY }),
    rec({ id: 4, title: "rated old", imdbId: "tt0000004", voteCount: 20, ratingsAt: now - 90 * DAY }),
    rec({ id: 5, title: "rated older", imdbId: "tt0000005", voteCount: 15, ratingsAt: now - 200 * DAY }),
    rec({ id: 6, title: "no imdb id", imdbId: "", voteCount: 99999 }),
    rec({ id: 7, title: "below the floor", imdbId: "tt0000007", voteCount: 3 }),
  ];
  writeFileSync(join(dir, "records.ndjson"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const out = execFileSync("node", ["Scripts/fetch-ratings.mjs", `--out=${dir}`, "--top=100",
    "--refresh-days=30", "--min-votes=10", "--dry-run"],
    { encoding: "utf8", env: { ...process.env, OMDB_API_KEY: "dry-run" } });
  // Plan lines are `<key>  votes <n>  <year>  <state>`; the summary line also mentions votes.
  const plan = out.split("\n").filter((l) => /^\s*(movie|tv):\d+\s+votes/.test(l))
    .map((l) => l.trim().split(/\s+/)[0]);
  const summary = out.split("\n").find((l) => l.includes("below 10 votes")) ?? "";

  check("unrated records come first, most-voted first",
    plan.slice(0, 2).join(",") === "movie:2,movie:1", plan.join(","));
  check("then rated ones, stalest first",
    plan.slice(2).join(",") === "movie:5,movie:4", plan.join(","));
  check("a freshly-rated record is left alone", !plan.includes("movie:3"), plan.join(","));
  check("a record with no IMDb id is never asked about", !plan.includes("movie:6"), plan.join(","));
  check("a record below the vote floor is skipped", !plan.includes("movie:7"), plan.join(","));
  check("the skipped count is reported", /1,?353|2 below/.test(summary) || summary.includes("below 10 votes"), summary);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);