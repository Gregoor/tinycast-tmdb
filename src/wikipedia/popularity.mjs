// How a wiki article's standing moves, and the identity it keeps while it does.
//
// The pageview sample is one day's count, and a day's count moves for almost every article: at the floor
// of the band — one or two views — a single view either way is a 50% change. Shipping that number makes
// every rebuild a full republish, so the store keeps a *decayed* score instead, which is a rate rather
// than a reading, and the index ships a coarse level of it.
//
// Measured on the 2026-09-24 sample, over two synthetic days: rows whose shipped strength changed fell
// from 83–96% to 1.6–5%, and rows crossing the band's cutoff from 38–85% to 3–24%.

/// How fast standing is allowed to move. Past two weeks a longer window stops buying much, and it delays
/// a genuinely rising article — which is the thing daily freshness is for.
export const HALF_LIFE_DAYS = 14;

/// The shipped scale: octaves, because what a row's strength decides is the order of the handful of rows
/// one query returns. Eight levels of resolution do that, and coarse levels change less often.
export function strength(score) {
  return Math.max(0, Math.floor(Math.log2(Math.max(0, score) + 1)));
}

/// A record as the index ships it: a *level* of the standing rather than the standing. The band is chosen
/// on the exact score, and only the level crosses into the shipped bytes — which is what lets a rebuild
/// rewrite a few percent of the index instead of all of it.
export function shipping(records) {
  return records.map((record) => {
    const level = strength(record.popularity);
    return { ...record, popularity: level, voteCount: level };
  });
}

/// The numeric key a record is superseded by. Matches `store.mjs`'s `stableKey`, which the loader's
/// `MovieIndex.stableKey` also has to agree with — asserted in `test/delta.test.mjs`.
export function stableKey(record) {
  return record.id * 2 + (record.mediaType === "tv" ? 1 : 0);
}

/// Today's reading folded into the standing, `days` after the last one. A gap rather than a step, so a
/// rebuild that was skipped — or a CI run that failed — decays by the time it actually missed.
export function decay(previous, today, days = 1, halfLife = HALF_LIFE_DAYS) {
  const reading = Number(today) || 0;
  if (!(previous > 0)) return Math.max(0, reading);
  const weight = 1 - 0.5 ** (Math.max(days, 0) / halfLife);
  return weight * reading + (1 - weight) * previous;
}

/// The identity an article keeps across rebuilds, so a rebuild can say what changed rather than
/// renumbering everything.
///
/// A hash of the language and title, because the pageview dumps carry no id — and the alternatives are
/// worse: a title alone is unique per wiki but moves when an article is renamed, and a `page_id` would
/// cost a multi-gigabyte dump per rebuild.
///
/// **31 bits, not 32**: an index's supersede list is a `Uint32Array` of stable keys, and a key is
/// `id * 2` — so an id at or above 2^31 would wrap silently, and a delta would supersede keys belonging
/// to other rows. Collisions are counted where the store is written, since one would merge two articles
/// into a single row; resolving ids from Wikidata would remove them and is the natural next step.
export function articleID(text) {
  let hash = 2166136261;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) & 0x7fffffff;
}
