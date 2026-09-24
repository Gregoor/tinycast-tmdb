// Index sync correctness: a manifest version bump must download only what actually changed, a
// corrupt local file must refetch, and a base republish must prune the deltas it folded in.
//
//   node test/sync.test.mjs

import { mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import { syncIndexes } from "../src/db/index-sync.mjs";

let pass = 0;
let fail = 0;
const check = (label, ok, extra = "") => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

const root = resolve(tmpdir(), "tmdb-sync");
rmSync(root, { recursive: true, force: true });
const serveDir = resolve(root, "serve");
const cacheDir = resolve(root, "cache");
mkdirSync(serveDir, { recursive: true });

const sha = (name) => createHash("sha256").update(readFileSync(join(serveDir, name))).digest("hex");
const asset = (name, bytes) => ({ name, bytes, sha256: sha(name) });

// "Publish" a set of assets + a manifest version into the served directory.
function publish(version, { base, deltas }) {
  const manifest = {
    version,
    base: base ? asset("tmdb.index") : null,
    deltas: deltas.map((n) => asset(n)),
  };
  writeFileSync(join(serveDir, "manifest.json"), JSON.stringify(manifest));
}
writeFileSync(join(serveDir, "tmdb.index"), "base-v1 ".repeat(500));
writeFileSync(join(serveDir, "delta-1.index"), "d1 ".repeat(50));
writeFileSync(join(serveDir, "delta-2.index"), "d2 ".repeat(50));
writeFileSync(join(serveDir, "tmdb.index.new"), "base-v2 ".repeat(700));

const downloads = [];
const download = (url, path) => {
  const name = url.slice(url.lastIndexOf("/") + 1);
  downloads.push(name);
  copyFileSync(join(serveDir, name), path);
};
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sync = () => syncIndexes({
  manifestURL: "https://example.test/movies/manifest.json", cacheDir, fs: { ...fsShim }, download, hash,
});

// A tiny stand-in for the runtime fs shim, backed by node.
import * as nodeFs from "node:fs";
const fsShim = {
  mkdirSync: (p, o) => nodeFs.mkdirSync(p, o),
  existsSync: (p) => nodeFs.existsSync(p),
  readFileSync: (p, e) => nodeFs.readFileSync(p, e),
  writeFileSync: (p, d) => nodeFs.writeFileSync(p, d),
  readdirSync: (p) => nodeFs.readdirSync(p),
  rmSync: (p, o) => nodeFs.rmSync(p, o),
};

// 1. First sync: base + one delta.
publish(1, { base: true, deltas: ["delta-1.index"] });
let paths = sync();
check("returns base then deltas in order",
  paths.length === 2 && paths[0].endsWith("tmdb.index") && paths[1].endsWith("delta-1.index"),
  paths.join(" | "));
check("first sync downloads manifest + base + delta",
  downloads.join(",") === "manifest.json,tmdb.index,delta-1.index", downloads.join(","));

// 2. Same manifest again: the manifest alone.
downloads.length = 0;
sync();
check("unchanged manifest re-downloads nothing but the manifest",
  downloads.join(",") === "manifest.json", downloads.join(","));

// 3. A day's delta arrives: only the new delta is fetched, not the base.
downloads.length = 0;
publish(2, { base: true, deltas: ["delta-1.index", "delta-2.index"] });
paths = sync();
check("a new delta pulls only that delta",
  downloads.join(",") === "manifest.json,delta-2.index", downloads.join(","));
check("all three indexes reported",
  paths.length === 3 && paths[2].endsWith("delta-2.index"), paths.join(" | "));

// 4. A corrupt local file is refetched rather than served.
downloads.length = 0;
appendFileSync(join(cacheDir, "delta-1.index"), "garbage");
sync();
check("a corrupted index is refetched",
  downloads.join(",") === "manifest.json,delta-1.index", downloads.join(","));

// 5. A base republish resets the chain and prunes the folded deltas.
downloads.length = 0;
copyFileSync(join(serveDir, "tmdb.index.new"), join(serveDir, "tmdb.index"));
publish(3, { base: true, deltas: [] });
paths = sync();
check("a new base is fetched", downloads.includes("tmdb.index"), downloads.join(","));
check("deltas are not refetched on a base republish",
  !downloads.includes("delta-1.index") && !downloads.includes("delta-2.index"), downloads.join(","));
check("folded deltas are pruned from the cache",
  !nodeFs.existsSync(join(cacheDir, "delta-1.index")) && !nodeFs.existsSync(join(cacheDir, "delta-2.index")),
  nodeFs.readdirSync(cacheDir).join(","));
check("only the base remains", paths.length === 1 && paths[0].endsWith("tmdb.index"), paths.join(" | "));

// Pruning must only remove assets we installed. Anything else in this directory is the user's — a
// config file, a key — and a sweep that deletes those would take their settings with it.
writeFileSync(join(cacheDir, "config.json"), JSON.stringify({ ratings: { movie: "rt" } }));
copyFileSync(join(serveDir, "delta-1.index"), join(serveDir, "delta-2.index"));
publish(4, { base: true, deltas: ["delta-1.index", "delta-2.index"] });
sync();
check("a file we did not install survives a pruning sync",
  nodeFs.existsSync(join(cacheDir, "config.json")), nodeFs.readdirSync(cacheDir).join(","));
check("...and it still holds the user's content",
  JSON.parse(readFileSync(join(cacheDir, "config.json"), "utf8")).ratings.movie === "rt");

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);