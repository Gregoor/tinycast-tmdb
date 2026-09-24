// The canonical metadata store: one NDJSON line per movie/TV record, durable + diffable, so the
// multi-hour backfill and the daily delta both restart without re-fetching what is already present.
//
//   store.read(dir)             -> Map<"movie:id"|"tv:id", record>
//   store.append(dir, record)   -> grow the file by one line (crash-safe, resumes anywhere)
//
// A record:
//   { mediaType, id, title, originalTitle, year, popularity, voteCount, posterPath,
//     imdbId, firstSeen, fetchedAt }

import { readFileSync, appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";

const NAME = "records.ndjson";

export function key(mediaType, id) {
  return `${mediaType}:${id}`;
}

/// The numeric stable identity a record keeps across updates — `id * 2 + (tv ? 1 : 0)`. Matches
/// `MovieIndex.stableKey`, so a delta's supersede list lines up with the base's rows.
export function stableKey(mediaType, id) {
  return id * 2 + (mediaType === "tv" ? 1 : 0);
}

export function storePath(dir) {
  return join(dir, NAME);
}

/// Load every record into a Map keyed by `mediaType:id`. ~1.5M+1M records fit comfortably in a
/// Node Map; this runs offline as a tool, not in the JSContext runtime.
/// Read the store, last line wins per key.
///
/// Streamed rather than slurped: `readFileSync(path, "utf8")` cannot handle a file past Node's
/// maximum string length (~512 MB), and the store passes that once a bulk enrichment lands — at which
/// point every tool that reads it fails. Chunking also keeps the peak well below what a single
/// half-gigabyte string costs. `StringDecoder` holds partial multi-byte characters across a chunk
/// boundary, which is why it is here rather than `chunk.toString()`.
export function readStore(dir) {
  const path = storePath(dir);
  const map = new Map();
  if (!existsSync(path)) return map;
  const decoder = new StringDecoder("utf8");
  const fd = openSync(path, "r");
  const chunk = Buffer.alloc(1 << 20);
  let carry = "";
  try {
    let position = 0;
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, position);
      if (read <= 0) break;
      position += read;
      const text = carry + decoder.write(chunk.subarray(0, read));
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const rec = JSON.parse(line);
        map.set(key(rec.mediaType, rec.id), rec);
      }
    }
    const tail = (carry + decoder.end()).trim();
    if (tail) {
      const rec = JSON.parse(tail);
      map.set(key(rec.mediaType, rec.id), rec);
    }
  } finally {
    closeSync(fd);
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