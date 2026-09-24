// What the published index contains.
//
// The store stays complete — every record ships as the release asset, so nothing is lost and this is
// reversible — but the index is what a client downloads and, more to the point, what it holds resident
// while the palette is open. Indexing the whole corpus costs ~190 MB on disk and ~95 MB of inverted
// index in memory, to answer queries about titles nobody types.
//
// Measured against this corpus, 1.35M of 1.48M records have fewer than ten votes. Rotten Tomatoes has
// no score for ~96% of those, so they cannot show a rating either.
//
// So the index keeps what anyone would search: anything with real votes, plus anything released this
// year or last that at least one person has seen. That one-vote floor is what separates a genuine new
// release from the long tail of zero-vote entries the export adds daily — 114k of those arrived in the
// last two years alone, which is why plain recency was far too broad.
//
// Result: 150,699 rows and 20.7 MB, against 1,480,225 rows and 189.9 MB — 9.2x smaller.

export const MIN_VOTES = 10;
export const RECENT_YEARS = 2;

/// Whether a record belongs in the published index. `year` is injectable so the rule is testable
/// without waiting for the calendar.
export function inBand(record, { year = new Date().getFullYear() } = {}) {
  const votes = record?.voteCount ?? 0;
  if (votes >= MIN_VOTES) return true;
  return (record?.year ?? 0) >= year - (RECENT_YEARS - 1) && votes >= 1;
}

/// Kept/dropped counts, for the builders to report what they left out.
export function bandCounts(records, options) {
  let kept = 0;
  for (const record of records) if (inBand(record, options)) kept++;
  return { kept, dropped: records.length - kept };
}