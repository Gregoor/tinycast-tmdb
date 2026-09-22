// The canonical metadata store: one NDJSON line per movie/TV record, durable + diffable, so the
// multi-hour backfill and the daily delta both restart without re-fetching what is already present.
//
//   store.read(dir)             -> Map<"movie:id"|"tv:id", record>
//   store.append(dir, record)   -> grow the file by one line (crash-safe, resumes anywhere)
//
// A record:
//   { mediaType, id, title, originalTitle, year, popularity, voteCount, posterPath,
//     imdbId, firstSeen, fetchedAt }

import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const NAME = "records.ndjson";

export function key(mediaType, id) {
  return `${mediaType}:${id}`;
}

export function storePath(dir) {
  return join(dir, NAME);
}

/// Load every record into a Map keyed by `mediaType:id`. ~1.5M+1M records fit comfortably in a
/// Node Map; this runs offline as a tool, not in the JSContext runtime.
export function readStore(dir) {
  const path = storePath(dir);
  const map = new Map();
  if (!existsSync(path)) return map;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const rec = JSON.parse(line);
    map.set(key(rec.mediaType, rec.id), rec);
  }
  return map;
}

/// Append one record; also returns the record for callers that want it. Never rewrites the file, so
/// a kill mid-backfill keeps everything written so far.
export function appendRecord(dir, record) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(storePath(dir), JSON.stringify(record) + "\n", "utf8");
  return record;
}

/// Build the full record from a TMDB API response (movie or tv payload).
export function recordFromApi(mediaType, api) {
  const year =
    String(mediaType === "movie" ? api.release_date : api.first_air_date ?? "")
      .slice(0, 4) || 0;
  return {
    mediaType,
    id: api.id,
    title: api.title ?? api.name ?? "",
    originalTitle: api.original_title ?? api.original_name ?? "",
    year: Number(year) || 0,
    popularity: Number(api.popularity) || 0,
    voteCount: Number(api.vote_count) || 0,
    posterPath: api.poster_path ?? "",
    imdbId: api.imdb_id ?? "",
    firstSeen: Date.now(),
    fetchedAt: Date.now(),
  };
}