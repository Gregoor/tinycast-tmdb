// The Tinycast root-search provider for movies. Bundled to a single self-contained file
// (`provider.bundle.js`) that AppCore loads into a resident JavaScriptCore session. It loads the
// prebuilt movie index from disk and answers root queries through the `@tinycast/api` bridge.
//
// The default export must stay "alive" (return a never-settling promise) so the resident session
// keeps the runtime mounted across keystrokes — see RootSearchProviderHost.

import { registerRootSearchProvider, open } from "@tinycast/api";
import { openRuntimeReader } from "./db/runtime-reader.mjs";
import { MovieIndex } from "./db/loader.mjs";
import { searchMovies } from "./movies/search.mjs";

// The index sits beside this bundle. `__dirname` is provided by Tinycast's CommonJS wrapper, so the
// bundle and its index travel together wherever the extension is installed.
const INDEX_PATH = `${__dirname}/tmdb.index`;

let indexPromise = null;

async function ensureIndex() {
  if (!indexPromise) {
    indexPromise = new MovieIndex({ reader: openRuntimeReader(INDEX_PATH, require("fs")) }).open();
    indexPromise.catch(() => { indexPromise = null; });
  }
  return indexPromise;
}

export default function command() {
  registerRootSearchProvider({
    id: "movies",

    async search(query, { limit }) {
      const index = await ensureIndex();
      const results = await searchMovies(index, query, { limit });
      return results.map((movie) => ({
        // The id carries the media type so activation can route to the right popfeed path.
        id: `${movie.mediaType}:${movie.tmdbID}`,
        title: movie.title,
        subtitle: movie.year != null ? String(movie.year) : undefined,
        keywords: movie.originalTitle ? [movie.originalTitle] : [],
        // Deterministic TMDB poster URL; Swift fetches + caches it by URL for icon stream-in.
        posterURL: movie.posterURL ?? undefined,
        // The row's kind label.
        label: movie.mediaType === "tv" ? "TV Show" : "Movie",
      }));
    },

    async perform(resultId) {
      // Activation: open the popfeed page for this record, routing by the id's media type.
      const [kind, tmdbID] = String(resultId ?? "").split(":");
      if (!tmdbID) return;
      const path = kind === "tv" ? "tv_show" : "movie";
      await open(`https://popfeed.social/${path}/${tmdbID}`, "Safari");
    },
  });

  // Keep the resident session mounted: never settle.
  return new Promise(() => {});
}