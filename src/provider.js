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

// The index artifact path; AppCore builds it there (node Scripts/build-index.mjs) before launch.
const INDEX_PATH = "/tmp/movies-full.index";

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
        id: `tmdb:${movie.tmdbID}`,
        title: movie.title,
        subtitle: movie.year != null ? String(movie.year) : undefined,
        keywords: movie.originalTitle ? [movie.originalTitle] : [],
        // Deterministic TMDB poster URL; Swift fetches + caches it by URL for icon stream-in.
        posterURL: movie.posterURL ?? undefined,
        // The row's kind label.
        label: "Movie",
      }));
    },

    async perform(resultId) {
      // Activation: open the popfeed movie page for this record. This dump is the TMDB movie
      // dataset, so every id is a movie; a future shows dump would route `tv_show/:id` instead.
      const tmdbID = String(resultId ?? "").replace(/^tmdb:/, "");
      if (!tmdbID) return;
      await open(`https://popfeed.social/movie/${tmdbID}`, "Safari");
    },
  });

  // Keep the resident session mounted: never settle.
  return new Promise(() => {});
}