// The shared search entry point used by both the Raycast command and the Tinycast root provider.
// Keeps movie-specific logic out of the storage layer and out of the runtime bridge.

import { movieScore } from "./rank.mjs";
import { normalizeTerms } from "./normalize.mjs";

// Two-stage: inverted-index candidate retrieval (stage 1) then fine reranking (stage 2).
export async function searchMovies(index, query, { limit = 10, candidatePool = 25 } = {}) {
  const queryTerms = normalizeTerms(query);
  if (queryTerms.length === 0) return [];

  const candidates = index.collectCandidates(queryTerms, candidatePool);
  if (candidates.length === 0) return [];

  // Read records for candidates, then decode their titles for scoring. Paged from disk: only the
  // candidate rows touch the pools.
  const records = await index.readRows(candidates);

  const queryFolded = queryTerms.join(" ");
  // Read all candidate titles/originals in ONE batched pass (span-merged preads), then score.
  const { titles, originals } = await index.readTitles(records);
  const scored = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const title = titles[i];
    const originalTitle = originals[i] || "";
    scored.push({
      row: candidates[i],
      rec,
      title,
      originalTitle,
      score: movieScore(
        { title, originalTitle, year: rec.year, popularity: rec.popularity, voteCount: rec.voteCount },
        queryFolded, queryTerms),
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const winners = scored.slice(0, limit);
  // Read posters (paged) for just the winners so the URL is available for icon stream-in.
  const posters = await index.readPosters(winners.map((w) => w.rec));
  return winners.map(({ row, rec, title, originalTitle, score }, idx) => ({
    // Stable identity for frecency + activation: `<tmdbID>`.
    id: String(rec.tmdbID),
    tmdbID: rec.tmdbID,
    imdbID: rec.imdbNum ? `tt${String(rec.imdbNum).padStart(7, "0")}` : null,
    title,
    originalTitle: originalTitle || null,
    year: rec.year || null,
    popularity: rec.popularity,
    voteCount: rec.voteCount,
    // Deterministic TMDB poster URL (w92 thumb), derived from the stored poster_path.
    posterURL: posters[idx] ? `https://image.tmdb.org/t/p/w92${posters[idx]}` : null,
    score,
    row,
  }));
}