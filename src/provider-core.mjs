// The provider's runtime-independent core: keep the cached index set in step with the release, open
// it, and turn a query into root-search candidates.
//
// The extension runtime supplies the fs shim and a downloader; tests supply node equivalents. Keeping
// this free of `@tinycast/api` is what lets the delivery glue be verified outside the app.

import { syncIndexes } from "./db/index-sync.mjs";
import { openRuntimeReader } from "./db/runtime-reader.mjs";
import { MovieIndex } from "./db/loader.mjs";
import { searchMovies } from "./movies/search.mjs";

/// How long an open index set is trusted before the manifest is checked again. The provider session
/// is resident for the app's lifetime, so without this a launch would never see a later delta — and
/// re-checking per keystroke would hit the network on every query.
const REFRESH_MS = 6 * 60 * 60 * 1000;

/// `manifestURL` + `cacheDir` locate the release and the local cache; `fs` + `download` are the
/// injected runtime facilities. The returned `search` never throws — an unavailable index answers
/// nothing, and a failed refresh falls back to the set already open, so a resident provider session
/// can't be broken by a failed download.
export function createProviderCore({
  manifestURL, cacheDir, fs, download, log = () => {}, now = Date.now, refreshMs = REFRESH_MS,
}) {
  let indexes = null;
  let openPaths = "";
  let syncedAt = 0;
  let opening = null;

  async function ensureIndexes() {
    if (indexes && now() - syncedAt < refreshMs) return indexes;
    if (!opening) {
      opening = (async () => {
        const paths = syncIndexes({ manifestURL, cacheDir, fs, download, log });
        const key = paths.join("|");
        // Unchanged manifest: keep the open set rather than re-reading the whole index.
        if (key === openPaths && indexes) return indexes;
        const list = [];
        for (const path of paths) {
          list.push(await new MovieIndex({ reader: openRuntimeReader(path, fs) }).open());
        }
        openPaths = key;
        return list;
      })();
      opening
        .then((list) => {
          indexes = list;
          syncedAt = now();
        })
        .catch(() => {})
        .finally(() => {
          opening = null;
        });
    }
    return opening;
  }

  async function search(query, limit) {
    let list;
    try {
      list = await ensureIndexes();
    } catch (error) {
      log(`tmdb index unavailable: ${error?.message ?? error}`);
      list = indexes; // serve the last good set rather than nothing
    }
    if (!list) return [];
    const results = await searchMovies(list, query, { limit });
    return results.map(toCandidate);
  }

  return { search, ensureIndexes };
}

function toCandidate(movie) {
  return {
    // The id carries the media type so activation can route to the right popfeed path.
    id: `${movie.mediaType}:${movie.tmdbID}`,
    title: movie.title,
    subtitle: movie.year != null ? String(movie.year) : undefined,
    keywords: movie.originalTitle ? [movie.originalTitle] : [],
    posterURL: movie.posterURL ?? undefined,
    label: movie.mediaType === "tv" ? "TV Show" : "Movie",
  };
}

/// Activation target: the popfeed page for a record, routed by the id's media type.
export function activationURL(resultId) {
  const [kind, tmdbID] = String(resultId ?? "").split(":");
  if (!tmdbID) return null;
  return `https://popfeed.social/${kind === "tv" ? "tv_show" : "movie"}/${tmdbID}`;
}