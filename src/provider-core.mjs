// The provider's runtime-independent core: keep the cached index set in step with the release, open
// it, and turn a query into root-search candidates.
//
// The extension runtime supplies the fs shim and a downloader; tests supply node equivalents. Keeping
// this free of `@tinycast/api` is what lets the delivery glue be verified outside the app.

import { syncIndexes } from "./db/index-sync.mjs";
import { openRuntimeReader } from "./db/runtime-reader.mjs";
import { MovieIndex } from "./db/loader.mjs";
import { searchMovies } from "./movies/search.mjs";
import { foldTitle } from "./movies/normalize.mjs";

/// Which score a row shows, per media type. A provider cannot read Tinycast's preferences, so this
/// comes from a config file in the provider's own cache:
///   { "ratings": { "movie": "rt", "tv": "metacritic" } }
/// Values are "rt", "metacritic", "imdb", or "none".
const DEFAULT_RATINGS = { movie: "rt", tv: "metacritic" };

function readRatingsPreference(fs, cacheDir, log) {
  const path = `${cacheDir}/config.json`;
  try {
    if (!fs.existsSync(path)) return DEFAULT_RATINGS;
    const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
    return { ...DEFAULT_RATINGS, ...(parsed?.ratings ?? {}) };
  } catch (error) {
    log(`config.json unreadable (${error?.message ?? error}) — using the defaults`);
    return DEFAULT_RATINGS;
  }
}

/// A row's subtitle is one uniformly-styled string, so the band rides on the glyph: RT is two-state
/// at its own 60% cutoff, Metacritic three-state at its own 61/40 thresholds.
function ratingText(movie, ratings) {
  const choice = ratings[movie.mediaType] ?? "none";
  const value =
    choice === "rt" ? movie.rtScore
    : choice === "metacritic" ? movie.metacriticScore
    : choice === "imdb" ? movie.imdbRating
    : null;
  if (value == null) return "";
  if (choice === "rt") return `${value >= 60 ? "\u{1F345}" : "\u{1F4A5}"} ${value}%`;
  if (choice === "metacritic") return `${value >= 61 ? "\u{1F7E2}" : value >= 40 ? "\u{1F7E1}" : "\u{1F534}"} ${value}`;
  return `imdb ${(value / 10).toFixed(1)}`;
}

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
  let ratings = null;
  let openPaths = "";
  let syncedAt = 0;
  let opening = null;

  async function ensureIndexes() {
    if (indexes && now() - syncedAt < refreshMs) return indexes;
    if (!opening) {
      opening = (async () => {
        // Read the display config before the sync, so a pruning bug in the sync can never eat it.
        ratings ??= readRatingsPreference(fs, cacheDir, log);
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
    return results.map((movie) => toCandidate(movie, ratings));
  }

  return { search, ensureIndexes };
}

function toCandidate(movie, ratings) {
  const original = movie.originalTitle;
  // A row leads with whichever title the query matched and dims the other behind it, so what matched
  // is visible either way round. Folded-equal titles ("Marter" / "MARTER") are the same title and dim
  // nothing, which keeps English-language results showing the year alone.
  const leads = Boolean(movie.matchedOriginal && original);
  const name = leads ? original : movie.title;
  const alternate = leads ? movie.title : original;
  const differs = Boolean(alternate) && foldTitle(alternate) !== foldTitle(name);
  const parts = [];
  if (differs) parts.push(alternate);
  if (movie.year != null) parts.push(String(movie.year));
  const score = ratingText(movie, ratings);
  if (score) parts.push(score);
  return {
    // The id carries the media type so activation can route to the right popfeed path.
    id: `${movie.mediaType}:${movie.tmdbID}`,
    title: name,
    subtitle: parts.join(" · ") || undefined,
    // Whichever title isn't the row's name stays searchable.
    keywords: differs ? [alternate] : [],
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