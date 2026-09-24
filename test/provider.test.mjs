// Provider glue, end to end: sync a served manifest + base + delta into a cache, open them, answer a
// query with merged (delta-superseding) results, and route activation. This exercises the same core
// the bundle wires into the runtime, with node standing in for the fs shim and curl.
//
//   node test/provider.test.mjs

import { mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import * as nodeFs from "node:fs";

import { buildIndexFromRecords } from "../Scripts/build-index.mjs";
import { stableKey } from "../Scripts/store.mjs";
import { createProviderCore, activationURL } from "../src/provider-core.mjs";

let pass = 0;
let fail = 0;
const check = (label, ok, extra = "") => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

const root = resolve(tmpdir(), "tmdb-provider");
rmSync(root, { recursive: true, force: true });
const serveDir = resolve(root, "serve");
const cacheDir = resolve(root, "cache");
mkdirSync(serveDir, { recursive: true });

const rec = (over) => ({
  mediaType: "movie", id: 0, title: "", originalTitle: "", year: 2000,
  popularity: 1, voteCount: 100, posterPath: "", imdbId: "", fetchedAt: 1000, ...over,
});

// Base: The Matrix (movie) + Game of Thrones (TV).
await buildIndexFromRecords([
  rec({ id: 603, title: "The Matrix", originalTitle: "The Matrix", year: 1999, posterPath: "/matrix.jpg" }),
  rec({ id: 1399, mediaType: "tv", title: "Game of Thrones", originalTitle: "Game of Thrones", year: 2011, posterPath: "/got.jpg" }),
  rec({ id: 140, title: "Bad Education", originalTitle: "La mala educación", year: 2004, posterPath: "/bad.jpg" }),
], join(serveDir, "tmdb.index"), { verbose: false });

// Delta: The Matrix was retitled, and the base row must stop matching the old text.
await buildIndexFromRecords([
  rec({ id: 603, title: "The Matrix Resurrections", originalTitle: "The Matrix Resurrections", year: 2021, posterPath: "/matrix2.jpg", fetchedAt: 2000 }),
], join(serveDir, "delta-1.index"), { supersededKeys: [stableKey("movie", 603)], verbose: false });

const sha = (name) => createHash("sha256").update(readFileSync(join(serveDir, name))).digest("hex");
const stat = (name) => nodeFs.statSync(join(serveDir, name)).size;
writeFileSync(join(serveDir, "manifest.json"), JSON.stringify({
  version: 1,
  base: { name: "tmdb.index", bytes: stat("tmdb.index"), sha256: sha("tmdb.index") },
  deltas: [{ name: "delta-1.index", bytes: stat("delta-1.index"), sha256: sha("delta-1.index") }],
}));

const downloads = [];
let failing = false;
const download = (url, path) => {
  if (failing) throw new Error("offline");
  const name = url.slice(url.lastIndexOf("/") + 1);
  downloads.push(name);
  copyFileSync(join(serveDir, name), path);
};
const fs = {
  mkdirSync: nodeFs.mkdirSync, existsSync: nodeFs.existsSync, readFileSync: nodeFs.readFileSync,
  writeFileSync: nodeFs.writeFileSync, readdirSync: nodeFs.readdirSync, rmSync: nodeFs.rmSync,
  openSync: nodeFs.openSync, readSync: nodeFs.readSync, closeSync: nodeFs.closeSync,
};

let clock = 1_000_000;
const core = createProviderCore({
  manifestURL: "https://example.test/movies/manifest.json", cacheDir, fs, download,
  now: () => clock,
});

const results = await core.search("matrix", 5);
check("search finds the record", results[0]?.id === "movie:603", JSON.stringify(results[0]));
check("label is the media kind", results[0]?.label === "Movie", String(results[0]?.label));
check("subtitle carries the year", results[0]?.subtitle === "2021", String(results[0]?.subtitle));
check("poster URL is built from poster_path",
  results[0]?.posterURL === "https://image.tmdb.org/t/p/w92/matrix2.jpg", String(results[0]?.posterURL));
check("a title-only match doesn't repeat the title as a keyword",
  (results[0]?.keywords ?? []).length === 0, JSON.stringify(results[0]?.keywords));

// Found by its original title: the row leads with that title, dims the localized one behind it, and
// keeps the localized title searchable.
const byOriginal = await core.search("mala educación", 3);
check("a query matching the original title leads with it",
  byOriginal[0]?.title === "La mala educación", String(byOriginal[0]?.title));
check("...dims the localized title and year behind it",
  byOriginal[0]?.subtitle === "Bad Education · 2004", String(byOriginal[0]?.subtitle));
check("...and keeps the localized title searchable",
  byOriginal[0]?.keywords?.[0] === "Bad Education", JSON.stringify(byOriginal[0]?.keywords));
const byDisplay = await core.search("bad education", 3);
check("a query matching the display title still leads with it",
  byDisplay[0]?.title === "Bad Education", String(byDisplay[0]?.title));
check("the delta's version wins over the base", results[0]?.title === "The Matrix Resurrections",
  String(results[0]?.title));
check("first search downloaded manifest + base + delta",
  downloads.join(",") === "manifest.json,tmdb.index,delta-1.index", downloads.join(","));

const tv = await core.search("game of thrones", 5);
check("TV records are found and labelled", tv[0]?.id === "tv:1399" && tv[0]?.label === "TV Show",
  JSON.stringify(tv[0]));

downloads.length = 0;
await core.search("matrix", 5);
check("a search inside the refresh window leaves the network alone",
  downloads.length === 0, downloads.join(","));

// Past the window the manifest is re-checked; unchanged, the open set is reused untouched.
clock += 8 * 60 * 60 * 1000;
downloads.length = 0;
const refreshed = await core.search("matrix", 5);
check("past the window only the manifest is refetched",
  downloads.join(",") === "manifest.json", downloads.join(","));
check("an unchanged manifest keeps the same results",
  refreshed[0]?.title === "The Matrix Resurrections", String(refreshed[0]?.title));

// A refresh that fails must keep serving the set already open.
clock += 8 * 60 * 60 * 1000;
failing = true;
const stale = await core.search("matrix", 5);
check("a failed refresh falls back to the open index",
  stale[0]?.id === "movie:603", JSON.stringify(stale[0]));
failing = false;

check("activation routes movies", activationURL("movie:603") === "https://popfeed.social/movie/603",
  String(activationURL("movie:603")));
check("activation routes TV", activationURL("tv:1399") === "https://popfeed.social/tv_show/1399",
  String(activationURL("tv:1399")));
check("activation ignores a malformed id", activationURL("nonsense") === null, String(activationURL("nonsense")));

// A failed download must answer nothing rather than throw (the resident session must survive).
rmSync(cacheDir, { recursive: true, force: true });
const broken = createProviderCore({
  manifestURL: "https://example.test/movies/manifest.json", cacheDir, fs,
  download: () => { throw new Error("offline"); },
});
const offline = await broken.search("matrix", 5);
check("an unavailable index answers nothing", Array.isArray(offline) && offline.length === 0,
  JSON.stringify(offline));

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);